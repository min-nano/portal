"""見積書 作成ツールの API テスト。

Drive・共有設定・認証は conftest のフェイクに差し替え、ルートハンドラの
ロジック（設定の読み書き・保存方法の切り替え・突き合わせ・PDF の読み戻し）を
実際に通して検証する。

編集中の計算に API は使わない（画面が /core.wasm を受け取って手元で計算する）。

**このファイルに実在の氏名・住所・金額は出てこない。**
"""

import pytest

from app import nail_core
from tests.conftest import FOLDER_MIME, PDF_MIME, TEST_EMAIL

BASE = "/api/tools/quotation-formatter"
CONFIG_URL = f"{BASE}/config"
CORE_URL = f"{BASE}/core.wasm"
SETTINGS_URL = f"{BASE}/settings"
QUOTATIONS_URL = f"{BASE}/quotations"
PARSE_URL = f"{BASE}/quotations/parse"
PARSE_DRIVE_URL = f"{BASE}/quotations/parse-drive"

TOOL = "quotation-formatter"

# 新規保存の保存先は、そのつど画面の Picker で選ばれたフォルダが送られてくる。
NEW_SAVE = {"mode": "new", "folderId": "out-folder"}


@pytest.fixture
def folder(drive):
    """Picker で選ばれたことにする保存先フォルダ。"""
    drive.metadata["out-folder"] = {
        "id": "out-folder",
        "name": "見積書",
        "mimeType": FOLDER_MIME,
    }
    return drive


def valid_body(**overrides):
    body = {
        "number": "20260099",
        "issuedOn": "2026-08-17",
        "expiresOn": "2026-09-30",
        "subject": "架空邸 構造設計業務",
        "client": {"name": "架空建築設計事務所", "honorific": "御中"},
        "issuer": {"name": "架空 二級建築士事務所"},
        "items": [
            {
                "templateId": "structural-design",
                "title": "新築木造軸組建築物の構造計算及び構造図作成",
                "body": "2階建て、構造床面積約238㎡",
                "unitPrice": 284000,
                "quantity": 1,
            }
        ],
        "save": dict(NEW_SAVE),
    }
    body.update(overrides)
    return body


# --- フォーム定義と計算実装 --------------------------------------------------


def test_the_config_publishes_the_templates_and_the_core(client):
    body = client.get(CONFIG_URL).json()
    ids = [template["id"] for template in body["templates"]]
    assert "structural-design" in ids
    assert "seismic-diagnosis" in ids
    assert body["core"]["sha256"] == nail_core.sha256()


def test_the_screen_gets_the_same_wasm_the_server_computes_with(client):
    response = client.get(CORE_URL)
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/wasm"


def test_signing_in_is_required(anon_client):
    for url in (CONFIG_URL, SETTINGS_URL):
        assert anon_client.get(url).status_code == 401
    assert anon_client.post(QUOTATIONS_URL, json=valid_body()).status_code == 401


# --- 共有設定 ----------------------------------------------------------------


def test_the_settings_start_empty_so_the_repository_holds_no_office_values(client):
    body = client.get(SETTINGS_URL).json()
    assert body["office"]["name"] == ""
    assert body["terms"] == {"design": "", "seismic": ""}
    assert body["fee"]["personnelUnitPrice"] == 0
    # 法定の税率と、告示第670号の標準の倍数だけが既定を持つ。
    assert body["fee"]["taxRate"] == 10.0
    assert body["fee"]["overheadMultiplier"] == 1.0


def test_the_settings_round_trip_through_firestore(client, drive):
    saved = client.put(
        SETTINGS_URL,
        json={
            "office": {"name": "架空 二級建築士事務所", "tel": "000-0000-0000"},
            "terms": {"design": "設計の但し書き"},
            "fee": {"personnelUnitPrice": 8000, "technicalFeeRate": 10},
            "ignored": "捨てられる",
        },
    ).json()
    assert saved["office"]["name"] == "架空 二級建築士事務所"
    assert "ignored" not in saved
    assert drive.settings[TOOL]["fee"]["personnelUnitPrice"] == 8000
    assert client.get(SETTINGS_URL).json() == saved


# --- 見積書の作成 ------------------------------------------------------------


def test_a_quotation_is_written_to_the_chosen_folder(client, folder):
    response = client.post(QUOTATIONS_URL, json=valid_body())
    assert response.status_code == 200
    body = response.json()
    assert body["mode"] == "new"
    assert body["fileId"] == "new-file"

    folder_id, name, content, mime = folder.created[0]
    assert folder_id == "out-folder"
    assert mime == PDF_MIME
    assert content.startswith(b"%PDF-")
    # 電子帳簿保存法の検索要件に備えた既定のファイル名。
    assert name == "20260817_架空建築設計事務所_312400.pdf"
    # Drive を触るのは、常に実行ユーザー本人の代理。
    assert folder.write_emails == [TEST_EMAIL]


def test_the_file_name_from_the_save_dialog_wins(client, folder):
    body = valid_body(save={**NEW_SAVE, "fileName": "架空邸 見積書"})
    client.post(QUOTATIONS_URL, json=body)
    assert folder.created[0][1] == "架空邸 見積書.pdf"


