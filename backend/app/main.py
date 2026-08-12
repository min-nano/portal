"""社内ポータル バックエンド API（Cloud Run）。

フロントエンド（Firebase Hosting）からは Hosting のリライト機能で /api/** が
この Cloud Run サービスへ転送されるため、ブラウザからは同一オリジンに見える。
全エンドポイント（healthz を除く）は Clerk セッション JWT を検証し、確認した
メールアドレスのユーザー代理（domain-wide delegation）で Workspace の Drive を
操作する。これにより GAS 版の「アクセスしているユーザーとして実行」と同じ
権限モデル（雛形にアクセス権のある本人しか読めない）を維持する。
"""

from urllib.parse import quote

from fastapi import Depends, FastAPI, File, Header, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from . import (
    clerk_auth,
    config,
    excel_report,
    google_docs,
    google_drive,
    nail_core,
    panel_shear,
    settings_store,
    structural_cert,
)
from .clerk_auth import AuthError, User
from .excel_report import ReportError
from .google_drive import XLSX_MIME, DriveError
from .panel_shear import PanelShearError
from .settings_store import SettingsError
from .structural_cert import CertificateError

TOOL_EXCEL_REPORT = "excel-report-formatter"
_TOOL_PREFIX = f"/api/tools/{TOOL_EXCEL_REPORT}"

TOOL_STRUCTURAL_CERT = "structural-cert-formatter"
_CERT_PREFIX = f"/api/tools/{TOOL_STRUCTURAL_CERT}"

TOOL_PANEL_SHEAR = "timber-panel-shear-calculator"
_PANEL_PREFIX = f"/api/tools/{TOOL_PANEL_SHEAR}"

# アップロードされた PDF の上限。証明書は 1 ページなので十分に余裕がある。
_MAX_UPLOAD_BYTES = 20 * 1024 * 1024

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


@app.exception_handler(CertificateError)
async def _certificate_error_handler(_request: Request, exc: CertificateError):
    return _error_response(exc.status, str(exc))


@app.exception_handler(PanelShearError)
async def _panel_shear_error_handler(_request: Request, exc: PanelShearError):
    return _error_response(exc.status, str(exc))


@app.exception_handler(SettingsError)
async def _settings_error_handler(_request: Request, exc: SettingsError):
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


@app.get("/api/picker/config")
async def get_picker_config(user: User = Depends(require_user)):
    """公式 Google Picker の初期化に必要な設定を返す（全ツール共通）。

    ページに埋め込まれる公開情報だが、環境（本番 / PR プレビュー / ローカル）
    ごとに違うため、ビルドに焼き込まずここから配る。未設定でもエラーには
    せず configured: false を返し、画面側が「Picker が未設定」と案内する
    （設定漏れの症状を、正体不明の失敗ではなく明示的な案内にする）。
    """
    api_key = config.picker_api_key()
    return {
        "configured": bool(api_key),
        "apiKey": api_key,
        "appId": config.picker_app_id(),
    }


@app.get("/api/picker/token")
async def get_picker_token(response: Response, user: User = Depends(require_user)):
    """Picker が選択画面を描くための、本人の読み取り専用トークンを発行する。

    ブラウザで OAuth の同意を取る方式ではなく、既にある代理アクセス
    （domain-wide delegation）を使う理由は google_drive.delegated_access_token
    のコメントを参照（PR プレビューのように URL が毎回変わる環境でも、
    OAuth クライアントへの登録なしに動かすため）。

    渡すのは本人が Drive で見られる範囲の読み取り権限だけで、書き込みは
    従来どおりサーバー側でしか行わない。
    """
    token, expires_in = google_drive.delegated_access_token(user.email)
    # 短命とはいえ資格情報なので、経路のどこにも残さない。
    response.headers["Cache-Control"] = "no-store"
    return {"token": token, "expiresIn": expires_in}


@app.get(f"{_TOOL_PREFIX}/config")
async def get_form_config(user: User = Depends(require_user)):
    """フォーム定義（計測点・選択肢・バリデーション）を mapping.json から配信する。"""
    return excel_report.form_config()


