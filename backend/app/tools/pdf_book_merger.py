"""書籍スキャン PDF 結合ツールの API（/api/tools/pdf-book-merger/**）。

結合も、頁番号の読み取りも、スキャンの検査も、すべて画面（ブラウザ）の中で
行う。重い計算（画像の展開・OCR・結合）をサーバーで行うと Cloud Run の費用が
掛かるため。結合した PDF はダウンロードするだけで、Drive へは保存しない
（Drive へは、利用者が端末の Google ドライブのアプリなどからアップロードする）。

ここが受け持つのは、Drive の PDF を読むときの **中継** だけ。ブラウザへ Drive
のアクセストークンは渡さない（README「4. Drive のファイル選択」）ので、
サーバーが本人の代理（読み取り専用）で読む。スキャンした本は 1 冊で数百 MB に
なり、1 回のリクエストでは Cloud Run と Hosting のリライトの上限（本文の
大きさ・時間）に掛かるので、8 MiB ずつに分けて運ぶ。

  GET  /files/{id}          PDF か確かめ、大きさを返す
  GET  /files/{id}/content  start〜end バイト目を返す（Drive の Range 読み）

画面とやり取りするのはファイルの ID だけで、Drive の URL はサーバーが組み立てる。
"""

import re

from fastapi import Depends, Response

from .. import google_drive, portal_sdk
from ..clerk_auth import User
from ..portal_sdk import Tool, ToolError, require_user

TOOL_ID = "pdf-book-merger"

router = portal_sdk.tool_router(TOOL_ID)

# 1 回に返す大きさ。Cloud Run が 1 回のリクエストで返せる本文（32 MiB）より
# 十分小さくする。
CHUNK_BYTES = 8 * 1024 * 1024

# Drive のファイル ID の形（URL の道に埋め込むので、形を先に確かめる）。
_FILE_ID = re.compile(r"[A-Za-z0-9_-]{1,200}")


class MergeError(ToolError):
    """Drive の PDF を読めない（画面に出す理由）。"""


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


TOOL = Tool(
    id=TOOL_ID,
    name="書籍スキャン PDF 結合ツール",
    router=router,
)
