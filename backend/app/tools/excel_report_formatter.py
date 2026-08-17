"""現況検査レポート作成ツールの API（/api/tools/excel-report-formatter/**）。

雛形（社外秘フォーマットの .xlsx）は Drive 上のファイルを「フォルダ +
ファイル名」で覚えておき、生成のたびに実行ユーザー本人の代理で最新版を
取得する。本人に閲覧権限が無ければここで失敗する（GAS 版と同じ境界）。

土台から借りているもの（認証・代理アクセス・共有設定・エラーの返し方）は
portal_sdk にある。
"""

from urllib.parse import quote

from fastapi import Depends, Request, Response

from .. import excel_report, google_drive, portal_sdk
from ..clerk_auth import User
from ..excel_report import ReportError
from ..google_drive import XLSX_MIME
from ..portal_sdk import Template, Tool, require_user

TOOL_ID = "excel-report-formatter"

router = portal_sdk.tool_router(TOOL_ID)

# 雛形は Drive 上のネイティブ .xlsx。Google スプレッドシート等を選ぶと
# エクスポート形式が変わり、openpyxl が読み込みに失敗する。
TEMPLATE = Template(
    tool_id=TOOL_ID,
    mime_type=XLSX_MIME,
    error=ReportError,
    wrong_type_message=(
        "Google スプレッドシート等の形式はサポートされていません。"
        "Excel 形式 (.xlsx) のファイルを選択してください。"
    ),
    unconfigured_message=(
        "Excel 雛形が未設定です。画面の「雛形を設定」から、"
        "Google Drive 上の雛形ファイルを選択してください。"
    ),
)


@router.get("/config")
async def get_form_config(user: User = Depends(require_user)):
    """フォーム定義（計測点・選択肢・バリデーション）を mapping.json から配信する。"""
    return excel_report.form_config()


@router.get("/template")
async def get_template_status(user: User = Depends(require_user)):
    """現在保存されている雛形設定の状態を返す。UI の初期表示で使う。"""
    return TEMPLATE.status()


@router.put("/template")
async def save_template_selection(request: Request, user: User = Depends(require_user)):
    """公式 Google Picker で選ばれた雛形の親フォルダ ID とファイル名を保存する。

    Picker はブラウザ側でファイルを選ぶだけなので、種類の確認は土台が行う
    （GAS 版 saveTemplateSelection と同じルール: ネイティブ .xlsx のみ許可し、
    親フォルダを特定できないファイルは拒否する）。
    """
    file_id = (await portal_sdk.json_body(request)).get("fileId")
    return TEMPLATE.save(portal_sdk.delegated_session(user.email), file_id)


@router.post("/reports")
async def create_report(request: Request, user: User = Depends(require_user)):
    """フォームデータから傾斜測定報告書（xlsx）を生成して返す。

    雛形は共有設定のフォルダ／ファイル名を基に、実行ユーザーの代理で Drive から
    最新版を取得する（本人にアクセス権が無ければここで失敗する）。
    """
    body = await portal_sdk.json_body(request)
    if not body:
        raise ReportError("No data provided")

    folder_id, file_name = TEMPLATE.require()

    template_bytes = google_drive.fetch_latest_template(
        portal_sdk.delegated_session(user.email), folder_id, file_name
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


TOOL = Tool(
    id=TOOL_ID,
    name="現況検査レポート作成ツール",
    router=router,
)
