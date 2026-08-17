"""構造計算安全証明書 作成ツールの API テスト。

Drive・Docs・共有設定・認証は conftest のフェイクに差し替え、ルート
ハンドラのロジック（設定の保存・生成の流れ・保存方法の切り替え・PDF の
解析）を実際に通して検証する。
"""

import json

from app import structural_cert
from tests.conftest import (
    CERT_TOOL,
    GOOGLE_DOC_MIME,
    PDF_MIME,
    TEST_EMAIL,
)
from tests.pdf_util import SAMPLE_FIELDS, make_certificate_pdf

BASE = "/api/tools/structural-cert-formatter"
CONFIG_URL = f"{BASE}/config"
TEMPLATE_URL = f"{BASE}/template"
CERTIFICATES_URL = f"{BASE}/certificates"
PARSE_URL = f"{BASE}/certificates/parse"
PARSE_DRIVE_URL = f"{BASE}/certificates/parse-drive"

VALID_CHOICES = {
    "building_category": "2",
    "calc_type": "1",
    "calc_method": "2",
    "program_certified": "有",
}


# 新規保存の保存先は、そのつど画面の Picker で選ばれたフォルダが送られてくる。
NEW_SAVE = {"mode": "new", "folderId": "out-folder"}


def valid_body(**overrides):
    body = {
        "fields": dict(SAMPLE_FIELDS),
        "choices": dict(VALID_CHOICES),
        "save": dict(NEW_SAVE),
    }
    body.update(overrides)
    return body


# --- フォーム定義 -----------------------------------------------------------

def test_config_is_derived_from_the_mapping(client, drive):
    resp = client.get(CONFIG_URL)

    assert resp.status_code == 200
    body = resp.json()
    assert body["default_file_name"] == "構造計算安全証明書.pdf"
    assert {g["key"] for g in body["choice_groups"]} == {
        "building_category",
        "calc_type",
        "calc_method",
        "program_certified",
    }


def test_config_requires_auth(anon_client):
    assert anon_client.get(CONFIG_URL).status_code == 401


# --- 設定の状態 -------------------------------------------------------------

def test_template_status_unconfigured(client, drive):
    resp = client.get(TEMPLATE_URL)

    assert resp.status_code == 200
    # 設定として持つのは雛形だけ（保存先は保存のたびに決まる）。
    assert resp.json() == {"configured": False, "fileName": ""}


def test_template_status_configured(client, drive):
    drive.configure_certificate(file_name="安全証明書 雛形")

    body = client.get(TEMPLATE_URL).json()

    assert body == {"configured": True, "fileName": "安全証明書 雛形"}


# --- 雛形の選択 -------------------------------------------------------------

def test_save_template_records_folder_and_name(client, drive):
    drive.metadata["doc-1"] = {
        "id": "doc-1",
        "name": "安全証明書 雛形",
        "mimeType": GOOGLE_DOC_MIME,
        "parents": ["folder-9"],
    }

    resp = client.put(TEMPLATE_URL, json={"fileId": "doc-1"})

    assert resp.status_code == 200
    assert resp.json() == {"fileName": "安全証明書 雛形", "folderId": "folder-9"}
    assert drive.saved == [
        (
            CERT_TOOL,
            {"template_folder_id": "folder-9", "template_file_name": "安全証明書 雛形"},
        )
    ]


def test_save_template_rejects_non_google_doc(client, drive):
    drive.metadata["file-1"] = {
        "id": "file-1",
        "name": "雛形.docx",
        "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "parents": ["folder-9"],
    }

    resp = client.put(TEMPLATE_URL, json={"fileId": "file-1"})

    assert resp.status_code == 400
    assert "Google ドキュメント" in resp.json()["error"]
    assert drive.saved == []


def test_save_template_rejects_file_without_parent(client, drive):
    drive.metadata["doc-3"] = {
        "id": "doc-3",
        "name": "雛形",
        "mimeType": GOOGLE_DOC_MIME,
        "parents": [],
    }

    resp = client.put(TEMPLATE_URL, json={"fileId": "doc-3"})

    assert resp.status_code == 400
    assert "親フォルダ" in resp.json()["error"]


def test_save_template_without_file_id_returns_400(client, drive):
    resp = client.put(TEMPLATE_URL, json={})

    assert resp.status_code == 400


# --- 生成と保存 -------------------------------------------------------------

def test_create_certificate_saves_a_new_file(client, drive):
    drive.configure_certificate(export_bytes=make_certificate_pdf())

    resp = client.post(CERTIFICATES_URL, json=valid_body())

    assert resp.status_code == 200
    body = resp.json()
    assert body["mode"] == "new"
    assert body["fileId"] == "new-file"
    assert body["warnings"] == []
    # 雛形は複製してから置換し、複製は必ず後片付けする。
    assert drive.copies == [("template-doc", "[一時] 安全証明書 雛形")]
    assert drive.deleted == ["copy-of-template-doc"]
    # 保存先フォルダに、名称から組み立てた名前で作られる。
    folder_id, name, content, mime = drive.created[0]
    assert (folder_id, name, mime) == (
        "out-folder",
        "構造計算安全証明書_サンプル邸.pdf",
        PDF_MIME,
    )
    assert content.startswith(b"%PDF-")
    # 書き込みは実行ユーザーの代理で行う。
    assert drive.write_emails == [TEST_EMAIL]


