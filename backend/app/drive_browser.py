"""Drive の中をたどる画面（ファイル選択ダイアログ）のための一覧取得。

ファイル・フォルダを選ぶ画面は、以前は Google 公式の Google Picker だった。
Picker は Google の iframe をページに埋め込む作りで、iframe の中で Google の
Cookie（サードパーティ Cookie）を要求する。Safari（iOS を含む）はこれを既定で
すべて遮るため、「Google が必要な Cookie にアクセスするのを許可してください」
と出て先へ進めなくなった。

そこで、選ぶ画面はポータル側で描き、その一覧をここで本人の代理アクセス
（drive.readonly）で取って返す。ブラウザと Google の間に直接のやり取りが
無くなるので Cookie は関係なく、アクセストークンをブラウザへ渡す必要も
無くなった。返すのは名前と種類だけで、本人が Drive で見られる範囲を超えない。

選ばれたファイル ID の確認（種類・ゴミ箱・親フォルダ）と実際の読み書きは、
これまでどおり各ツールがサーバー側で行う。ここは「何があるか」を見せるだけ。
"""

import re

from .google_drive import (
    FOLDER_MIME,
    DriveError,
    _escape_query_value,
    _raise_for_status,
)

SHORTCUT_MIME = "application/vnd.google-apps.shortcut"

_FILES_URL = "https://www.googleapis.com/drive/v3/files"
_DRIVES_URL = "https://www.googleapis.com/drive/v3/drives"

# 画面は下までスクロールしたら続きを取りに来る。1 回で取る件数は Drive の
# 上限（files.list は 1000、drives.list は 100）より小さく、スマホの 1 画面を
# 何度か埋められる程度にする。
PAGE_SIZE = 100

# 最初に開く場所（タブ）。フォルダの中へ入ったあとはフォルダ ID で指す。
LOCATIONS = ("my-drive", "shared-drives", "recent", "shared-with-me")

# 検索語の長さの上限。Drive のクエリに埋め込むので、際限なく受け取らない。
MAX_QUERY_LENGTH = 200

# MIME タイプとして受け付ける形（クエリに埋め込むので、形を先に確かめる）。
_MIME_PATTERN = re.compile(r"^[\w.+-]+/[\w.+-]+$")

_FILE_FIELDS = (
    "nextPageToken, incompleteSearch, "
    "files(id, name, mimeType, modifiedTime, "
    "shortcutDetails(targetId, targetMimeType))"
)


class BrowseError(DriveError):
    """画面から届いた条件が正しくない（400）。"""

    def __init__(self, message: str):
        super().__init__(message, 400)


def parse_mime_types(value: str | None) -> list[str]:
    """カンマ区切りの MIME タイプを取り出す（空なら絞り込まない）。"""
    types = [part.strip() for part in (value or "").split(",") if part.strip()]
    for mime in types:
        if not _MIME_PATTERN.match(mime):
            raise BrowseError(f"ファイルの種類の指定が正しくありません: {mime}")
    return types


def _type_filter(mime_types: list[str], folders_only: bool) -> str:
    """種類の絞り込み。フォルダは中へ入るために常に出す。

    ショートカットは、指す先の種類がクエリでは絞れないので一旦すべて取り、
    受け取ってから _item で振り分ける。マイドライブに共有フォルダの
    ショートカットを置いて使う人は多く、出さないとたどれなくなる。
    """
    if folders_only:
        wanted = [FOLDER_MIME]
    elif mime_types:
        wanted = [FOLDER_MIME, *mime_types]
    else:
        return ""
    terms = [f"mimeType = '{_escape_query_value(m)}'" for m in [*wanted, SHORTCUT_MIME]]
    return "(" + " or ".join(terms) + ")"


