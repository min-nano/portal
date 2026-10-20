"""ファイル選択ダイアログに出す一覧（GET /api/drive/items）のテスト。

Drive の中をたどる画面はポータル側で描き、一覧だけをバックエンドが本人の
代理で取る。Drive API は偽物のセッションに差し替え、組み立てたクエリと、
画面へ返す形（ショートカットの解決・種類の絞り込み）を確かめる。
"""

import pytest

from app import drive_browser, google_drive
from tests.conftest import FOLDER_MIME, PDF_MIME, TEST_EMAIL

ITEMS_URL = "/api/drive/items"
SHORTCUT_MIME = "application/vnd.google-apps.shortcut"
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


class FakeResponse:
    def __init__(self, payload, status_code=200):
        self.status_code = status_code
        self.ok = 200 <= status_code < 300
        self._payload = payload

    def json(self):
        return self._payload


class FakeSession:
    """Drive API の代役。受け取った URL と引数を記録し、決めた応答を返す。"""

    def __init__(self, payload=None, status_code=200):
        self.payload = payload if payload is not None else {"files": []}
        self.status_code = status_code
        self.calls = []

    def get(self, url, params=None):
        self.calls.append((url, params))
        return FakeResponse(self.payload, self.status_code)

    @property
    def params(self):
        return self.calls[-1][1]


def files(*entries):
    return {"files": list(entries)}


# --- 場所ごとのクエリ --------------------------------------------------------

def test_folder_lists_its_children_across_all_drives():
    session = FakeSession()

    drive_browser.list_items(session, folder="folder-1")

    params = session.params
    assert params["q"] == "'folder-1' in parents and trashed = false"
    # 共有ドライブの中のフォルダも同じ書き方でたどれるように。
    assert params["corpora"] == "allDrives"
    assert params["supportsAllDrives"] == "true"
    assert params["includeItemsFromAllDrives"] == "true"
    # フォルダを先に、名前の順に並べる（Drive 本体と同じ見え方）。
    assert params["orderBy"] == "folder,name_natural"


def test_my_drive_starts_at_the_root():
    session = FakeSession()

    drive_browser.list_items(session, location="my-drive")

    assert session.params["q"].startswith("'root' in parents and ")


def test_recent_lists_viewed_items_newest_first():
    session = FakeSession()

    drive_browser.list_items(session, location="recent")

    assert session.params["q"].startswith("viewedByMeTime > ")
    assert session.params["orderBy"] == "viewedByMeTime desc"


def test_shared_with_me_lists_newest_shares_first():
    session = FakeSession()

    drive_browser.list_items(session, location="shared-with-me")

    assert session.params["q"].startswith("sharedWithMe = true and ")
    assert session.params["orderBy"] == "sharedWithMeTime desc"


def test_shared_drives_are_returned_as_folders():
    session = FakeSession(
        {"drives": [{"id": "drive-1", "name": "設計部"}], "nextPageToken": "next"}
    )

    result = drive_browser.list_items(session, location="shared-drives")

    assert session.calls[-1][0].endswith("/drives")
    # 共有ドライブの ID は、そのまま最上位フォルダの ID として使える。
    assert result == {
        "items": [
            {
                "id": "drive-1",
                "name": "設計部",
                "mimeType": FOLDER_MIME,
                "folder": True,
                "modifiedTime": None,
            }
        ],
        "nextPageToken": "next",
        "incomplete": False,
    }


def test_search_matches_names_across_all_drives():
    session = FakeSession()

    drive_browser.list_items(session, location="my-drive", query=" 証明書 ")

    # 検索語があれば、開いているタブに関係なく全体から探す。名前の途中の文字でも
    # 見つかるよう、全文検索（fullText）も併せる（name contains は先頭一致）。
    assert session.params["q"] == (
        "(name contains '証明書' or fullText contains '証明書') and trashed = false"
    )
    assert session.params["corpora"] == "allDrives"
    # fullText を含むクエリは並べ替えを指定できない（Drive が 400 を返す）。
    assert "orderBy" not in session.params