@app.get(f"{_TOOL_PREFIX}/template")
async def get_template_status(user: User = Depends(require_user)):
    """現在保存されている雛形設定の状態を返す。UI の初期表示で使う。"""
    settings = settings_store.get_tool_settings(TOOL_EXCEL_REPORT)
    folder_id = settings.get("template_folder_id", "")
    file_name = settings.get("template_file_name", "")
    return {"configured": bool(folder_id and file_name), "fileName": file_name}


@app.put(f"{_TOOL_PREFIX}/template")
async def save_template_selection(request: Request, user: User = Depends(require_user)):
    """公式 Google Picker で選ばれた雛形の親フォルダ ID とファイル名を保存する。

    Picker はブラウザ側でファイルを選ぶだけなので、種類の確認はここで行う。
    GAS 版 saveTemplateSelection と同じルール: ネイティブ .xlsx のみ許可し、
    親フォルダを特定できないファイル（マイドライブ直下など）は拒否する。
    メタデータの取得は実行ユーザーの代理で行うため、本人に閲覧権限の無い
    ファイル ID を送っても通らない。
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

    settings = settings_store.get_tool_settings(TOOL_EXCEL_REPORT)
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


# --- 構造計算安全証明書 作成ツール -------------------------------------------
#
# 雛形（Google ドキュメント）と保存先フォルダを Drive から選び、設定を
# Firestore に保存する点は excel-report-formatter と同じ。生成は雛形を
# 複製 → プレースホルダー置換 → PDF 書き出し → 選択肢へ ○ を描き込み →
# Drive へ保存、という流れで、すべて実行ユーザー本人の代理権限で行う。


async def _json_body(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception:
        body = None
    return body if isinstance(body, dict) else {}


# --- PDF を Drive へ保存する（証明書・計算書の共通処理） ----------------------
#
# どちらのツールも、通常のアプリと同じ「保存」／「別名で保存」で PDF を
# Drive へ書き出す。保存先の確かめ方（上書き先が PDF か・保存先がフォルダか）
# は同じなので、ここにまとめてツールごとのエラー型とファイル名の既定値だけを
# 渡す。届くのは ID だけなので、種類・ゴミ箱の確認は必ず実行ユーザーの代理
# セッションから行う。


def _resolve_pdf_destination(session, save, error, ensure_name, default_name) -> dict:
    """body.save から保存先を決め、実際に使えるかを確かめる。

    error はツールごとの例外クラス、ensure_name は拡張子の補正、default_name は
    ファイル名が指定されなかったときの既定値を作る関数。
    """
    save = save if isinstance(save, dict) else {}
    mode = save.get("mode") or "new"
    if mode not in ("new", "overwrite"):
        raise error("保存方法が不正です。")

    if mode == "overwrite":
        file_id = save.get("fileId")
        if not file_id or not isinstance(file_id, str):
            raise error("上書きするファイルが指定されていません。")
        meta = google_drive.get_file_metadata(session, file_id)
        if meta.get("trashed"):
            raise error("上書き先のファイルはゴミ箱に入っています。")
        if meta.get("mimeType") != google_drive.PDF_MIME:
            raise error("上書きできるのは PDF ファイルだけです。")
        return {"mode": mode, "fileId": file_id}

    # 新規保存の保存先は、そのつど画面の Picker で選ばれたフォルダ。
    folder_id = save.get("folderId")
    if not folder_id or not isinstance(folder_id, str):
        raise error("保存先のフォルダが選択されていません。")
    folder = google_drive.get_file_metadata(session, folder_id)
    if folder.get("trashed"):
        raise error("保存先のフォルダはゴミ箱に入っています。")
    if folder.get("mimeType") != google_drive.FOLDER_MIME:
        raise error("保存先にはフォルダを選択してください。")
    return {
        "mode": mode,
        "folderId": folder_id,
        "fileName": ensure_name(save.get("fileName") or default_name()),
    }


def _save_pdf(session, destination: dict, pdf_bytes: bytes) -> tuple[str, dict]:
    """PDF を保存し、(保存方法, Drive のファイル情報) を返す。"""
    if destination["mode"] == "overwrite":
        saved = google_drive.update_file_content(
            session, destination["fileId"], pdf_bytes, google_drive.PDF_MIME
        )
    else:
        saved = google_drive.create_file(
            session,
            destination["folderId"],
            destination["fileName"],
            pdf_bytes,
            google_drive.PDF_MIME,
        )
    return destination["mode"], saved


def _cert_settings() -> dict:
    return settings_store.get_tool_settings(TOOL_STRUCTURAL_CERT)


@app.get(f"{_CERT_PREFIX}/config")
async def get_certificate_config(user: User = Depends(require_user)):
    """フォーム定義（記入欄・選択肢・並び順）をマッピングから配信する。"""
    return structural_cert.form_config()


@app.get(f"{_CERT_PREFIX}/settings")
async def get_certificate_settings(user: User = Depends(require_user)):
    """雛形の設定状態を返す。UI の初期表示で使う。

    保存先はここでは持たない。証明書の保存先は「編集中のファイル」そのもの
    （上書き保存）か、新規保存のたびに Picker で選ぶフォルダで、共有設定と
    して固定するものではないため。
    """
    settings = _cert_settings()
    template_name = settings.get("template_file_name", "")
    return {
        "template": {
            "configured": bool(settings.get("template_folder_id") and template_name),
            "fileName": template_name,
        },
    }


@app.put(f"{_CERT_PREFIX}/template")
async def save_certificate_template(
    request: Request, user: User = Depends(require_user)
):
    """雛形の Google ドキュメントを選択し、親フォルダとファイル名を保存する。

    excel-report-formatter と同じく「フォルダ + ファイル名」で覚えるので、
    同じフォルダに同名で差し替えれば自動的に最新版が使われる。雛形は滅多に
    変わらないため、画面ではタイトル横の小さな設定ボタンから設定する。
    """
    file_id = (await _json_body(request)).get("fileId")
    if not file_id or not isinstance(file_id, str):
        raise CertificateError("ファイルが選択されていません。")

    meta = google_drive.get_file_metadata(
        google_drive.delegated_session(user.email), file_id
    )
    if meta.get("trashed"):
        raise CertificateError(
            "選択したファイルはゴミ箱に入っています。別のファイルを選択してください。"
        )
    if meta.get("mimeType") != google_drive.GOOGLE_DOC_MIME:
        raise CertificateError(
            "雛形は Google ドキュメントである必要があります。"
            "Word 形式などをアップロードしている場合は、Google ドキュメント形式へ変換してください。"
        )
    parents = meta.get("parents") or []
    if not parents:
        raise CertificateError(
            "選択したファイルの親フォルダを特定できませんでした。"
            "マイドライブ直下ではなくフォルダ内に雛形を置いてください。"
        )

    settings_store.set_tool_settings(
        TOOL_STRUCTURAL_CERT,
        {"template_folder_id": parents[0], "template_file_name": meta.get("name", "")},
    )
    return {"fileName": meta.get("name", ""), "folderId": parents[0]}


def _require_certificate_template(settings: dict) -> tuple[str, str]:
    folder_id = settings.get("template_folder_id", "")
    file_name = settings.get("template_file_name", "")
    if not folder_id or not file_name:
        raise CertificateError(
            "雛形が未設定です。画面の「雛形を設定」から、Google Drive 上の"
            "証明書の雛形（Google ドキュメント）を選択してください。",
            409,
        )
    return folder_id, file_name


def _render_certificate(session, data: dict, settings: dict) -> tuple[bytes, list]:
    """雛形からフォーム入力を差し込んだ PDF を作る。

    雛形そのものは触らず、複製に対して置換 → PDF 書き出し → 複製を削除。
    最後に該当する選択肢へ ○ を描き込み、再編集用にフォーム入力を
    文書情報として埋め込む。
    """
    folder_id, file_name = _require_certificate_template(settings)
    template = google_drive.find_latest_file(session, folder_id, file_name)
    copy = google_drive.copy_file(session, template["id"], f"[一時] {file_name}")
    try:
        counts = google_docs.replace_all_text(
            session, copy["id"], structural_cert.build_replacements(data)
        )
        exported = google_drive.export_file(session, copy["id"], google_drive.PDF_MIME)
    finally:
        try:
            google_drive.delete_file(session, copy["id"])
        except DriveError:
            # 後片付けの失敗で生成そのものを失敗させない。一時ファイルが
            # 残るだけで証明書は正しく作れているうえ、finally の中で
            # 送出すると本来のエラー（置換・書き出しの失敗）を覆い隠して
            # しまうため、ここで握りつぶす。
            pass

    warnings = structural_cert.missing_placeholder_warnings(counts, data)
    return structural_cert.finalize_pdf(exported, data), warnings


@app.post(f"{_CERT_PREFIX}/certificates")
async def create_certificate(request: Request, user: User = Depends(require_user)):
    """フォームデータから証明書 PDF を作り、Drive へ保存する。

    保存方法は body.save.mode で切り替える。一般的なアプリの「保存」／
    「別名で保存」と同じ考え方で、保存先はそのつど決まる:
      overwrite … 編集中のファイルの内容を差し替える（Drive の版履歴が残る）
      new       … save.folderId（画面の Picker で選ばれたフォルダ）に
                   新しいファイルとして作る
    """
    body = await _json_body(request)
    data = structural_cert.normalize_data(body)
    structural_cert.validate(data)

    # 設定は 1 リクエストにつき 1 回だけ読む。
    settings = _cert_settings()
    _require_certificate_template(settings)

    session = google_drive.delegated_write_session(user.email)

    # 保存先の確認は生成の前に済ませる。保存できない指定のために雛形を複製・
    # 書き出しするのは無駄なうえ、後片付けの機会も増えるため。
    destination = _resolve_pdf_destination(
        session,
        body.get("save"),
        CertificateError,
        structural_cert.ensure_pdf_extension,
        lambda: structural_cert.default_file_name(data),
    )

    pdf_bytes, warnings = _render_certificate(session, data, settings)
    mode, saved = _save_pdf(session, destination, pdf_bytes)

    return {
        "mode": mode,
        "fileId": saved.get("id", ""),
        "fileName": saved.get("name", ""),
        "webViewLink": saved.get("webViewLink", ""),
        "warnings": warnings,
    }


@app.post(f"{_CERT_PREFIX}/certificates/parse")
async def parse_uploaded_certificate(
    file: UploadFile = File(...), user: User = Depends(require_user)
):
    """アップロードされた証明書 PDF を解析してフォームデータへ変換する。"""
    if file.size is not None and file.size > _MAX_UPLOAD_BYTES:
        raise CertificateError("ファイルが大きすぎます（20MB まで）。", 413)
    content = await file.read()
    if len(content) > _MAX_UPLOAD_BYTES:
        raise CertificateError("ファイルが大きすぎます（20MB まで）。", 413)
    parsed = structural_cert.parse_pdf(content)
    return {
        **parsed,
        "file": {"id": "", "name": file.filename or ""},
        "suggestedFileName": file.filename or structural_cert.default_file_name(parsed),
    }


@app.post(f"{_CERT_PREFIX}/certificates/parse-drive")
async def parse_drive_certificate(
    request: Request, user: User = Depends(require_user)
):
    """Drive 上の証明書 PDF を解析してフォームデータへ変換する。

    ここで返す file.id が、そのまま「上書き保存」の対象になる。
    """
    file_id = (await _json_body(request)).get("fileId")
    if not file_id or not isinstance(file_id, str):
        raise CertificateError("ファイルが選択されていません。")

    session = google_drive.delegated_session(user.email)
    meta = google_drive.get_file_metadata(session, file_id)
    if meta.get("trashed"):
        raise CertificateError("選択したファイルはゴミ箱に入っています。")
    if meta.get("mimeType") != google_drive.PDF_MIME:
        raise CertificateError("PDF ファイルを選択してください。")

    content = google_drive.download_file(session, file_id, context="PDF のダウンロード")
    parsed = structural_cert.parse_pdf(content)
    return {
        **parsed,
        "file": {"id": file_id, "name": meta.get("name", "")},
        "suggestedFileName": meta.get("name", ""),
    }


# --- 面材張り大壁 計算ツール ------------------------------------------------
#
# GAS 版はスプレッドシートへ現在値と履歴を書き出していたが、ここでは証明書と
# 同じく「成果物の PDF そのものが保存形式」になる。フォーム入力を PDF の
# 文書情報へ埋め込むため、保存した PDF を開き直せば続きを編集できる。
# 雛形は使わない（計算書はバックエンドが直接組み立てる）ので、このツールには
# 共有設定が無い。
#
# 編集中の計算に API は使わない。画面は /core.wasm で計算実装を受け取り、
# 手元で計算する（入力のたびの往復が無いので、釘の本数が増えても速い）。
# サーバが計算するのは保存のときだけで、そこで画面の値と突き合わせる。


@app.get(f"{_PANEL_PREFIX}/config")
async def get_panel_shear_config(user: User = Depends(require_user)):
    """既定のファイル名と、計算実装の在り処を配信する。"""
    return panel_shear.form_config(f"{_PANEL_PREFIX}/core.wasm")


@app.get(f"{_PANEL_PREFIX}/core.wasm")
async def get_panel_shear_core(user: User = Depends(require_user)):
    """画面が編集中の計算に使う wasm を配る。

    サーバ自身が計算に使っているものと**同じバイト列**をそのまま返すので、
    「画面とサーバで実装が違う」状態が原理的に起こらない。URL には中身の
    ハッシュが付く（/config が配る）ため、内容が変わらないうちはブラウザの
    キャッシュから読ませ、変われば必ず取り直させる。
    """
    return Response(
        content=nail_core.wasm_bytes(),
        media_type="application/wasm",
        headers={
            "Cache-Control": "public, max-age=31536000, immutable",
            "ETag": f'"{nail_core.sha256()}"',
        },
    )


@app.post(f"{_PANEL_PREFIX}/reports")
async def create_panel_shear_report(
    request: Request, user: User = Depends(require_user)
):
    """フォームデータから計算書 PDF を作り、Drive へ保存する。

    保存方法は証明書と同じく body.save.mode（overwrite / new）で切り替える。

    計算書に載るのはここで計算し直した値。編集中に画面（同じ wasm）が出して
    いた値も body.verify として受け取り、突き合わせた結果を応答へ添える
    （食い違っていても保存は止めず、画面に警告を出させる）。
    """
    body = await _json_body(request)
    data = panel_shear.normalize_data(body)
    reports = panel_shear.validate(data)
    verification = panel_shear.verify(reports, body.get("verify"))

    session = google_drive.delegated_write_session(user.email)
    destination = _resolve_pdf_destination(
        session,
        body.get("save"),
        PanelShearError,
        panel_shear.ensure_pdf_extension,
        lambda: panel_shear.default_file_name(data),
    )

    mode, saved = _save_pdf(session, destination, panel_shear.build_pdf(data, reports))
    return {
        "mode": mode,
        "fileId": saved.get("id", ""),
        "fileName": saved.get("name", ""),
        "webViewLink": saved.get("webViewLink", ""),
        "verification": verification,
    }


@app.post(f"{_PANEL_PREFIX}/reports/parse")
async def parse_uploaded_panel_shear_report(
    file: UploadFile = File(...), user: User = Depends(require_user)
):
    """アップロードされた計算書 PDF を読み、フォームデータへ戻す。"""
    if file.size is not None and file.size > _MAX_UPLOAD_BYTES:
        raise PanelShearError("ファイルが大きすぎます（20MB まで）。", 413)
    content = await file.read()
    if len(content) > _MAX_UPLOAD_BYTES:
        raise PanelShearError("ファイルが大きすぎます（20MB まで）。", 413)
    return {
        **panel_shear.parse_pdf(content),
        # アップロードした PDF は Drive 上のファイルではないので上書き先にできない。
        "file": {"id": "", "name": file.filename or ""},
        "suggestedFileName": file.filename or "",
    }


@app.post(f"{_PANEL_PREFIX}/reports/parse-drive")
async def parse_drive_panel_shear_report(
    request: Request, user: User = Depends(require_user)
):
    """Drive 上の計算書 PDF を読み、フォームデータへ戻す。

    ここで返す file.id が、そのまま「上書き保存」の対象になる。
    """
    file_id = (await _json_body(request)).get("fileId")
    if not file_id or not isinstance(file_id, str):
        raise PanelShearError("ファイルが選択されていません。")

    session = google_drive.delegated_session(user.email)
    meta = google_drive.get_file_metadata(session, file_id)
    if meta.get("trashed"):
        raise PanelShearError("選択したファイルはゴミ箱に入っています。")
    if meta.get("mimeType") != google_drive.PDF_MIME:
        raise PanelShearError("PDF ファイルを選択してください。")

    content = google_drive.download_file(session, file_id, context="PDF のダウンロード")
    return {
        **panel_shear.parse_pdf(content),
        "file": {"id": file_id, "name": meta.get("name", "")},
        "suggestedFileName": meta.get("name", ""),
    }