def _item(file: dict, mime_types: list[str], folders_only: bool) -> dict | None:
    """Drive の files の 1 件を画面に渡す形にする。選べないものは None。

    ショートカットは指す先として返す（選ばれた ID をそのまま開けるように）。
    """
    file_id = file.get("id")
    mime = file.get("mimeType", "")
    if mime == SHORTCUT_MIME:
        details = file.get("shortcutDetails") or {}
        file_id = details.get("targetId")
        mime = details.get("targetMimeType", "")
        if not file_id:
            return None
    is_folder = mime == FOLDER_MIME
    if folders_only and not is_folder:
        return None
    if mime_types and not is_folder and mime not in mime_types:
        return None
    return {
        "id": file_id,
        "name": file.get("name", ""),
        "mimeType": mime,
        "folder": is_folder,
        "modifiedTime": file.get("modifiedTime"),
    }


def _list_files(session, params: dict, mime_types, folders_only) -> dict:
    resp = session.get(
        _FILES_URL,
        params={
            "pageSize": str(PAGE_SIZE),
            "fields": _FILE_FIELDS,
            "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true",
            **params,
        },
    )
    _raise_for_status(resp, "Drive の一覧の取得")
    body = resp.json()
    items = []
    seen = set()
    for file in body.get("files", []):
        item = _item(file, mime_types, folders_only)
        # 同じものへのショートカットが並んでいると、選択肢が重複して見える。
        if item and item["id"] not in seen:
            seen.add(item["id"])
            items.append(item)
    return {"items": items, "nextPageToken": body.get("nextPageToken")}


def _list_shared_drives(session, page_token: str | None) -> dict:
    params = {"pageSize": str(PAGE_SIZE), "fields": "nextPageToken, drives(id, name)"}
    if page_token:
        params["pageToken"] = page_token
    resp = session.get(_DRIVES_URL, params=params)
    _raise_for_status(resp, "共有ドライブの一覧の取得")
    body = resp.json()
    # 共有ドライブの ID は、そのドライブの最上位フォルダの ID でもある
    # （中身は「'<ID>' in parents」で取れ、保存先としても指定できる）。
    items = [
        {
            "id": drive["id"],
            "name": drive.get("name", ""),
            "mimeType": FOLDER_MIME,
            "folder": True,
            "modifiedTime": None,
        }
        for drive in body.get("drives", [])
    ]
    return {"items": items, "nextPageToken": body.get("nextPageToken")}


def list_items(
    session,
    *,
    location: str | None = None,
    folder: str | None = None,
    query: str | None = None,
    mime_types: list[str] | None = None,
    folders_only: bool = False,
    page_token: str | None = None,
) -> dict:
    """フォルダの中身・検索結果・最初の場所（タブ）のどれか 1 つを返す。

    指定の優先順は folder → query → location。戻り値は
    {"items": [{id, name, mimeType, folder, modifiedTime}], "nextPageToken"}。
    """
    mime_types = mime_types or []
    query = (query or "").strip()
    if len(query) > MAX_QUERY_LENGTH:
        raise BrowseError("検索する文字が長すぎます。")

    if not folder and not query and location == "shared-drives":
        return _list_shared_drives(session, page_token)

    terms = ["trashed = false"]
    type_filter = _type_filter(mime_types, folders_only)
    if type_filter:
        terms.append(type_filter)
    params = {}
    if page_token:
        params["pageToken"] = page_token

    if folder:
        terms.insert(0, f"'{_escape_query_value(folder)}' in parents")
        # 共有ドライブの中も同じ書き方でたどれるよう、全ドライブを対象にする。
        params.update(corpora="allDrives", orderBy="folder,name_natural")
    elif query:
        terms.insert(0, f"name contains '{_escape_query_value(query)}'")
        params.update(corpora="allDrives", orderBy="folder,name_natural")
    elif location == "my-drive":
        terms.insert(0, "'root' in parents")
        params.update(orderBy="folder,name_natural")
    elif location == "recent":
        # 開いたことのあるものだけを、新しい順に（Drive の「最近使用したアイテム」）。
        terms.insert(0, "viewedByMeTime > '2000-01-01T00:00:00'")
        params.update(orderBy="viewedByMeTime desc")
    elif location == "shared-with-me":
        terms.insert(0, "sharedWithMe = true")
        params.update(orderBy="sharedWithMeTime desc")
    else:
        raise BrowseError("表示する場所の指定が正しくありません。")

    params["q"] = " and ".join(terms)
    return _list_files(session, params, mime_types, folders_only)
