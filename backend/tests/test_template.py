"""雛形設定 API（GET/PUT template, GET template/candidates）のテスト。

GAS 版の getTemplateStatus / saveTemplateSelection / Google Picker に相当する
機能。選択は Picker の代わりに、実行ユーザー代理の Drive 検索で行う。
"""

from tests.conftest import TEST_EMAIL, TOOL

TEMPLATE_URL = "/api/tools/excel-report-formatter/template"
CANDIDATES_URL = "/api/tools/excel-report-formatter/template/candidates"
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


# --- 状態の取得 -------------------------------------------------------------

def test_template_status_unconfigured(client, drive):
    resp = client.get(TEMPLATE_URL)

    assert resp.status_code == 200
    assert resp.json() == {"configured": False, "fileName": ""}


def test_template_status_configured(client, drive):
    drive.configure_template(file_name="IP_230901_11.xlsx")
    resp = client.get(TEMPLATE_URL)

    assert resp.status_code == 200
    assert resp.json() == {"configured": True, "fileName": "IP_230901_11.xlsx"}


# --- 雛形の保存 -------------------------------------------------------------

def test_save_template_records_folder_and_name(client, drive):
    drive.metadata["file-1"] = {
        "id": "file-1",
        "name": "IP_230901_11.xlsx",
        "mimeType": XLSX_MIME,
        "parents": ["folder-9"],
    }
    resp = client.put(TEMPLATE_URL, json={"fileId": "file-1"})

    assert resp.status_code == 200
    assert resp.json() == {"fileName": "IP_230901_11.xlsx", "folderId": "folder-9"}
    # 共有設定（GAS 版のスクリプトプロパティ相当）に保存される。
    assert drive.saved == [
        (TOOL, {"template_folder_id": "folder-9", "template_file_name": "IP_230901_11.xlsx"})
    ]


def test_save_template_without_file_id_returns_400(client, drive):
    resp = client.put(TEMPLATE_URL, json={})

    assert resp.status_code == 400
    assert "選択されていません" in resp.json()["error"]


def test_save_template_rejects_non_xlsx(client, drive):
    # Google スプレッドシート等はエクスポート形式が変わり openpyxl が読めない。
    drive.metadata["sheet-1"] = {
        "id": "sheet-1",
        "name": "スプレッドシート",
        "mimeType": "application/vnd.google-apps.spreadsheet",
        "parents": ["folder-9"],
    }
    resp = client.put(TEMPLATE_URL, json={"fileId": "sheet-1"})

    assert resp.status_code == 400
    assert ".xlsx" in resp.json()["error"]
    assert drive.saved == []


def test_save_template_rejects_file_without_parent(client, drive):
    resp_meta = {
        "id": "file-2",
        "name": "orphan.xlsx",
        "mimeType": XLSX_MIME,
        "parents": [],
    }
    drive.metadata["file-2"] = resp_meta
    resp = client.put(TEMPLATE_URL, json={"fileId": "file-2"})

    assert resp.status_code == 400
    assert "親フォルダ" in resp.json()["error"]


def test_save_template_rejects_trashed_file(client, drive):
    drive.metadata["file-3"] = {
        "id": "file-3",
        "name": "old.xlsx",
        "mimeType": XLSX_MIME,
        "parents": ["folder-9"],
        "trashed": True,
    }
    resp = client.put(TEMPLATE_URL, json={"fileId": "file-3"})

    assert resp.status_code == 400
    assert "ゴミ箱" in resp.json()["error"]


def test_save_template_unknown_file_returns_404(client, drive):
    resp = client.put(TEMPLATE_URL, json={"fileId": "no-such-file"})

    assert resp.status_code == 404


# --- 候補検索 ---------------------------------------------------------------

def test_candidates_search_uses_delegated_session(client, drive):
    drive.search_results = [
        {"id": "f1", "name": "IP_230901_11.xlsx", "modifiedTime": "2026-01-01T00:00:00Z"},
        {"id": "f2", "name": "IP_230901_10.xlsx", "modifiedTime": "2025-06-01T00:00:00Z"},
    ]
    resp = client.get(CANDIDATES_URL, params={"q": "IP_"})

    assert resp.status_code == 200
    files = resp.json()["files"]
    assert [f["id"] for f in files] == ["f1", "f2"]
    # 検索は実行ユーザーの代理セッションで行われる（本人に見えるファイルだけが候補になる）。
    assert drive.delegated_emails == [TEST_EMAIL]


def test_candidates_with_empty_query_returns_empty_list(client, drive):
    resp = client.get(CANDIDATES_URL, params={"q": "  "})

    assert resp.status_code == 200
    assert resp.json() == {"files": []}
    assert drive.delegated_emails == []
