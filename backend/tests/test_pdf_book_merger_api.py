"""書籍スキャン PDF 結合ツールの API テスト（Drive とのあいだの中継）。

結合そのものは画面の中で行うので、サーバーが受け持つのは中継だけ。

  - 読む: PDF か確かめて大きさを返し、範囲を指定されたバイト列を返す
    （本人の代理・読み取り専用。1 回に読める大きさの上限）
  - 書く: Drive の再開可能なアップロードの「始める」「続きを送る」の 2 段を、
    保存先の確かめ方・送り先の確かめ方（任意の URL へ中継させない）とあわせて

を検証する。Drive は conftest のフェイクと、ここでの差し替えで代役を立てる。
"""

import importlib

import pytest

from app import google_drive
from app.google_drive import DriveError
from tests.conftest import FOLDER_MIME, PDF_MIME, TEST_EMAIL

BASE = "/api/tools/pdf-book-merger"
UPLOADS_URL = f"{BASE}/uploads"
CHUNK_URL = f"{BASE}/uploads/chunk"

UPLOAD_ID = "ADPycdv-xyz_123"
UPLOAD_URL = (
    "https://www.googleapis.com/upload/drive/v3/files"
    f"?uploadType=resumable&supportsAllDrives=true&fields=id&upload_id={UPLOAD_ID}"
)
UNIT = google_drive.RESUMABLE_CHUNK_UNIT


@pytest.fixture
def uploads(monkeypatch, drive):
    """アップロードの始まりと、送った続きを記録する。"""
    record = {"started": [], "chunks": [], "responses": []}
    drive.metadata["book-folder"] = {
        "id": "book-folder",
        "name": "スキャン",
        "mimeType": FOLDER_MIME,
    }

    def start(session, folder_id, name, mime_type, size):
        record["started"].append((session, folder_id, name, mime_type, size))
        return UPLOAD_ID

    def chunk(upload_id, offset, total, content):
        record["chunks"].append((upload_id, offset, total, content))
        if record["responses"]:
            return record["responses"].pop(0)
        return {"done": False, "received": offset + len(content)}

    monkeypatch.setattr(google_drive, "start_resumable_upload", start)
    monkeypatch.setattr(google_drive, "upload_chunk", chunk)
    return record


# --- 始める -----------------------------------------------------------------


def test_start_checks_the_folder_and_opens_an_upload_as_the_user(client, drive, uploads):
    resp = client.post(
        UPLOADS_URL,
        json={"folderId": "book-folder", "fileName": "吾輩は猫である", "size": 12345},
    )

    assert resp.status_code == 200
    body = resp.json()
    # 画面へ渡すのは受け口の id だけ（送り先の URL は渡さない）。
    assert body["uploadId"] == UPLOAD_ID
    assert "uploadUrl" not in body
    assert body["fileName"] == "吾輩は猫である.pdf"
    assert body["chunkBytes"] % UNIT == 0
    # 書き込みは本人の代理で行う。
    assert drive.write_emails == [TEST_EMAIL]
    assert uploads["started"] == [
        (("write", TEST_EMAIL), "book-folder", "吾輩は猫である.pdf", PDF_MIME, 12345)
    ]


def test_start_falls_back_to_the_default_name(client, uploads):
    resp = client.post(UPLOADS_URL, json={"folderId": "book-folder", "fileName": " ", "size": 1})

    assert resp.status_code == 200
    assert resp.json()["fileName"] == "結合.pdf"


@pytest.mark.parametrize(
    "body",
    [
        {"folderId": "book-folder", "size": 0},
        {"folderId": "book-folder", "size": -5},
        {"folderId": "book-folder", "size": "abc"},
        {"folderId": "book-folder", "size": True},
        {"folderId": "book-folder"},
    ],
)
def test_start_rejects_a_bad_size(client, uploads, body):
    resp = client.post(UPLOADS_URL, json=body)

    assert resp.status_code == 400
    assert "大きさ" in resp.json()["error"]
    assert uploads["started"] == []


def test_start_rejects_a_file_that_is_too_large(client, uploads):
    resp = client.post(
        UPLOADS_URL, json={"folderId": "book-folder", "size": 5 * 1024**3}
    )

    assert resp.status_code == 413
    assert uploads["started"] == []