def test_create_certificate_replaces_every_placeholder(client, drive):
    drive.configure_certificate(export_bytes=make_certificate_pdf())

    client.post(CERTIFICATES_URL, json=valid_body())

    replacements = drive.replaced[0]
    assert replacements["{{建物名称}}"] == "サンプル邸"
    assert replacements["{{委託者名}}"] == "株式会社サンプル"


def test_create_certificate_honours_an_explicit_file_name(client, drive):
    drive.configure_certificate(export_bytes=make_certificate_pdf())

    resp = client.post(
        CERTIFICATES_URL, json=valid_body(save={**NEW_SAVE, "fileName": "別名の証明書"})
    )

    assert resp.status_code == 200
    assert drive.created[0][1] == "別名の証明書.pdf"


def test_created_certificate_can_be_read_back(client, drive):
    drive.configure_certificate(export_bytes=make_certificate_pdf())

    client.post(CERTIFICATES_URL, json=valid_body())

    parsed = structural_cert.parse_pdf(drive.created[0][2])
    assert parsed["source"] == "metadata"
    assert parsed["choices"] == VALID_CHOICES


def test_create_certificate_overwrites_with_version_history(client, drive):
    drive.configure_certificate(export_bytes=make_certificate_pdf())
    drive.metadata["old-pdf"] = {
        "id": "old-pdf",
        "name": "構造計算安全証明書_サンプル邸.pdf",
        "mimeType": PDF_MIME,
    }

    resp = client.post(
        CERTIFICATES_URL,
        json=valid_body(save={"mode": "overwrite", "fileId": "old-pdf"}),
    )

    assert resp.status_code == 200
    assert resp.json()["mode"] == "overwrite"
    # 上書きは「同じファイルの内容差し替え」で行う。Drive はこれで新しい
    # リビジョンを作るため、直前の内容は版履歴から復元できる（作り直して
    # 置き換えると版履歴が途切れてしまう）。
    file_id, content, mime = drive.updated[0]
    assert (file_id, mime) == ("old-pdf", PDF_MIME)
    assert content.startswith(b"%PDF-")
    assert drive.created == []


def test_overwrite_rejects_a_non_pdf_target(client, drive):
    drive.configure_certificate(export_bytes=make_certificate_pdf())
    drive.metadata["a-doc"] = {"id": "a-doc", "name": "文書", "mimeType": GOOGLE_DOC_MIME}

    resp = client.post(
        CERTIFICATES_URL, json=valid_body(save={"mode": "overwrite", "fileId": "a-doc"})
    )

    assert resp.status_code == 400
    assert "PDF" in resp.json()["error"]
    assert drive.updated == []


def test_overwrite_without_file_id_returns_400(client, drive):
    drive.configure_certificate(export_bytes=make_certificate_pdf())

    resp = client.post(CERTIFICATES_URL, json=valid_body(save={"mode": "overwrite"}))

    assert resp.status_code == 400


def test_create_certificate_requires_the_template_setting(client, drive):
    drive.configure_certificate(folder_id="", file_name="")

    resp = client.post(CERTIFICATES_URL, json=valid_body())

    assert resp.status_code == 409
    assert "雛形が未設定" in resp.json()["error"]


def test_create_certificate_requires_a_destination_folder(client, drive):
    # 新規保存は保存のたびに Picker でフォルダを選ぶ。選ばずに送られてきたら
    # 保存しようがないので、雛形を複製する前に断る。
    drive.configure_certificate(export_bytes=make_certificate_pdf())

    resp = client.post(CERTIFICATES_URL, json=valid_body(save={"mode": "new"}))

    assert resp.status_code == 400
    assert "保存先のフォルダ" in resp.json()["error"]
    assert drive.copies == []


def test_create_certificate_rejects_a_destination_that_is_not_a_folder(client, drive):
    drive.configure_certificate(export_bytes=make_certificate_pdf())
    drive.metadata["a-pdf"] = {"id": "a-pdf", "name": "証明書.pdf", "mimeType": PDF_MIME}

    resp = client.post(
        CERTIFICATES_URL, json=valid_body(save={"mode": "new", "folderId": "a-pdf"})
    )

    assert resp.status_code == 400
    assert "フォルダ" in resp.json()["error"]
    assert drive.created == []


def test_create_certificate_checks_the_destination_as_the_signed_in_user(client, drive):
    # 選択は公式 Picker が行うが、届くのは ID だけなので、それが本当にフォルダ
    # なのか・本人が書き込めるのかは実行ユーザーの代理セッションで確かめる。
    drive.configure_certificate(export_bytes=make_certificate_pdf())

    resp = client.post(CERTIFICATES_URL, json=valid_body())

    assert resp.status_code == 200
    assert drive.write_emails == [TEST_EMAIL]


