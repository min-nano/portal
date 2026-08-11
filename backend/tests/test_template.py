"""雛形設定 API（GET/PUT template）のテスト。

GAS 版の getTemplateStatus / saveTemplateSelection に相当する機能。ファイルを
選ぶ操作はブラウザ側の公式 Google Picker が担い、ここには選ばれたファイル ID
だけが届く。そのため、種類・ゴミ箱・親フォルダの確認はすべてこちら側で行う。
"""

from tests.conftest import TEST_EMAIL, TOOL

TEMPLATE_URL = "/api/tools/excel-report-formatter/template"
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


def test_save_template_reads_the_file_as_the_signed_in_user(client, drive):
    """Picker から届くのはファイル ID だけなので、確認もサーバー側で行う。

    メタデータの取得は実行ユーザーの代理セッションで行うため、本人に閲覧権限の
    無いファイル ID を送りつけても雛形には設定できない（GAS 版と同じ境界）。
    """
    drive.metadata["file-1"] = {
        "id": "file-1",
        "name": "IP_230901_11.xlsx",
        "mimeType": XLSX_MIME,
        "parents": ["folder-9"],
    }
    resp = client.put(TEMPLATE_URL, json={"fileId": "file-1"})

    assert resp.status_code == 200
    assert drive.delegated_emails == [TEST_EMAIL]
