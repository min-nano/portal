"""書籍スキャン PDF 結合ツールの API テスト（Drive の PDF を読む中継）。

結合そのものは画面の中で行い、結合した PDF はダウンロードするだけなので、
サーバーが受け持つのは Drive の PDF を読むときの中継だけ。

  - PDF か確かめて大きさを返す（本人の代理・読み取り専用）
  - 範囲を指定されたバイト列を返す（1 回に読める大きさの上限、ID の形）

を検証する。Drive は conftest のフェイクと、ここでの差し替えで代役を立てる。
"""

import pytest

from app import google_drive
from app.google_drive import DriveError
from tests.conftest import PDF_MIME, TEST_EMAIL

BASE = "/api/tools/pdf-book-merger"


class FakeResponse:
    def __init__(self, status_code, payload=None, headers=None):
        self.status_code = status_code
        self.ok = 200 <= status_code < 300
        self._payload = payload or {}
        self.headers = headers or {}

    def json(self):
        return self._payload


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
