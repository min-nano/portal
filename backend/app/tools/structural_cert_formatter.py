"""構造計算安全証明書 作成ツールの API（/api/tools/structural-cert-formatter/**）。

雛形（Google ドキュメント）と保存先フォルダを Drive から選び、設定を
Firestore に保存する点は excel-report-formatter と同じ。生成は雛形を
複製 → プレースホルダー置換 → PDF 書き出し → 選択肢へ ○ を描き込み →
Drive へ保存、という流れで、すべて実行ユーザー本人の代理権限で行う。

雛形の設定（portal_sdk.Template）も、保存先の確かめ方（上書き先が PDF か・
保存先がフォルダか。portal_sdk.resolve_pdf_destination / save_pdf）も、
他のツールと同じものなので土台にある。
"""

from fastapi import Depends, Request

from .. import google_docs, google_drive, portal_sdk, structural_cert
from ..clerk_auth import User
from ..google_drive import DriveError
from ..portal_sdk import Template, Tool, require_user
from ..structural_cert import CertificateError

TOOL_ID = "structural-cert-formatter"

router = portal_sdk.tool_router(TOOL_ID)

# 雛形は Google ドキュメント（プレースホルダーを Docs API で置換するため、
# Word 形式などのアップロードファイルでは置換できない）。
TEMPLATE = Template(
    tool_id=TOOL_ID,
    mime_type=google_drive.GOOGLE_DOC_MIME,
    error=CertificateError,
    wrong_type_message=(
        "雛形は Google ドキュメントである必要があります。"
        "Word 形式などをアップロードしている場合は、Google ドキュメント形式へ変換してください。"
    ),
    unconfigured_message=(
        "雛形が未設定です。画面の「雛形を設定」から、Google Drive 上の"
        "証明書の雛形（Google ドキュメント）を選択してください。"
    ),
)


@router.get("/config")
async def get_certificate_config(user: User = Depends(require_user)):
    """フォーム定義（記入欄・選択肢・並び順）をマッピングから配信する。"""
    return structural_cert.form_config()


@router.get("/template")
async def get_template_status(user: User = Depends(require_user)):
    """雛形の設定状態を返す。UI の初期表示で使う。

    保存先はここでは持たない。証明書の保存先は「編集中のファイル」そのもの
    （上書き保存）か、新規保存のたびに Picker で選ぶフォルダで、共有設定と
    して固定するものではないため。
    """
    return TEMPLATE.status()


@router.put("/template")
async def save_certificate_template(
    request: Request, user: User = Depends(require_user)
):
    """雛形の Google ドキュメントを選択し、親フォルダとファイル名を保存する。

    excel-report-formatter と同じく「フォルダ + ファイル名」で覚えるので、
    同じフォルダに同名で差し替えれば自動的に最新版が使われる。雛形は滅多に
    変わらないため、画面ではタイトル横の小さな設定ボタンから設定する。
    """
    file_id = (await portal_sdk.json_body(request)).get("fileId")
    return TEMPLATE.save(portal_sdk.delegated_session(user.email), file_id)


def _render(session, data: dict, settings: dict) -> tuple[bytes, list]:
    """雛形からフォーム入力を差し込んだ PDF を作る。

    雛形そのものは触らず、複製に対して置換 → PDF 書き出し → 複製を削除。
    最後に該当する選択肢へ ○ を描き込み、再編集用にフォーム入力を
    文書情報として埋め込む。
    """
    folder_id, file_name = TEMPLATE.require(settings)
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


@router.post("/certificates")
async def create_certificate(request: Request, user: User = Depends(require_user)):
    """フォームデータから証明書 PDF を作り、Drive へ保存する。

    保存方法は body.save.mode で切り替える。一般的なアプリの「保存」／
    「別名で保存」と同じ考え方で、保存先はそのつど決まる:
      overwrite … 編集中のファイルの内容を差し替える（Drive の版履歴が残る）
      new       … save.folderId（画面の Picker で選ばれたフォルダ）に
                   新しいファイルとして作る
    """
    body = await portal_sdk.json_body(request)
    data = structural_cert.normalize_data(body)
    structural_cert.validate(data)

    # 設定は 1 リクエストにつき 1 回だけ読む。
    settings = TEMPLATE.settings()
    TEMPLATE.require(settings)

    session = portal_sdk.delegated_write_session(user.email)

    # 保存先の確認は生成の前に済ませる。保存できない指定のために雛形を複製・
    # 書き出しするのは無駄なうえ、後片付けの機会も増えるため。
    destination = portal_sdk.resolve_pdf_destination(
        session,
        body.get("save"),
        CertificateError,
        structural_cert.ensure_pdf_extension,
        lambda: structural_cert.default_file_name(data),
    )

    pdf_bytes, warnings = _render(session, data, settings)
    return portal_sdk.save_pdf(session, destination, pdf_bytes, warnings=warnings)


# 証明書 PDF の読み戻し（アップロード / Drive）。段取りは計算書ツールと同じ。
portal_sdk.pdf_parse_routes(
    router,
    "/certificates",
    parse=structural_cert.parse_pdf,
    error=CertificateError,
    default_name=structural_cert.default_file_name,
)


TOOL = Tool(
    id=TOOL_ID,
    name="構造計算安全証明書 作成ツール",
    router=router,
)
