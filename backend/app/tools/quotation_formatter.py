"""見積書 作成ツールの API（/api/tools/quotation-formatter/**）。

雛形は使わない（明細の数だけ行が伸びる書面なので、バックエンドが直接組み立て
る）。成果物の PDF そのものが保存形式で、フォーム入力を文書情報へ埋め込むため、
保存した見積書を開き直せば続きを編集できる——ここは釘配列諸定数の計算書と同じ。

共有設定を持つのは、**事務所が決めたものだけ**——事務所の情報・定型文・単価
・税率。告示の別表や倍数はリポジトリの計算実装にあり、設定には出てこない
（docs/contract-formatter.md §6・§8）。

編集中の計算に API は使わない。画面は /core.wasm で計算実装を受け取り、手元で
金額を出す。サーバが計算するのは保存のときだけで、そこで画面の値と突き合わせる。
"""

from fastapi import Depends, File, Request, UploadFile

from .. import portal_sdk, quotation
from ..clerk_auth import User
from ..portal_sdk import Tool, require_user
from ..quotation import QuotationError

TOOL_ID = "quotation-formatter"

router = portal_sdk.tool_router(TOOL_ID)


@router.get("/config")
async def get_config(user: User = Depends(require_user)):
    """業務のテンプレート・選択肢と、計算実装の在り処を配信する。"""
    return quotation.form_config(f"{router.prefix}/core.wasm")


@router.get("/core.wasm")
async def get_core(request: Request, user: User = Depends(require_user)):
    """画面が編集中の計算に使う wasm を配る（portal_sdk.wasm_response 参照）。"""
    return portal_sdk.wasm_response(request)


@router.get("/settings")
async def get_quotation_settings(user: User = Depends(require_user)):
    """事務所の情報・定型文・単価を返す。**フォームの初期値**として使う。

    ここにあるのは初期値であって、印字される値ではない。見積書が持っている値が
    印字されるので、設定を変えても過去の見積書は変わらない。
    """
    return quotation.stored_settings(portal_sdk.get_settings(TOOL_ID))


@router.put("/settings")
async def save_quotation_settings(request: Request, user: User = Depends(require_user)):
    """事務所の情報・定型文・単価を保存する。"""
    body = await portal_sdk.json_body(request)
    settings = quotation.normalize_settings(body)
    portal_sdk.set_settings(TOOL_ID, settings)
    return settings


@router.post("/quotations")
async def create_quotation(request: Request, user: User = Depends(require_user)):
    """フォームデータから見積書 PDF を作り、Drive へ保存する。

    保存方法は他の PDF ツールと同じく body.save.mode（overwrite / new）で
    切り替える。既定のファイル名は `YYYYMMDD_取引先名_金額.pdf` で、そのまま
    保存すれば電子帳簿保存法の検索要件への備えになる。

    見積書に刷られるのはここで計算し直した金額。編集中に画面（同じ wasm）が
    出していた値も body.verify として受け取り、突き合わせた結果を応答へ添える
    （食い違っていても保存は止めず、画面に警告を出させる）。
    """
    body = await portal_sdk.json_body(request)
    data = quotation.normalize_data(body)
    computed = quotation.validate(data)
    verification = quotation.verify(computed, body.get("verify"))

    session = portal_sdk.delegated_write_session(user.email)
    destination = portal_sdk.resolve_pdf_destination(
        session,
        body.get("save"),
        QuotationError,
        quotation.ensure_pdf_extension,
        lambda: quotation.default_file_name(computed),
    )

    mode, saved = portal_sdk.save_pdf(
        session, destination, quotation.build_pdf(data, computed)
    )
    return {
        "mode": mode,
        "fileId": saved.get("id", ""),
        "fileName": saved.get("name", ""),
        "webViewLink": saved.get("webViewLink", ""),
        "verification": verification,
        "warnings": computed.get("warnings", []),
    }


@router.post("/quotations/parse")
async def parse_uploaded_quotation(
    file: UploadFile = File(...), user: User = Depends(require_user)
):
    """アップロードされた見積書 PDF を読み、フォームデータへ戻す。"""
    content = await portal_sdk.read_upload(file, QuotationError)
    return {
        "data": quotation.parse_pdf(content),
        # アップロードした PDF は Drive 上のファイルではないので上書き先にできない。
        "file": {"id": "", "name": file.filename or ""},
        "suggestedFileName": file.filename or "",
    }


@router.post("/quotations/parse-drive")
async def parse_drive_quotation(request: Request, user: User = Depends(require_user)):
    """Drive 上の見積書 PDF を読み、フォームデータへ戻す。

    ここで返す file.id が、そのまま「上書き保存」の対象になる。
    """
    file_id = (await portal_sdk.json_body(request)).get("fileId")
    session = portal_sdk.delegated_session(user.email)
    content, meta = portal_sdk.open_drive_pdf(session, file_id, QuotationError)
    return {
        "data": quotation.parse_pdf(content),
        "file": {"id": file_id, "name": meta.get("name", "")},
        "suggestedFileName": meta.get("name", ""),
    }


TOOL = Tool(
    id=TOOL_ID,
    name="見積書 作成ツール",
    router=router,
)
