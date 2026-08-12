"""面材張り耐力要素 釘配列諸定数 計算ツールの API テスト。

Drive・認証は conftest のフェイクに差し替え、ルートハンドラのロジック
（計算・保存方法の切り替え・PDF の読み戻し）を実際に通して検証する。
このツールは雛形を使わないので、共有設定は関わらない。
"""

import pytest

from app import panel_shear
from tests.conftest import FOLDER_MIME, PDF_MIME, TEST_EMAIL

BASE = "/api/tools/timber-panel-shear-calculator"
CONFIG_URL = f"{BASE}/config"
CALCULATIONS_URL = f"{BASE}/calculations"
REPORTS_URL = f"{BASE}/reports"
PARSE_URL = f"{BASE}/reports/parse"
PARSE_DRIVE_URL = f"{BASE}/reports/parse-drive"

EXAMPLE = dict(panel_shear.EXAMPLE_PATTERN, patternId="p1")

# 新規保存の保存先は、そのつど画面の Picker で選ばれたフォルダが送られてくる。
NEW_SAVE = {"mode": "new", "folderId": "out-folder"}


@pytest.fixture
def folder(drive):
    """Picker で選ばれたことにする保存先フォルダ。"""
    drive.metadata["out-folder"] = {
        "id": "out-folder",
        "name": "計算書",
        "mimeType": FOLDER_MIME,
    }
    return drive


def valid_body(**overrides):
    body = {
        "projectName": "○○邸 新築工事",
        "issuedOn": "2026-08-11",
        "patterns": [dict(EXAMPLE)],
        "save": dict(NEW_SAVE),
    }
    body.update(overrides)
    return body


# --- 設定 --------------------------------------------------------------------


def test_config_carries_the_reference_example(client):
    resp = client.get(CONFIG_URL)

    assert resp.status_code == 200
    body = resp.json()
    assert body["default_file_name"] == "釘配列諸定数計算書.pdf"
    # 画面の「グレー本の計算例を読み込む」はサーバ側の定義を使う。
    assert body["example"]["gridX"] == "0, 445, 890"


def test_config_requires_auth(anon_client):
    assert anon_client.get(CONFIG_URL).status_code == 401


# --- 計算（画面の逐次表示） --------------------------------------------------


def test_calculations_return_the_reference_values(client):
    resp = client.post(CALCULATIONS_URL, json=valid_body())

    assert resp.status_code == 200
    pattern = resp.json()["patterns"][0]
    assert pattern["ok"] is True
    assert {row["key"]: row["value"] for row in pattern["summary"]} == {
        "Ixy": "0.888868",
        "Zxy": "0.00358851",
        "Cxy": "1.26155",
    }
    # 釘座標もサーバが組み立てて返す（画面の配列図はこれを描く）。
    assert len(pattern["nails"]) == 15


def test_calculations_report_a_broken_pattern_per_pattern(client):
    """入力途中の不備で、他のパターンの結果まで消さない。"""
    body = valid_body(patterns=[dict(EXAMPLE), {"patternId": "p2", "width": 610}])

    resp = client.post(CALCULATIONS_URL, json=body)

    assert resp.status_code == 200
    patterns = resp.json()["patterns"]
    assert patterns[0]["ok"] is True
    assert patterns[1]["ok"] is False
    assert patterns[1]["error"]


def test_calculations_reject_a_non_numeric_dimension(client):
    resp = client.post(CALCULATIONS_URL, json={"patterns": [{"width": "ろく"}]})

    assert resp.status_code == 400
    assert "面材の幅 W" in resp.json()["error"]


# --- 保存 --------------------------------------------------------------------


def test_create_report_saves_a_pdf_to_the_chosen_folder(client, folder):
    resp = client.post(REPORTS_URL, json=valid_body())

    assert resp.status_code == 200
    body = resp.json()
    assert body["mode"] == "new"
    assert body["fileId"] == "new-file"

    folder_id, name, content, mime = folder.created[0]
    assert (folder_id, name, mime) == (
        "out-folder",
        "釘配列諸定数計算書_○○邸 新築工事.pdf",
        PDF_MIME,
    )
    assert content.startswith(b"%PDF-")
    # 書き込みは実行ユーザーの代理で行う。
    assert folder.write_emails == [TEST_EMAIL]


def test_create_report_honours_an_explicit_file_name(client, folder):
    resp = client.post(
        REPORTS_URL, json=valid_body(save={**NEW_SAVE, "fileName": "南面の計算書"})
    )

    assert resp.status_code == 200
    assert folder.created[0][1] == "南面の計算書.pdf"


def test_created_report_can_be_read_back(client, folder):
    """保存した PDF が、そのまま入力の保存形式になっている。"""
    client.post(REPORTS_URL, json=valid_body())

    parsed = panel_shear.parse_pdf(folder.created[0][2])
    assert parsed["projectName"] == "○○邸 新築工事"
    assert parsed["patterns"][0]["gridY"] == "0, 145, 295, 445, 590"


def test_create_report_overwrites_with_version_history(client, drive):
    drive.metadata["old-pdf"] = {
        "id": "old-pdf",
        "name": "釘配列諸定数計算書.pdf",
        "mimeType": PDF_MIME,
    }

    resp = client.post(
        REPORTS_URL, json=valid_body(save={"mode": "overwrite", "fileId": "old-pdf"})
    )

    assert resp.status_code == 200
    assert resp.json()["mode"] == "overwrite"
    # 上書きは「同じファイルの内容差し替え」。Drive が新しいリビジョンを作る
    # ため、直前の内容は版履歴から復元できる。
    file_id, content, mime = drive.updated[0]
    assert (file_id, mime) == ("old-pdf", PDF_MIME)
    assert content.startswith(b"%PDF-")
    assert drive.created == []


