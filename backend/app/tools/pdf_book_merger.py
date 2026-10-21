"""書籍スキャン PDF 結合ツールの API（/api/tools/pdf-book-merger/**）。

結合も、頁番号の読み取りも、スキャンの検査も、すべて画面（ブラウザ）の中で
行う。重い計算（画像の展開・OCR・結合）をサーバーで行うと Cloud Run の費用が
掛かるため。結合した PDF はダウンロードするだけで、Drive へは保存しない
（Drive へは、利用者が端末の Google ドライブのアプリなどからアップロードする）。

ここが受け持つのは、Drive の PDF を読む **準備** だけ。スキャンした本は 1 冊で
数百 MB になり、Cloud Run と Hosting を通して運ぶと転送量が掛かる（読み直す
たびに掛かる）。そこで中身は運ばず、本人の代理（読み取り専用）のアクセス
トークンを画面へ渡し、画面が Drive から直接読む（drive-download.js）。

ほかのツールはブラウザへトークンを渡さない（README「4. Drive のファイル選択」）。
ここだけの例外で、渡すのは drive.readonly のトークンを 1 つ（期限 1 時間ほど）。
応答はどこにも残さない（Cache-Control: no-store）。

  GET  /files/{id}   PDF か確かめ、名前・大きさと、読むためのトークンを返す
"""

import datetime
import re

from fastapi import Depends
from fastapi.responses import JSONResponse

from .. import google_drive, portal_sdk
from ..clerk_auth import User
from ..portal_sdk import Tool, ToolError, require_user

TOOL_ID = "pdf-book-merger"

router = portal_sdk.tool_router(TOOL_ID)

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
    """Drive の PDF を確かめ、名前と大きさ、読むためのトークンを返す。

    トークンは本人の代理（読み取り専用）なので、本人が読めないファイルは
    Drive が断る。ゴミ箱のもの・PDF でないものには、トークンを渡さない。
    """
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
    token, expiry = portal_sdk.delegated_read_token(user.email)
    return JSONResponse(
        {
            "id": file_id,
            "name": meta.get("name", ""),
            "size": size,
            # 読んでいる途中で差し替えられていないかを、画面が確かめる印。
            "revision": meta.get("headRevisionId") or meta.get("modifiedTime"),
            "accessToken": token,
            "expiresAt": expiry.replace(tzinfo=datetime.timezone.utc).isoformat() if expiry else None,
        },
        # トークンを含むので、経路のどこにも残さない。
        headers={"Cache-Control": "no-store"},
    )


TOOL = Tool(
    id=TOOL_ID,
    name="書籍スキャン PDF 結合ツール",
    router=router,
)