def test_start_requires_a_folder(client, drive, uploads):
    drive.metadata["a-pdf"] = {"id": "a-pdf", "name": "x.pdf", "mimeType": PDF_MIME}

    missing = client.post(UPLOADS_URL, json={"size": 10})
    not_folder = client.post(UPLOADS_URL, json={"folderId": "a-pdf", "size": 10})

    assert missing.status_code == 400
    assert "フォルダ" in missing.json()["error"]
    assert not_folder.status_code == 400
    assert "フォルダ" in not_folder.json()["error"]
    assert uploads["started"] == []


def test_start_requires_sign_in(anon_client, uploads):
    resp = anon_client.post(UPLOADS_URL, json={"folderId": "book-folder", "size": 10})

    assert resp.status_code == 401
    assert uploads["started"] == []


# --- 続きを送る --------------------------------------------------------------


def send(client, content, offset=0, total=None, upload_id=UPLOAD_ID):
    return client.post(
        CHUNK_URL,
        data={"uploadId": upload_id, "offset": str(offset), "total": str(total or len(content))},
        files={"chunk": ("chunk", content, "application/octet-stream")},
    )


def test_a_middle_chunk_reports_how_much_drive_received(client, uploads):
    content = b"x" * UNIT

    resp = send(client, content, offset=0, total=UNIT * 3)

    assert resp.status_code == 200
    assert resp.json() == {"done": False, "received": UNIT}
    assert uploads["chunks"] == [(UPLOAD_ID, 0, UNIT * 3, content)]


def test_the_last_chunk_returns_the_saved_file(client, uploads):
    uploads["responses"].append(
        {"done": True, "id": "merged-1", "name": "本.pdf", "webViewLink": "https://drive/merged-1"}
    )

    resp = send(client, b"tail", offset=UNIT, total=UNIT + 4)

    assert resp.status_code == 200
    assert resp.json() == {
        "done": True,
        "fileId": "merged-1",
        "fileName": "本.pdf",
        "webViewLink": "https://drive/merged-1",
    }


@pytest.mark.parametrize(
    "upload_id",
    [
        "https://evil.example/upload?upload_id=xyz",
        "xyz&uploadType=media",
        "../files",
        "a b",
        "",
    ],
)
def test_chunks_only_accept_an_upload_id(client, uploads, upload_id):
    """送り先の URL は受け取らない。id の形をしていないものは中継しない。"""
    resp = send(client, b"x" * 10, upload_id=upload_id)

    # 空の欄は FastAPI がルートに入る前に断る（422）。
    assert resp.status_code in (400, 422)
    assert uploads["chunks"] == []


def test_a_middle_chunk_must_be_a_multiple_of_256_kib(client, uploads):
    resp = send(client, b"x" * 1000, offset=0, total=UNIT * 2)

    assert resp.status_code == 400
    assert uploads["chunks"] == []


def test_a_chunk_cannot_run_past_the_total(client, uploads):
    resp = send(client, b"x" * 10, offset=UNIT, total=UNIT + 5)

    assert resp.status_code == 400
    assert uploads["chunks"] == []


def test_an_oversized_chunk_is_refused(client, uploads, monkeypatch):
    # app.tools.pdf_book_merger は、パッケージの属性としては TOOL に上書きされている。
    module = importlib.import_module("app.tools.pdf_book_merger")
    monkeypatch.setattr(module, "CHUNK_BYTES", UNIT)

    resp = send(client, b"x" * (UNIT + 1), total=UNIT * 4)

    assert resp.status_code == 413
    assert uploads["chunks"] == []


@pytest.mark.parametrize("offset,total", [(-1, 10), (0, 0)])
def test_a_chunk_needs_a_sane_position(client, uploads, offset, total):
    resp = client.post(
        CHUNK_URL,
        data={"uploadId": UPLOAD_ID, "offset": str(offset), "total": str(total)},
        files={"chunk": ("chunk", b"abc", "application/octet-stream")},
    )

    assert resp.status_code == 400
    assert uploads["chunks"] == []


def test_an_empty_chunk_is_refused(client, uploads):
    resp = send(client, b"", total=10)

    assert resp.status_code == 400
    assert uploads["chunks"] == []


def test_chunks_require_sign_in(anon_client, uploads):
    resp = send(anon_client, b"x" * 10)

    assert resp.status_code == 401
    assert uploads["chunks"] == []


# --- Drive との受け渡し（google_drive） ---------------------------------------


class FakeResponse:
    def __init__(self, status_code, payload=None, headers=None):
        self.status_code = status_code
        self.ok = 200 <= status_code < 300
        self._payload = payload or {}
        self.headers = headers or {}

    def json(self):
        return self._payload


