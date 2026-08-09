"""社内ポータル バックエンド API（Cloud Run）。

フロントエンド（Firebase Hosting）からは Hosting のリライト機能で /api/** が
この Cloud Run サービスへ転送されるため、ブラウザからは同一オリジンに見える。
全エンドポイント（healthz を除く）は Clerk セッション JWT を検証し、確認した
メールアドレスのユーザー代理（domain-wide delegation）で Workspace の Drive を
操作する。これにより GAS 版の「アクセスしているユーザーとして実行」と同じ
権限モデル（雛形にアクセス権のある本人しか読めない）を維持する。
"""

from urllib.parse import quote

from fastapi import Depends, FastAPI, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from . import clerk_auth, config, excel_report, google_drive, settings_store
from .clerk_auth import AuthError, User
from .excel_report import ReportError
from .google_drive import XLSX_MIME, DriveError

TOOL_EXCEL_REPORT = "excel-report-formatter"
_TOOL_PREFIX = f"/api/tools/{TOOL_EXCEL_REPORT}"

app = FastAPI(title="portal-api", docs_url=None, redoc_url=None)

# 本番は Firebase Hosting のリライトで同一オリジンになるため CORS は不要だが、
# ローカル開発（Vite dev サーバーから直接叩く場合）のために許可しておく。
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.cors_allowed_origins(),
    allow_methods=["*"],
    allow_headers=["Authorization", "Content-Type"],
    expose_headers=["Content-Disposition"],
)


def _error_response(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


@app.exception_handler(AuthError)
async def _auth_error_handler(_request: Request, exc: AuthError):
    return _error_response(exc.status, str(exc))


@app.exception_handler(DriveError)
async def _drive_error_handler(_request: Request, exc: DriveError):
    return _error_response(exc.status, str(exc))


@app.exception_handler(ReportError)
async def _report_error_handler(_request: Request, exc: ReportError):
    return _error_response(exc.status, str(exc))


@app.exception_handler(Exception)
async def _unexpected_error_handler(_request: Request, exc: Exception):
    return _error_response(500, str(exc))


def require_user(authorization: str | None = Header(default=None)) -> User:
    return clerk_auth.user_from_authorization_header(authorization)


@app.get("/api/healthz")
async def healthz():
    return {"status": "ok"}


@app.get("/api/me")
async def me(user: User = Depends(require_user)):
    return {"email": user.email}


@app.get(f"{_TOOL_PREFIX}/config")
async def get_form_config(user: User = Depends(require_user)):
    """フォーム定義（計測点・選択肢・バリデーション）を mapping.json から配信する。"""
    return excel_report.form_config()


@app.get(f"{_TOOL_PREFIX}/template")
async def get_template_status(user: User = Depends(require_user)):
    """現在保存されている雛形設定の状態を返す。UI の初期表示で使う。"""
    settings = settings_store.get_tool_settings(
        google_drive.service_session(), TOOL_EXCEL_REPORT
    )
    folder_id = settings.get("template_folder_id", "")
    file_name = settings.get("template_file_name", "")
    return {"configured": bool(folder_id and file_name), "fileName": file_name}


@app.get(f"{_TOOL_PREFIX}/template/candidates")
async def search_template_candidates(q: str = "", user: User = Depends(require_user)):
    """雛形候補（.xlsx）をファイル名で検索する（Google Picker の代替）。

    実行ユーザーの代理で検索するため、本人に閲覧権限のあるファイルだけが返る。
    """
    query = q.strip()
    if not query:
        return {"files": []}
    files = google_drive.search_xlsx_files(
        google_drive.delegated_session(user.email), query
    )
    return {
        "files": [
            {
                "id": f.get("id", ""),
                "name": f.get("name", ""),
                "modifiedTime": f.get("modifiedTime", ""),
            }
            for f in files
        ]
    }


@app.put(f"{_TOOL_PREFIX}/template")
async def save_template_selection(request: Request, user: User = Depends(require_user)):
    """選択された雛形ファイルの親フォルダ ID とファイル名を共有設定に保存する。

    GAS 版 saveTemplateSelection と同じルール: ネイティブ .xlsx のみ許可し、
    親フォルダを特定できないファイル（マイドライブ直下など）は拒否する。
    """
    try:
        body = await request.json()
    except Exception:
        body = None
    file_id = (body or {}).get("fileId") if isinstance(body, dict) else None
    if not file_id or not isinstance(file_id, str):
        raise ReportError("ファイルが選択されていません。")

    meta = google_drive.get_file_metadata(
        google_drive.delegated_session(user.email), file_id
    )
    if meta.get("trashed"):
        raise ReportError("選択したファイルはゴミ箱に入っています。別のファイルを選択してください。")
    # Google スプレッドシート等を選ぶとエクスポート形式が変わってしまい、
    # openpyxl が読み込みに失敗する。ネイティブ .xlsx だけを許可する。
    if meta.get("mimeType") != XLSX_MIME:
        raise ReportError(
            "Google スプレッドシート等の形式はサポートされていません。"
            "Excel 形式 (.xlsx) のファイルを選択してください。"
        )
    parents = meta.get("parents") or []
    if not parents:
        raise ReportError(
            "選択したファイルの親フォルダを特定できませんでした。"
            "マイドライブ直下ではなくフォルダ内に雛形を置いてください。"
        )

    settings_store.set_tool_settings(
        google_drive.service_session(),
        TOOL_EXCEL_REPORT,
        {"template_folder_id": parents[0], "template_file_name": meta.get("name", "")},
    )
    return {"fileName": meta.get("name", ""), "folderId": parents[0]}


@app.post(f"{_TOOL_PREFIX}/reports")
async def create_report(request: Request, user: User = Depends(require_user)):
    """フォームデータから傾斜測定報告書（xlsx）を生成して返す。

    雛形は共有設定のフォルダ／ファイル名を基に、実行ユーザーの代理で Drive から
    最新版を取得する（本人にアクセス権が無ければここで失敗する）。
    """
    try:
        body = await request.json()
    except Exception:
        body = None
    if not body or not isinstance(body, dict):
        raise ReportError("No data provided")

    settings = settings_store.get_tool_settings(
        google_drive.service_session(), TOOL_EXCEL_REPORT
    )
    folder_id = settings.get("template_folder_id", "")
    file_name = settings.get("template_file_name", "")
    if not folder_id or not file_name:
        raise ReportError(
            "Excel 雛形が未設定です。画面の「雛形を設定」から、"
            "Google Drive 上の雛形ファイルを選択してください。",
            409,
        )

    template_bytes = google_drive.fetch_latest_template(
        google_drive.delegated_session(user.email), folder_id, file_name
    )
    xlsx_bytes = excel_report.generate_report(
        template_bytes, body.get("property_name"), body.get("rooms")
    )

    return Response(
        content=xlsx_bytes,
        media_type=XLSX_MIME,
        headers={
            "Content-Disposition": (
                f"attachment; filename*=UTF-8''{quote(excel_report.REPORT_FILE_NAME)}"
            )
        },
    )
