"""雛形のプレビュー（GET template/preview）のテスト。

画面で雛形のファイル名を押すと、今の雛形の中身をポップアップで見せる。
雛形は生成と同じく「フォルダ内の同名ファイルのうち最新のもの」を本人の
代理で読み、Google ドキュメントは PDF、Excel はシートごとの表で返す。
"""

from tests.conftest import CERT_TOOL, GOOGLE_DOC_MIME, PDF_MIME, TEST_EMAIL, TOOL
from tests.test_xlsx_preview import workbook_bytes

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
EXCEL_PREVIEW_URL = f"/api/tools/{TOOL}/template/preview"
CERT_PREVIEW_URL = f"/api/tools/{CERT_TOOL}/template/preview"


def configure_excel(drive, content, mime_type=XLSX_MIME):
    drive.configure_template(folder_id="folder-1", file_name="雛形.xlsx")
    drive.doc_template = {"id": "xlsx-1", "name": "雛形.xlsx", "mimeType": mime_type}
    drive.download_bytes = content


def test_excel_template_is_returned_as_sheets(client, drive):
    def build(wb):
        wb.active.title = "報告書"
        wb.active["A1"] = "住宅名"

    configure_excel(drive, workbook_bytes(build))

    resp = client.get(EXCEL_PREVIEW_URL)

    assert resp.status_code == 200
    assert resp.headers["cache-control"] == "no-store"
    sheets = resp.json()["sheets"]
    assert [sheet["name"] for sheet in sheets] == ["報告書"]
    assert sheets[0]["rows"][0]["cells"] == [{"v": "住宅名"}]
    # 生成と同じく、設定したフォルダ・ファイル名の最新版を本人の代理で読む。
    assert drive.fetch_calls == [("folder-1", "雛形.xlsx")]
    assert drive.delegated_emails == [TEST_EMAIL]


def test_certificate_template_is_returned_as_pdf(client, drive):
    drive.configure_certificate(export_bytes=b"%PDF-1.7 preview")

    resp = client.get(CERT_PREVIEW_URL)

    assert resp.status_code == 200
    assert resp.headers["content-type"] == PDF_MIME
    assert resp.headers["cache-control"] == "no-store"
    assert resp.content == b"%PDF-1.7 preview"
    # 雛形を読むだけなので、書き込みの代理は使わない（複製も作らない）。
    assert drive.delegated_emails == [TEST_EMAIL]
    assert drive.write_emails == []
    assert drive.copies == []


def test_unconfigured_template_returns_409(client, drive):
    resp = client.get(EXCEL_PREVIEW_URL)

    assert resp.status_code == 409
    assert "雛形が未設定" in resp.json()["error"]
    assert drive.fetch_calls == []


def test_missing_template_file_returns_404(client, drive):
    drive.configure_template()
    drive.doc_template = None

    resp = client.get(EXCEL_PREVIEW_URL)

    assert resp.status_code == 404
    assert "見つかりませんでした" in resp.json()["error"]


def test_replaced_with_another_kind_returns_409(client, drive):
    # 設定のあとで、同じフォルダに同じ名前の Google ドキュメントが置かれた。
    configure_excel(drive, b"", mime_type=GOOGLE_DOC_MIME)

    resp = client.get(EXCEL_PREVIEW_URL)

    assert resp.status_code == 409
    assert "Excel 形式 (.xlsx)" in resp.json()["error"]


def test_broken_excel_template_returns_422(client, drive):
    configure_excel(drive, b"not a zip")

    resp = client.get(EXCEL_PREVIEW_URL)

    assert resp.status_code == 422
    assert resp.json()["error"] == "雛形を Excel ファイルとして読み込めませんでした。"