def test_folder_takes_precedence_over_search_and_location():
    session = FakeSession()

    drive_browser.list_items(session, location="recent", folder="f", query="x")

    assert session.params["q"].startswith("'f' in parents and ")


def test_quotes_in_ids_and_queries_are_escaped():
    session = FakeSession()

    drive_browser.list_items(session, query="it's")

    assert "name contains 'it\\'s' or fullText contains 'it\\'s'" in session.params["q"]


def test_page_token_is_passed_through():
    session = FakeSession()

    drive_browser.list_items(session, folder="f", page_token="token-2")

    assert session.params["pageToken"] == "token-2"


def test_unknown_location_is_rejected():
    with pytest.raises(drive_browser.BrowseError) as excinfo:
        drive_browser.list_items(FakeSession(), location="trash")

    assert excinfo.value.status == 400


def test_overlong_search_is_rejected():
    with pytest.raises(drive_browser.BrowseError):
        drive_browser.list_items(FakeSession(), query="あ" * 201)


# --- 種類の絞り込み ----------------------------------------------------------

def test_mime_filter_keeps_folders_and_shortcuts_in_the_query():
    session = FakeSession()

    drive_browser.list_items(session, folder="f", mime_types=[PDF_MIME])

    q = session.params["q"]
    assert f"mimeType = '{FOLDER_MIME}'" in q
    assert f"mimeType = '{PDF_MIME}'" in q
    assert f"mimeType = '{SHORTCUT_MIME}'" in q


def test_without_a_filter_everything_is_listed():
    session = FakeSession()

    drive_browser.list_items(session, folder="f")

    assert "mimeType" not in session.params["q"]


def test_folders_only_asks_for_folders():
    session = FakeSession()

    drive_browser.list_items(
        session, folder="f", mime_types=[PDF_MIME], folders_only=True
    )

    q = session.params["q"]
    assert f"mimeType = '{FOLDER_MIME}'" in q
    assert PDF_MIME not in q


def test_items_are_returned_in_the_shape_the_dialog_uses():
    session = FakeSession(
        {
            **files(
                {"id": "d", "name": "図面", "mimeType": FOLDER_MIME},
                {
                    "id": "p",
                    "name": "証明書.pdf",
                    "mimeType": PDF_MIME,
                    "modifiedTime": "2026-10-01T00:00:00Z",
                },
            ),
            "nextPageToken": "more",
        }
    )

    result = drive_browser.list_items(session, folder="f", mime_types=[PDF_MIME])

    assert result == {
        "items": [
            {
                "id": "d",
                "name": "図面",
                "mimeType": FOLDER_MIME,
                "folder": True,
                "modifiedTime": None,
            },
            {
                "id": "p",
                "name": "証明書.pdf",
                "mimeType": PDF_MIME,
                "folder": False,
                "modifiedTime": "2026-10-01T00:00:00Z",
            },
        ],
        "nextPageToken": "more",
        "incomplete": False,
    }


def test_shortcuts_resolve_to_their_targets():
    session = FakeSession(
        files(
            {
                "id": "shortcut-1",
                "name": "共有の図面",
                "mimeType": SHORTCUT_MIME,
                "shortcutDetails": {"targetId": "real-1", "targetMimeType": FOLDER_MIME},
            }
        )
    )

    [item] = drive_browser.list_items(session, folder="f")["items"]

    # 選ばれた ID をそのまま開けるよう、指す先の ID と種類で返す。
    assert item["id"] == "real-1"
    assert item["folder"] is True
    assert item["name"] == "共有の図面"


