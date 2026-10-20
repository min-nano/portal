"""書籍スキャン PDF 結合ツールの API（/api/tools/pdf-book-merger/**）。

結合も、頁番号の読み取りも、スキャンの検査も、すべて画面（ブラウザ）の中で
行う。重い計算（画像の展開・OCR・結合）をサーバーで行うと Cloud Run の費用が
掛かるため。ここが受け持つのは、Drive とのあいだでバイト列を **中継する**
ことだけ。

ブラウザへ Drive のアクセストークンは渡さない（README「4. Drive のファイル
選択」）。読むのも書くのもサーバーが本人の代理で行う。スキャンした本は 1 冊で
数百 MB になり、1 回のリクエストでは Cloud Run と Hosting のリライトの上限
（本文の大きさ・時間）に掛かるので、どちらも 8 MiB ずつに分けて運ぶ。

読む（読み取り専用の代理）:

  GET  /files/{id}          PDF か確かめ、大きさを返す
  GET  /files/{id}/content  start〜end バイト目を返す（Drive の Range 読み）

書く（書き込みの代理。保存先を確かめてから、Drive の再開可能なアップロード）:

  POST /uploads        保存先（フォルダ）を確かめ、アップロードを始める
  POST /uploads/chunk  続きを受け取り、Drive へ送る

画面とやり取りするのはファイルの ID と受け口の id だけで、Drive の URL は
サーバーが組み立てる（任意の宛先へ送らせないため）。
"""

import re

from fastapi import Depends, File, Form, Request, Response, UploadFile

from .. import google_drive, portal_sdk
from ..clerk_auth import User
from ..portal_sdk import Tool, ToolError, require_user

TOOL_ID = "pdf-book-merger"

router = portal_sdk.tool_router(TOOL_ID)

# 1 回に受け取る大きさ。Cloud Run が 1 回のリクエストで受け取れる本文
# （32 MiB）より十分小さく、Drive の決まり（256 KiB の倍数）に合わせる。
CHUNK_BYTES = 32 * google_drive.RESUMABLE_CHUNK_UNIT  # 8 MiB

# 結合した PDF の上限。Drive の上限（5 TB）よりずっと小さいが、ブラウザの
# メモリに載る大きさとして、これを超えるものは途中で失敗するはずなので。
MAX_TOTAL_BYTES = 4 * 1024**3

DEFAULT_FILE_NAME = "結合.pdf"

# Drive のファイル ID の形（URL の道に埋め込むので、形を先に確かめる）。
_FILE_ID = re.compile(r"[A-Za-z0-9_-]{1,200}")


class MergeError(ToolError):
    """結合した PDF の保存の失敗。"""


def _ensure_pdf_name(name) -> str:
    return portal_sdk.ensure_file_name(name, DEFAULT_FILE_NAME)


def _positive_int(value, message: str) -> int:
    if isinstance(value, bool):
        raise MergeError(message)
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise MergeError(message) from None
    if number <= 0:
        raise MergeError(message)
    return number


def _file_id(value) -> str:
    if not isinstance(value, str) or not _FILE_ID.fullmatch(value):
        raise MergeError("ファイルの指定が正しくありません。")
    return value


# Drive の呼び出しは同期処理（requests）なので、async にせず普通の関数にして
# おく（FastAPI がスレッドプールで動かし、待つ間もほかのリクエストを止めない）。
@router.get("/files/{file_id}")
def file_info(file_id: str, user: User = Depends(require_user)):
    """Drive の PDF を確かめ、名前と大きさ、1 回に読める大きさを返す。"""
    file_id = _file_id(file_id)
    session = portal_sdk.delegated_session(user.email)
    meta = google_drive.get_file_metadata(session, file_id)
    if meta.get("trashed"):
        raise MergeError("選択したファイルはゴミ箱に入っています。")
    if meta.get("mimeType") != google_drive.PDF_MIME:
        raise MergeError("PDF ファイルではありません。")
    try:
        size = int(meta.get("size") or 0)
    except (TypeError, ValueError):
        size = 0
    if size <= 0:
        raise MergeError("ファイルの大きさが分かりませんでした。")
    return {"id": file_id, "name": meta.get("name", ""), "size": size, "chunkBytes": CHUNK_BYTES}


