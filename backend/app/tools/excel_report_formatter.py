"""現況検査レポート作成ツールの API（/api/tools/excel-report-formatter/**）。

雛形（社外秘フォーマットの .xlsx）は Drive 上のファイルを「フォルダ +
ファイル名」で覚えておき、生成のたびに実行ユーザー本人の代理で最新版を
取得する。本人に閲覧権限が無ければここで失敗する（GAS 版と同じ境界）。

土台から借りているもの（認証・代理アクセス・共有設定・エラーの返し方）は
portal_sdk にある。別リポジトリへ出したときに変わるのは import の書き方
だけで、このファイルの中身は変わらない。
"""

from urllib.parse import quote

from fastapi import Depends, Request, Response

from .. import excel_report, google_drive, portal_sdk, template_fulfiller
from ..clerk_auth import User
from ..excel_report import ReportError
from ..google_drive import XLSX_MIME
from ..portal_sdk import Tool, require_user

TOOL_ID = "excel-report-formatter"

# 雛形が未設定のときの案内。指すものがツールによって違うのでここに置く。
TEMPLATE_REQUIRED = (
    "Excel 雛形が未設定です。画面の「雛形を設定」から、"
    "Google Drive 上の雛形ファイルを選択してください。"
)

router = portal_sdk.tool_router(TOOL_ID)


@router.get("/config")
async def get_form_config(user: User = Depends(require_user)):
    """フォーム定義（計測点・選択肢・バリデーション）を mapping.json から配信する。"""
    return excel_report.form_config()


@router.get("/template")
async def get_template_status(user: User = Depends(require_user)):
    """現在保存されている雛形設定の状態を返す。UI の初期表示で使う。"""
    return template_fulfiller.template_status(TOOL_ID)


@router.put("/template")
async def save_template_selection(request: Request, user: User = Depends(require_user)):
    """公式 Google Picker で選ばれた雛形の親フォルダ ID とファイル名を保存する。

    ネイティブ .xlsx のみ許可する（Google スプレッドシート等はエクスポート
    形式が変わり openpyxl が読めない）。確認の段取りそのものは証明書ツールと
    同じなので template_fulfiller にある。
    """
    file_id = (await portal_sdk.json_body(request)).get("fileId")
    return template_fulfiller.save_template(
        TOOL_ID, template_fulfiller.XLSX, file_id, user.email, ReportError
    )


@router.post("/reports")
async def create_report(request: Request, user: User = Depends(require_user)):
    """フォームデータから傾斜測定報告書（xlsx）を生成して返す。

    雛形は共有設定のフォルダ／ファイル名を基に、実行ユーザーの代理で Drive から
    最新版を取得する（本人にアクセス権が無ければここで失敗する）。
    """
    body = await portal_sdk.json_body(request)
    if not body:
        raise ReportError("No data provided")

    folder_id, file_name = template_fulfiller.require_template(
        portal_sdk.get_settings(TOOL_ID), TEMPLATE_REQUIRED, ReportError
    )

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