def test_create_certificate_validates_the_form(client, drive):
    drive.configure_certificate(export_bytes=make_certificate_pdf())
    body = valid_body()
    body["fields"]["building_name"] = ""

    resp = client.post(CERTIFICATES_URL, json=body)

    assert resp.status_code == 400
    assert "建築物の名称" in resp.json()["error"]
    # 検証に失敗したら雛形は複製しない。
    assert drive.copies == []


def test_create_certificate_reports_missing_placeholders(client, drive):
    drive.configure_certificate(export_bytes=make_certificate_pdf())
    # 雛形から「建物名称」の記入欄が消えてしまった状況。
    drive.replace_counts = {"{{建物名称}}": 0}

    resp = client.post(CERTIFICATES_URL, json=valid_body())

    assert resp.status_code == 200
    warnings = resp.json()["warnings"]
    assert any("建築物の名称" in w for w in warnings)


def test_create_certificate_cleans_up_the_copy_when_export_fails(client, drive, monkeypatch):
    drive.configure_certificate(export_bytes=make_certificate_pdf())

    def boom(session, file_id, mime_type):
        raise RuntimeError("export failed")

    monkeypatch.setattr("app.main.google_drive.export_file", boom)

    resp = client.post(CERTIFICATES_URL, json=valid_body())

    assert resp.status_code == 500
    assert drive.deleted == ["copy-of-template-doc"]


def test_create_certificate_rejects_an_unknown_save_mode(client, drive):
    drive.configure_certificate(export_bytes=make_certificate_pdf())

    resp = client.post(CERTIFICATES_URL, json=valid_body(save={"mode": "append"}))

    assert resp.status_code == 400


# --- 解析（編集機能） -------------------------------------------------------

def _generated_pdf():
    data = structural_cert.normalize_data(
        {"fields": dict(SAMPLE_FIELDS), "choices": dict(VALID_CHOICES)}
    )
    return structural_cert.finalize_pdf(make_certificate_pdf(), data)


def test_parse_uploaded_pdf(client, drive):
    resp = client.post(
        PARSE_URL,
        files={"file": ("証明書.pdf", _generated_pdf(), PDF_MIME)},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["source"] == "metadata"
    assert body["fields"]["building_name"] == "サンプル邸"
    assert body["choices"] == VALID_CHOICES
    # アップロードした PDF は Drive 上のファイルではないので上書き先にできない。
    assert body["file"] == {"id": "", "name": "証明書.pdf"}


def test_parse_uploaded_non_pdf_returns_400(client, drive):
    resp = client.post(PARSE_URL, files={"file": ("メモ.txt", b"hello", "text/plain")})

    assert resp.status_code == 400
    assert "PDF" in resp.json()["error"]


def test_parse_drive_pdf_returns_the_overwrite_target(client, drive):
    drive.metadata["pdf-1"] = {
        "id": "pdf-1",
        "name": "構造計算安全証明書_サンプル邸.pdf",
        "mimeType": PDF_MIME,
    }
    drive.download_bytes = _generated_pdf()

    resp = client.post(PARSE_DRIVE_URL, json={"fileId": "pdf-1"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["source"] == "metadata"
    assert body["file"] == {"id": "pdf-1", "name": "構造計算安全証明書_サンプル邸.pdf"}
    assert body["suggestedFileName"] == "構造計算安全証明書_サンプル邸.pdf"


def test_parse_drive_rejects_a_non_pdf(client, drive):
    drive.metadata["doc-9"] = {"id": "doc-9", "name": "文書", "mimeType": GOOGLE_DOC_MIME}

    resp = client.post(PARSE_DRIVE_URL, json={"fileId": "doc-9"})

    assert resp.status_code == 400


def test_parse_drive_without_file_id_returns_400(client, drive):
    resp = client.post(PARSE_DRIVE_URL, json={})

    assert resp.status_code == 400


def test_edit_round_trip_overwrites_the_source_file(client, drive):
    """読み込み → 一部を編集 → 上書き保存、という編集機能の一連の流れ。"""
    drive.configure_certificate(export_bytes=make_certificate_pdf())
    drive.metadata["pdf-1"] = {
        "id": "pdf-1",
        "name": "構造計算安全証明書_サンプル邸.pdf",
        "mimeType": PDF_MIME,
    }
    drive.download_bytes = _generated_pdf()

    loaded = client.post(PARSE_DRIVE_URL, json={"fileId": "pdf-1"}).json()
    loaded["fields"]["building_use"] = "共同住宅"
    loaded["choices"]["building_category"] = "3"

    resp = client.post(
        CERTIFICATES_URL,
        json={
            "fields": loaded["fields"],
            "choices": loaded["choices"],
            "save": {"mode": "overwrite", "fileId": loaded["file"]["id"]},
        },
    )

    assert resp.status_code == 200
    assert drive.updated[0][0] == "pdf-1"
    stored = json.loads(
        structural_cert.pdf_tools.read_metadata_value(
            drive.updated[0][1], structural_cert.load_mapping()["metadata_key"]
        )
    )
    assert stored["fields"]["building_use"] == "共同住宅"
    assert stored["choices"]["building_category"] == "3"