def test_overwrite_rejects_a_non_pdf_target(client, drive):
    drive.metadata["a-sheet"] = {
        "id": "a-sheet",
        "name": "表",
        "mimeType": "application/vnd.google-apps.spreadsheet",
    }

    resp = client.post(
        REPORTS_URL, json=valid_body(save={"mode": "overwrite", "fileId": "a-sheet"})
    )

    assert resp.status_code == 400
    assert "PDF" in resp.json()["error"]
    assert drive.updated == []


def test_save_without_a_destination_folder_returns_400(client, drive):
    resp = client.post(REPORTS_URL, json=valid_body(save={"mode": "new"}))

    assert resp.status_code == 400
    assert "フォルダ" in resp.json()["error"]
    assert drive.created == []


def test_save_rejects_a_destination_that_is_not_a_folder(client, drive):
    drive.metadata["a-pdf"] = {"id": "a-pdf", "name": "既存", "mimeType": PDF_MIME}

    resp = client.post(
        REPORTS_URL, json=valid_body(save={"mode": "new", "folderId": "a-pdf"})
    )

    assert resp.status_code == 400
    assert "フォルダ" in resp.json()["error"]


def test_save_rejects_a_pattern_that_cannot_be_calculated(client, folder):
    """計算できないパターンを含んだまま保存させない（名前で場所を伝える）。"""
    broken = {"patternId": "p2", "patternName": "南面", "width": 610, "height": 910}

    resp = client.post(REPORTS_URL, json=valid_body(patterns=[dict(EXAMPLE), broken]))

    assert resp.status_code == 400
    assert "「南面」を計算できません" in resp.json()["error"]
    assert folder.created == []


def test_create_report_requires_auth(anon_client):
    assert anon_client.post(REPORTS_URL, json=valid_body()).status_code == 401


# --- 読み込み ----------------------------------------------------------------


def make_report_pdf(**overrides) -> bytes:
    data = panel_shear.normalize_data(valid_body(**overrides))
    return panel_shear.build_pdf(data, panel_shear.validate(data))


def test_parse_uploaded_report_restores_the_form(client):
    resp = client.post(
        PARSE_URL,
        files={"file": ("計算書.pdf", make_report_pdf(), "application/pdf")},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["projectName"] == "○○邸 新築工事"
    assert body["patterns"][0]["patternName"] == "グレー本の計算例"
    # アップロードした PDF は Drive 上のファイルではないので上書き先にできない。
    assert body["file"]["id"] == ""


def test_parse_uploaded_report_rejects_another_tools_pdf(client):
    from app import pdf_write

    document = pdf_write.Document()
    document.add_page().text(50, 700, "無関係な PDF", 10)

    resp = client.post(
        PARSE_URL,
        files={"file": ("他.pdf", document.to_bytes(), "application/pdf")},
    )

    assert resp.status_code == 400
    assert "このツールで作成した" in resp.json()["error"]


def test_parse_drive_report_returns_the_overwrite_target(client, drive):
    drive.metadata["pdf-1"] = {
        "id": "pdf-1",
        "name": "釘配列諸定数計算書.pdf",
        "mimeType": PDF_MIME,
    }
    drive.download_bytes = make_report_pdf()

    resp = client.post(PARSE_DRIVE_URL, json={"fileId": "pdf-1"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["file"] == {"id": "pdf-1", "name": "釘配列諸定数計算書.pdf"}
    assert body["patterns"][0]["gridX"] == "0, 445, 890"
    # 読み込みは読み取り専用の代理で足りる。
    assert drive.delegated_emails == [TEST_EMAIL]
    assert drive.write_emails == []


def test_parse_drive_report_rejects_a_non_pdf(client, drive):
    drive.metadata["a-doc"] = {
        "id": "a-doc",
        "name": "文書",
        "mimeType": "application/vnd.google-apps.document",
    }

    resp = client.post(PARSE_DRIVE_URL, json={"fileId": "a-doc"})

    assert resp.status_code == 400
    assert "PDF" in resp.json()["error"]


def test_edit_round_trip_overwrites_the_source_file(client, drive):
    """開く → 直す → 上書き保存、という一巡が成り立つこと。"""
    drive.metadata["pdf-1"] = {
        "id": "pdf-1",
        "name": "釘配列諸定数計算書.pdf",
        "mimeType": PDF_MIME,
    }
    drive.download_bytes = make_report_pdf()

    loaded = client.post(PARSE_DRIVE_URL, json={"fileId": "pdf-1"}).json()
    loaded["patterns"][0]["patternName"] = "南面 耐力壁"

    resp = client.post(
        REPORTS_URL,
        json={
            "projectName": loaded["projectName"],
            "issuedOn": loaded["issuedOn"],
            "patterns": loaded["patterns"],
            "save": {"mode": "overwrite", "fileId": loaded["file"]["id"]},
        },
    )

    assert resp.status_code == 200
    assert drive.updated[0][0] == "pdf-1"
    reparsed = panel_shear.parse_pdf(drive.updated[0][1])
    assert reparsed["patterns"][0]["patternName"] == "南面 耐力壁"