def test_shortcuts_to_other_types_are_filtered_out():
    session = FakeSession(
        files(
            {
                "id": "s",
                "name": "表",
                "mimeType": SHORTCUT_MIME,
                "shortcutDetails": {"targetId": "x", "targetMimeType": XLSX_MIME},
            },
            {
                "id": "s2",
                "name": "壊れたショートカット",
                "mimeType": SHORTCUT_MIME,
                "shortcutDetails": {},
            },
        )
    )

    assert drive_browser.list_items(session, folder="f", mime_types=[PDF_MIME])["items"] == []


def test_incomplete_searches_are_reported():
    # 共有ドライブをまたぐ検索で、Drive が一部のドライブを探さずに返したとき。
    session = FakeSession({**files(), "incompleteSearch": True})

    result = drive_browser.list_items(session, query="図面")

    assert result["incomplete"] is True


def test_complete_listings_are_not_marked_incomplete():
    assert drive_browser.list_items(FakeSession(), folder="f")["incomplete"] is False
    session = FakeSession({"drives": []})
    assert drive_browser.list_items(session, location="shared-drives")["incomplete"] is False


def test_folders_only_drops_files_returned_by_drive():
    session = FakeSession(
        files(
            {"id": "d", "name": "フォルダ", "mimeType": FOLDER_MIME},
            {"id": "p", "name": "a.pdf", "mimeType": PDF_MIME},
        )
    )

    items = drive_browser.list_items(session, folder="f", folders_only=True)["items"]

    assert [item["id"] for item in items] == ["d"]


@pytest.mark.parametrize("value", ["application/pdf'", "pdf", "a/b or 1=1"])
def test_malformed_mime_types_are_rejected(value):
    with pytest.raises(drive_browser.BrowseError):
        drive_browser.parse_mime_types(value)


def test_mime_types_are_split_on_commas():
    assert drive_browser.parse_mime_types(f"{PDF_MIME}, {XLSX_MIME},") == [
        PDF_MIME,
        XLSX_MIME,
    ]


def test_drive_errors_are_reported_with_googles_reason():
    session = FakeSession({"error": {"message": "Insufficient Permission"}}, 403)

    with pytest.raises(google_drive.DriveError) as excinfo:
        drive_browser.list_items(session, folder="f")

    assert "Insufficient Permission" in str(excinfo.value)


# --- エンドポイント ----------------------------------------------------------

@pytest.fixture
def session(drive, monkeypatch):
    fake = FakeSession(files({"id": "p", "name": "a.pdf", "mimeType": PDF_MIME}))
    emails = []

    def delegated_session(email):
        emails.append(email)
        return fake

    monkeypatch.setattr(google_drive, "delegated_session", delegated_session)
    fake.emails = emails
    return fake


def test_endpoint_lists_with_the_signed_in_users_access(client, session):
    resp = client.get(
        ITEMS_URL, params={"folder": "f", "mimeTypes": PDF_MIME, "pageToken": "t"}
    )

    assert resp.status_code == 200
    assert resp.json()["items"][0]["id"] == "p"
    # 一覧は、アクセスしている本人の権限で取る。
    assert session.emails == [TEST_EMAIL]
    assert session.params["pageToken"] == "t"
    assert PDF_MIME in session.params["q"]


def test_endpoint_passes_folders_only(client, session):
    client.get(ITEMS_URL, params={"location": "my-drive", "foldersOnly": "true"})

    assert PDF_MIME not in session.params["q"]
    assert FOLDER_MIME in session.params["q"]


def test_endpoint_reports_bad_input_as_400(client, session):
    resp = client.get(ITEMS_URL, params={"location": "nowhere"})

    assert resp.status_code == 400
    assert "場所" in resp.json()["error"]


def test_endpoint_requires_auth(anon_client):
    assert anon_client.get(ITEMS_URL, params={"location": "my-drive"}).status_code == 401


def test_picker_token_endpoint_is_gone(client, session):
    # 以前の Google Picker 用の口（ブラウザへアクセストークンを渡していた）は無い。
    assert client.get("/api/picker/token").status_code == 404
    assert client.get("/api/picker/config").status_code == 404
