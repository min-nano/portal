"""面材張り大壁 計算ツールの API テスト。

Drive・認証は conftest のフェイクに差し替え、ルートハンドラのロジック
（保存方法の切り替え・突き合わせ・PDF の読み戻し）を実際に通して検証する。
このツールは雛形を使わないので、共有設定は関わらない。

編集中の計算に API は使わない（画面が /core.wasm を受け取って手元で計算する）。
"""

import pytest

from app import nail_core, panel_shear
from tests.conftest import FOLDER_MIME, PDF_MIME, TEST_EMAIL

BASE = "/api/tools/timber-panel-shear-calculator"
CONFIG_URL = f"{BASE}/config"
CORE_URL = f"{BASE}/core.wasm"
REPORTS_URL = f"{BASE}/reports"
PARSE_URL = f"{BASE}/reports/parse"
PARSE_DRIVE_URL = f"{BASE}/reports/parse-drive"

EXAMPLE_PANEL = dict(panel_shear.EXAMPLE_PANEL, panelId="w1-p1")

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


def example_wall(**overrides):
    """グレー本 3.2 の計算例の面材を 1 枚張った壁（面材と釘は表 3.3.1 から）。"""
    wall = {
        **panel_shear.material(panel_shear.EXAMPLE_WALL_MATERIAL),
        **panel_shear.EXAMPLE_WALL,
        "wallId": "w1",
        "panels": [dict(EXAMPLE_PANEL)],
    }
    wall.update(overrides)
    return wall


def valid_body(**overrides):
    body = {
        "projectName": "○○邸 新築工事",
        "issuedOn": "2026-08-11",
        "walls": [example_wall()],
        "save": dict(NEW_SAVE),
    }
    body.update(overrides)
    return body


# --- 設定 --------------------------------------------------------------------


def test_config_carries_the_file_name_defaults(client):
    resp = client.get(CONFIG_URL)

    assert resp.status_code == 200
    body = resp.json()
    assert body["default_file_name"] == "釘配列諸定数計算書.pdf"
    assert body["file_name_template"] == panel_shear.FILE_NAME_TEMPLATE
    assert body["max_walls"] == nail_core.config()["maxWalls"]
    assert body["max_wall_panels"] == nail_core.config()["maxWallPanels"]
    assert body["default_edge_distance"] == nail_core.config()["defaultEdgeDistance"]


def test_config_points_at_the_calculation_core(client):
    """画面はここで知らされた URL から計算実装を受け取る。"""
    body = client.get(CONFIG_URL).json()

    assert body["core"]["version"] == nail_core.version()
    assert body["core"]["sha256"] == nail_core.sha256()
    # 中身が変わると URL も変わる（古い実装がキャッシュに残らない）。
    assert body["core"]["url"] == f"{CORE_URL}?v={nail_core.sha256()[:16]}"


def test_config_requires_auth(anon_client):
    assert anon_client.get(CONFIG_URL).status_code == 401


# --- 計算実装の配布 ----------------------------------------------------------


def test_core_wasm_is_the_same_bytes_the_server_calculates_with(client):
    resp = client.get(CORE_URL)

    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/wasm"
    assert resp.content == nail_core.wasm_bytes()
    assert resp.content.startswith(b"\x00asm")
    # URL にハッシュが付くので、中身が変わらないうちは取り直さなくてよい。
    assert "immutable" in resp.headers["cache-control"]


def test_core_wasm_requires_auth(anon_client):
    assert anon_client.get(CORE_URL).status_code == 401


def test_core_wasm_is_sent_gzipped_to_clients_that_accept_it(client):
    """画面が入力できるようになるまでの待ちに直接効くので、縮めて送る。

    この取得は「サインインの確認 → /config → wasm」という直列の並びの
    最後にあり、そのまま送ると 200 kB 超になる。
    """
    resp = client.get(CORE_URL, headers={"Accept-Encoding": "gzip"})

    assert resp.status_code == 200
    assert resp.headers["content-encoding"] == "gzip"
    # 同じ URL で符号化が 2 通りあることを、途中のキャッシュへ知らせる。
    assert resp.headers["vary"] == "Accept-Encoding"
    # 実際に縮んでいる（wasm は 1/3 以下になる）。
    assert int(resp.headers["content-length"]) < len(nail_core.wasm_bytes()) / 2
    # 受け取った側が展開すれば、サーバが計算に使うバイト列そのもの。
    assert resp.content == nail_core.wasm_bytes()