@router.get("/files/{file_id}/content")
def file_content(file_id: str, start: int, end: int, user: User = Depends(require_user)):
    """Drive のファイルの start〜end バイト目（end を含む）を返す。

    読むのは本人の代理（読み取り専用）なので、本人が読めないファイルは
    Drive が断る。1 回に返すのは CHUNK_BYTES まで。
    """
    file_id = _file_id(file_id)
    if start < 0 or end < start or end - start + 1 > CHUNK_BYTES:
        raise MergeError(f"読む範囲が正しくありません（1 回に {CHUNK_BYTES // 1024**2} MiB まで）。")
    session = portal_sdk.delegated_session(user.email)
    data = google_drive.download_range(session, file_id, start, end)
    return Response(
        content=data,
        media_type="application/octet-stream",
        # 本人の Drive の中身なので、経路のどこにも残さない。
        headers={"Cache-Control": "no-store"},
    )


@router.post("/uploads")
async def start_upload(request: Request, user: User = Depends(require_user)):
    """保存先のフォルダを確かめ、Drive へのアップロードを始める。

    本文は {folderId, fileName, size}。返すのは受け口の id（uploadId）と、
    1 回に送る大きさ（chunkBytes）。受け口はこのファイル 1 つにだけ
    書き込めるもので、画面はその id を /uploads/chunk へ添えて送る
    （送り先の URL はサーバーが組み立てる。画面からは受け取らない）。
    """
    body = await portal_sdk.json_body(request)
    size = _positive_int(body.get("size"), "保存するファイルの大きさが正しくありません。")
    if size > MAX_TOTAL_BYTES:
        raise MergeError("ファイルが大きすぎます（4GB まで）。", 413)

    session = portal_sdk.delegated_write_session(user.email)
    destination = portal_sdk.resolve_pdf_destination(
        session,
        {"mode": "new", "folderId": body.get("folderId"), "fileName": body.get("fileName")},
        MergeError,
        _ensure_pdf_name,
        lambda: DEFAULT_FILE_NAME,
    )
    upload_id = google_drive.start_resumable_upload(
        session,
        destination["folderId"],
        destination["fileName"],
        google_drive.PDF_MIME,
        size,
    )
    return {
        "uploadId": upload_id,
        "chunkBytes": CHUNK_BYTES,
        "fileName": destination["fileName"],
    }


@router.post("/uploads/chunk")
async def upload_chunk(
    upload_id: str = Form(..., alias="uploadId"),
    offset: int = Form(...),
    total: int = Form(...),
    chunk: UploadFile = File(...),
    user: User = Depends(require_user),
):
    """続きを受け取り、Drive へ送る。

    途中なら {done: false, received}（次はここから送る）、最後なら
    {done: true, fileId, fileName, webViewLink} を返す。
    """
    if offset < 0 or total <= 0 or total > MAX_TOTAL_BYTES:
        raise MergeError("送る位置が正しくありません。")
    if not google_drive.is_upload_id(upload_id):
        raise MergeError("保存の送り先が正しくありません。")

    content = await chunk.read(CHUNK_BYTES + 1)
    if len(content) > CHUNK_BYTES:
        raise MergeError("一度に送る大きさが大きすぎます。", 413)
    if not content:
        raise MergeError("送る中身がありません。")
    if offset + len(content) > total:
        raise MergeError("送る位置が正しくありません。")
    # 最後の 1 回のほかは、Drive の決まり（256 KiB の倍数）に合っていなければならない。
    if offset + len(content) < total and len(content) % google_drive.RESUMABLE_CHUNK_UNIT:
        raise MergeError("一度に送る大きさが正しくありません。")

    result = google_drive.upload_chunk(upload_id, offset, total, content)
    if not result["done"]:
        return {"done": False, "received": result["received"]}
    return {
        "done": True,
        "fileId": result.get("id", ""),
        "fileName": result.get("name", ""),
        "webViewLink": result.get("webViewLink", ""),
    }


TOOL = Tool(
    id=TOOL_ID,
    name="書籍スキャン PDF 結合ツール",
    router=router,
)