class FakeSession:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.response


def test_start_resumable_upload_asks_drive_for_a_session():
    session = FakeSession(FakeResponse(200, headers={"Location": UPLOAD_URL}))

    upload_id = google_drive.start_resumable_upload(session, "folder", "本.pdf", PDF_MIME, 999)

    assert upload_id == UPLOAD_ID
    (called, kwargs), = session.calls
    assert called == "https://www.googleapis.com/upload/drive/v3/files"
    assert kwargs["params"]["uploadType"] == "resumable"
    assert kwargs["json"] == {"name": "本.pdf", "parents": ["folder"], "mimeType": PDF_MIME}
    assert kwargs["headers"]["X-Upload-Content-Length"] == "999"


@pytest.mark.parametrize(
    "location",
    [
        "https://evil.example/upload/drive/v3/files?upload_id=x",
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
        "https://www.googleapis.com/upload/drive/v3/files?upload_id=a%20b",
        "",
    ],
)
def test_start_resumable_upload_refuses_an_unexpected_location(location):
    session = FakeSession(FakeResponse(200, headers={"Location": location}))

    with pytest.raises(DriveError):
        google_drive.start_resumable_upload(session, "folder", "本.pdf", PDF_MIME, 1)


def test_start_resumable_upload_reports_drive_errors():
    session = FakeSession(FakeResponse(403, {"error": {"message": "Insufficient Permission"}}))

    with pytest.raises(DriveError) as error:
        google_drive.start_resumable_upload(session, "folder", "本.pdf", PDF_MIME, 1)

    assert "Insufficient Permission" in str(error.value)


@pytest.fixture
def puts(monkeypatch):
    record = {"calls": [], "response": None}

    def put(url, params=None, data=None, headers=None, timeout=None):
        record["calls"].append((url, params, data, headers))
        return record["response"]

    monkeypatch.setattr(google_drive.requests, "put", put)
    return record


def test_upload_chunk_sends_the_range_and_reads_how_much_was_received(puts):
    puts["response"] = FakeResponse(308, headers={"Range": "bytes=0-262143"})

    result = google_drive.upload_chunk(UPLOAD_ID, 0, 1000000, b"x" * UNIT)

    assert result == {"done": False, "received": UNIT}
    (url, params, data, headers), = puts["calls"]
    # 送り先は定数から組み立て、id だけを差し込む。
    assert url == "https://www.googleapis.com/upload/drive/v3/files"
    assert params["upload_id"] == UPLOAD_ID
    assert params["uploadType"] == "resumable"
    assert headers == {"Content-Range": f"bytes 0-{UNIT - 1}/1000000"}


def test_upload_chunk_without_a_range_means_nothing_was_received(puts):
    puts["response"] = FakeResponse(308)

    assert google_drive.upload_chunk(UPLOAD_ID, 0, 10, b"abc") == {
        "done": False,
        "received": 0,
    }


def test_upload_chunk_returns_the_file_when_done(puts):
    puts["response"] = FakeResponse(200, {"id": "f1", "name": "本.pdf"})

    assert google_drive.upload_chunk(UPLOAD_ID, 7, 10, b"abc") == {
        "done": True,
        "id": "f1",
        "name": "本.pdf",
    }
    assert puts["calls"][0][3] == {"Content-Range": "bytes 7-9/10"}


def test_upload_chunk_refuses_urls_and_empty_content(puts):
    with pytest.raises(DriveError):
        google_drive.upload_chunk("https://evil.example/x?upload_id=1", 0, 1, b"a")
    with pytest.raises(DriveError):
        google_drive.upload_chunk(UPLOAD_ID, 0, 1, b"")
    assert puts["calls"] == []


def test_upload_chunk_reports_drive_errors(puts):
    puts["response"] = FakeResponse(404, {"error": {"message": "Upload session expired"}})

    with pytest.raises(DriveError) as error:
        google_drive.upload_chunk(UPLOAD_ID, 0, 3, b"abc")

    assert "Upload session expired" in str(error.value)


@pytest.mark.parametrize("value", [None, "", 123, "a/b", "a&b=c", "x" * 1025])
def test_only_url_safe_strings_are_upload_ids(value):
    assert google_drive.is_upload_id(value) is False


# --- 読む（Drive の PDF を少しずつ） ---------------------------------------------

FILES_URL = f"{BASE}/files"