def test_core_wasm_is_sent_as_is_when_gzip_is_not_accepted(client):
    resp = client.get(CORE_URL, headers={"Accept-Encoding": "identity"})

    assert resp.status_code == 200
    assert "content-encoding" not in resp.headers
    assert resp.content == nail_core.wasm_bytes()


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


def screen_verification(body: dict, **overrides) -> dict:
    """画面が計算して送ってくる「私はこう計算した」を組み立てる。

    画面と同じ .wasm を同じ入力で回すので、これはそのまま「食い違いのない
    正常な保存」になる。
    """
    reports = panel_shear.compute_all(panel_shear.normalize_data(body))
    verify = {
        "coreVersion": nail_core.version(),
        "walls": [
            {"wallId": report["wallId"], "result": report["result"]}
            for report in reports["walls"]
            if report["ok"]
        ],
        # 釘配列諸定数（3.2）は壁の計算の一部なので、突き合わせも一緒に送る。
        "panels": [
            {"panelId": report["panelId"], "result": report["result"]}
            for report in panel_shear.panel_reports(reports)
        ],
    }
    verify.update(overrides)
    return verify


def test_save_confirms_the_numbers_the_screen_showed(client, folder):
    """編集中は画面が計算するので、保存時にサーバ側でも確かめる。"""
    body = valid_body()

    resp = client.post(REPORTS_URL, json={**body, "verify": screen_verification(body)})

    assert resp.status_code == 200
    assert resp.json()["verification"]["ok"] is True
    assert resp.json()["verification"]["checked"] is True


def test_save_warns_when_the_screen_and_the_server_disagree(client, folder):
    """食い違っても保存は止めない（計算書はサーバの値で作られる）。"""
    body = valid_body()
    verify = screen_verification(body)
    verify["panels"][0]["result"]["Cxy"] = 9.99

    resp = client.post(REPORTS_URL, json={**body, "verify": verify})

    assert resp.status_code == 200
    verification = resp.json()["verification"]
    assert verification["ok"] is False
    assert verification["differences"][0]["key"] == "Cxy"
    # 保存そのものは済んでいて、PDF にはサーバの値が載る。
    assert folder.created[0][2].startswith(b"%PDF-")


def test_save_without_a_verification_still_works(client, folder):
    """突き合わせの材料を送らない画面（古い版）でも保存できる。"""
    resp = client.post(REPORTS_URL, json=valid_body())

    assert resp.status_code == 200
    assert resp.json()["verification"] == {
        "checked": False,
        "ok": True,
        "differences": [],
    }


def test_created_report_can_be_read_back(client, folder):
    """保存した PDF が、そのまま入力の保存形式になっている。"""
    client.post(REPORTS_URL, json=valid_body())

    parsed = panel_shear.parse_pdf(folder.created[0][2])
    assert parsed["projectName"] == "○○邸 新築工事"
    assert parsed["walls"][0]["panels"][0]["nailPitch"] == 150


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


def test_save_rejects_a_wall_that_cannot_be_calculated(client, folder):
    """計算できない面材を含んだまま保存させない（名前で場所を伝える）。"""
    broken = example_wall(
        wallId="w2",
        wallName="南面",
        panels=[{"panelName": "下段", "width": 910, "height": 610, "nailPitch": 0}],
    )

    resp = client.post(REPORTS_URL, json=valid_body(walls=[example_wall(), broken]))

    assert resp.status_code == 400
    error = resp.json()["error"]
    assert "「南面」を計算できません" in error
    assert "面材「下段」" in error
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
    assert body["walls"][0]["panels"][0]["panelName"] == "グレー本の計算例"
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
    assert body["walls"][0]["panels"][0]["arrangement"] == "kawa"
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
    loaded["walls"][0]["panels"][0]["panelName"] = "南面 耐力壁"

    resp = client.post(
        REPORTS_URL,
        json={
            "projectName": loaded["projectName"],
            "issuedOn": loaded["issuedOn"],
            "walls": loaded["walls"],
            "save": {"mode": "overwrite", "fileId": loaded["file"]["id"]},
        },
    )

    assert resp.status_code == 200
    assert drive.updated[0][0] == "pdf-1"
    reparsed = panel_shear.parse_pdf(drive.updated[0][1])
    assert reparsed["walls"][0]["panels"][0]["panelName"] == "南面 耐力壁"