def test_overwriting_replaces_the_file_being_edited(client, drive):
    drive.metadata["quote-1"] = {
        "id": "quote-1",
        "name": "見積書.pdf",
        "mimeType": PDF_MIME,
    }
    response = client.post(
        QUOTATIONS_URL,
        json=valid_body(save={"mode": "overwrite", "fileId": "quote-1"}),
    )
    assert response.status_code == 200
    assert response.json()["mode"] == "overwrite"
    assert drive.updated[0][0] == "quote-1"
    assert drive.created == []


def test_only_a_pdf_can_be_overwritten(client, drive):
    drive.metadata["a-folder"] = {"id": "a-folder", "mimeType": FOLDER_MIME}
    response = client.post(
        QUOTATIONS_URL,
        json=valid_body(save={"mode": "overwrite", "fileId": "a-folder"}),
    )
    assert response.status_code == 400
    assert "PDF" in response.json()["error"]


def test_a_quotation_missing_its_essentials_is_refused_before_saving(client, folder):
    response = client.post(QUOTATIONS_URL, json=valid_body(number=""))
    assert response.status_code == 400
    assert "見積書番号" in response.json()["error"]
    assert folder.created == []


def test_the_servers_amount_is_compared_with_the_screens(client, folder):
    body = valid_body(
        verify={
            "coreVersion": nail_core.version(),
            "totals": {"subtotal": 284000, "tax": 28400, "total": 312400},
        }
    )
    verification = client.post(QUOTATIONS_URL, json=body).json()["verification"]
    assert verification["checked"] is True
    assert verification["ok"] is True


def test_a_disagreement_is_reported_without_blocking_the_save(client, folder):
    body = valid_body(
        verify={
            "coreVersion": nail_core.version(),
            "totals": {"subtotal": 1, "tax": 1, "total": 1},
        }
    )
    response = client.post(QUOTATIONS_URL, json=body)
    assert response.status_code == 200
    assert response.json()["verification"]["ok"] is False
    # 食い違っていても保存は済んでいる（PDF に載るのはサーバの値）。
    assert folder.created


def test_warnings_come_back_without_blocking_the_save(client, folder):
    response = client.post(QUOTATIONS_URL, json=valid_body(subject=""))
    assert response.status_code == 200
    assert "件名が未入力です。" in response.json()["warnings"]


# --- 読み込み（再編集） ------------------------------------------------------


def created_pdf(client, folder, **overrides):
    client.post(QUOTATIONS_URL, json=valid_body(**overrides))
    return folder.created[-1][2]


def test_a_saved_quotation_can_be_opened_from_drive(client, folder, drive):
    pdf = created_pdf(client, folder)
    drive.metadata["quote-1"] = {
        "id": "quote-1",
        "name": "見積書.pdf",
        "mimeType": PDF_MIME,
    }
    drive.download_bytes = pdf

    body = client.post(PARSE_DRIVE_URL, json={"fileId": "quote-1"}).json()
    assert body["file"] == {"id": "quote-1", "name": "見積書.pdf"}
    assert body["data"]["number"] == "20260099"
    assert body["data"]["items"][0]["unitPrice"] == 284000


def test_a_quotation_from_the_desktop_can_be_opened_but_not_overwritten(
    client, folder
):
    pdf = created_pdf(client, folder)
    response = client.post(
        PARSE_URL, files={"file": ("見積書.pdf", pdf, PDF_MIME)}
    )
    body = response.json()
    assert body["data"]["subject"] == "架空邸 構造設計業務"
    # 手元の PDF は Drive 上のファイルではないので、上書き先にできない。
    assert body["file"]["id"] == ""


def test_a_pdf_from_another_tool_is_refused(client):
    response = client.post(
        PARSE_URL,
        files={"file": ("x.pdf", "%PDF-1.4\n何か別のもの".encode("utf-8"), PDF_MIME)},
    )
    assert response.status_code == 400
    assert "このツールで作成した見積書 PDF ではない" in response.json()["error"]


# --- 耐震診断・耐震補強設計 --------------------------------------------------


def test_a_seismic_quotation_can_be_written(client, folder):
    """耐震診断と耐震補強設計を 1 通に並べられる。"""
    body = valid_body(
        subject="架空邸 耐震診断・耐震補強設計業務",
        items=[
            {
                "templateId": "seismic-diagnosis",
                "title": "木造住宅の耐震診断",
                "body": "2階建て、延べ面積約120㎡\n一般診断法により耐震診断を行います。",
                "unitPrice": 250000,
            },
            {
                "templateId": "seismic-retrofit-design",
                "title": "木造住宅の耐震補強設計",
                "body": "一般診断法による耐震診断の結果に基づき、耐震補強設計を行います。",
                "unitPrice": 300000,
            },
            {
                "templateId": "other",
                "title": "判定委員会 申込手数料（立替）",
                "unitPrice": 33000,
                "taxCategory": "exempt",
            },
        ],
    )
    response = client.post(QUOTATIONS_URL, json=body)
    assert response.status_code == 200
    # 550,000 の 10% と、対象外の 33,000。
    assert folder.created[-1][1].endswith("_638000.pdf")