@pytest.fixture
def scan(monkeypatch, drive):
    """Drive に置いた PDF。読まれた範囲を記録する。"""
    data = bytes(range(256)) * 64
    record = {"ranges": [], "data": data}
    drive.metadata["scan-1"] = {
        "id": "scan-1",
        "name": "奇数1.pdf",
        "mimeType": PDF_MIME,
        "size": str(len(data)),
    }

    def download_range(session, file_id, start, end):
        record["ranges"].append((session, file_id, start, end))
        return data[start : end + 1]

    monkeypatch.setattr(google_drive, "download_range", download_range)
    return record


def test_file_info_checks_the_pdf_as_the_user(client, drive, scan):
    resp = client.get(f"{FILES_URL}/scan-1")

    assert resp.status_code == 200
    assert resp.json() == {
        "id": "scan-1",
        "name": "奇数1.pdf",
        "size": len(scan["data"]),
        "chunkBytes": 8 * 1024 * 1024,
    }
    assert drive.delegated_emails == [TEST_EMAIL]


@pytest.mark.parametrize(
    "meta,message",
    [
        ({"trashed": True}, "ゴミ箱"),
        ({"mimeType": "image/png"}, "PDF ファイルではありません"),
        ({"size": None}, "大きさが分かりませんでした"),
        ({"size": "abc"}, "大きさが分かりませんでした"),
    ],
)
def test_file_info_refuses_what_cannot_be_read(client, drive, scan, meta, message):
    drive.metadata["scan-1"].update(meta)

    resp = client.get(f"{FILES_URL}/scan-1")

    assert resp.status_code == 400
    assert message in resp.json()["error"]


def test_content_returns_the_asked_range_as_the_user(client, scan):
    resp = client.get(f"{FILES_URL}/scan-1/content", params={"start": 10, "end": 19})

    assert resp.status_code == 200
    assert resp.content == scan["data"][10:20]
    assert resp.headers["content-type"] == "application/octet-stream"
    assert resp.headers["cache-control"] == "no-store"
    assert scan["ranges"] == [(("delegated", TEST_EMAIL), "scan-1", 10, 19)]


@pytest.mark.parametrize(
    "params",
    [
        {"start": -1, "end": 5},
        {"start": 5, "end": 4},
        {"start": 0, "end": 8 * 1024 * 1024},
        {"start": "a", "end": 3},
        {"start": 0},
    ],
)
def test_content_ranges_are_checked(client, scan, params):
    resp = client.get(f"{FILES_URL}/scan-1/content", params=params)

    assert resp.status_code in (400, 422)
    assert scan["ranges"] == []


@pytest.mark.parametrize("file_id", ["a.b", "a%2Fb", "x" * 201])
def test_only_drive_like_ids_are_read(client, scan, file_id):
    info = client.get(f"{FILES_URL}/{file_id}")
    content = client.get(f"{FILES_URL}/{file_id}/content", params={"start": 0, "end": 1})

    assert info.status_code in (400, 404)
    assert content.status_code in (400, 404)
    assert scan["ranges"] == []


def test_reading_requires_sign_in(anon_client, scan):
    assert anon_client.get(f"{FILES_URL}/scan-1").status_code == 401
    assert anon_client.get(f"{FILES_URL}/scan-1/content", params={"start": 0, "end": 1}).status_code == 401


# --- Drive から一部だけ読む（google_drive.download_range） ----------------------


class RangeSession:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def get(self, url, params=None, headers=None):
        self.calls.append((url, params, headers))
        return self.response


class RangeResponse(FakeResponse):
    def __init__(self, status_code, content=b"", payload=None):
        super().__init__(status_code, payload)
        self.content = content


def test_download_range_asks_drive_for_part_of_the_file():
    session = RangeSession(RangeResponse(206, b"cdef"))

    assert google_drive.download_range(session, "f1", 2, 5) == b"cdef"
    ((url, params, headers),) = session.calls
    assert url.endswith("/files/f1")
    assert params["alt"] == "media"
    assert headers == {"Range": "bytes=2-5"}


def test_download_range_cuts_out_the_part_when_drive_sends_everything():
    session = RangeSession(RangeResponse(200, b"abcdefgh"))

    assert google_drive.download_range(session, "f1", 2, 5) == b"cdef"


def test_download_range_reports_drive_errors():
    session = RangeSession(RangeResponse(404, payload={"error": {"message": "File not found"}}))

    with pytest.raises(DriveError, match="File not found"):
        google_drive.download_range(session, "f1", 0, 1)
