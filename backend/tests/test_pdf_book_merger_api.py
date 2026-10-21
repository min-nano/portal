"""書籍スキャン PDF 結合ツールの API テスト（Drive の PDF を読む準備）。

結合そのものは画面の中で行い、結合した PDF はダウンロードするだけ。PDF の
中身も、画面が Drive から直接読む（Cloud Run・Hosting の転送量を使わない）。
サーバーが受け持つのは、

  - PDF か確かめて名前と大きさを返す（本人の代理・読み取り専用）
  - 画面が Drive から直接読むための、読み取り専用の代理トークンを渡す

だけで、これを検証する。Drive は conftest のフェイクと、ここでの差し替えで
代役を立てる。
"""

import datetime

import google.auth.exceptions
import pytest

from app import google_drive
from app.google_drive import DriveError
from tests.conftest import PDF_MIME, TEST_EMAIL

BASE = "/api/tools/pdf-book-merger"
FILES_URL = f"{BASE}/files"
EXPIRY = datetime.datetime(2026, 10, 20, 12, 0, 0)


@pytest.fixture
def scan(monkeypatch, drive):
    """Drive に置いた PDF。渡したトークンの相手を記録する。"""
    record = {"tokens": []}
    drive.metadata["scan-1"] = {
        "id": "scan-1",
        "name": "奇数1.pdf",
        "mimeType": PDF_MIME,
        "size": "16384",
        "headRevisionId": "rev-7",
    }

    def delegated_read_token(email):
        record["tokens"].append(email)
        return "ya29.read-only", EXPIRY

    monkeypatch.setattr(google_drive, "delegated_read_token", delegated_read_token)
    return record


def test_file_info_checks_the_pdf_and_hands_a_read_only_token(client, drive, scan):
    resp = client.get(f"{FILES_URL}/scan-1")

    assert resp.status_code == 200
    assert resp.json() == {
        "id": "scan-1",
        "name": "奇数1.pdf",
        "size": 16384,
        "revision": "rev-7",
        "accessToken": "ya29.read-only",
        "expiresAt": "2026-10-20T12:00:00+00:00",
    }
    # 確かめるのも、トークンも、本人の代理（読み取り専用）。
    assert drive.delegated_emails == [TEST_EMAIL]
    assert scan["tokens"] == [TEST_EMAIL]
    # トークンを含むので、経路のどこにも残させない。
    assert resp.headers["cache-control"] == "no-store"


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
    # 読めないものには、トークンを渡さない。
    assert "accessToken" not in resp.json()
    assert scan["tokens"] == []


@pytest.mark.parametrize("file_id", ["a.b", "a%2Fb", "x" * 201])
def test_only_drive_like_ids_are_read(client, scan, file_id):
    resp = client.get(f"{FILES_URL}/{file_id}")

    assert resp.status_code in (400, 404)
    assert scan["tokens"] == []


def test_the_old_relay_is_gone(client, scan):
    # 中身はサーバーを通さない（転送量を使わない）。
    resp = client.get(f"{FILES_URL}/scan-1/content", params={"start": 0, "end": 1})

    assert resp.status_code in (404, 405)


def test_reading_requires_sign_in(anon_client, scan):
    assert anon_client.get(f"{FILES_URL}/scan-1").status_code == 401
    assert scan["tokens"] == []


# --- 読み取り専用の代理トークン（google_drive.delegated_read_token） -----------


class FakeCredentials:
    def __init__(self, token, expiry, fail=False):
        self.token = token
        self.expiry = expiry
        self.fail = fail
        self.refreshed = 0

    def refresh(self, request):
        if self.fail:
            raise google.auth.exceptions.RefreshError("unauthorized_client")
        self.refreshed += 1
        self.token = f"fresh-{self.refreshed}"
        self.expiry = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None) + datetime.timedelta(
            hours=1
        )


@pytest.fixture
def credentials(monkeypatch):
    made = []

    def make(scopes, subject, fail=False):
        creds = FakeCredentials(None, None, fail=fail)
        made.append(((tuple(scopes), subject), creds))
        return creds

    def cached(scopes, subject):
        raise AssertionError("ブラウザへ渡すトークンに、サーバーの資格情報を使い回さない")

    monkeypatch.setattr(google_drive, "_credentials", make)
    monkeypatch.setattr(google_drive, "_cached_credentials", cached)
    return made, monkeypatch


def test_read_token_is_a_fresh_drive_readonly_token_for_the_user(credentials):
    made, _ = credentials

    first, expiry = google_drive.delegated_read_token(TEST_EMAIL)
    second, _ = google_drive.delegated_read_token(TEST_EMAIL)

    # 呼ぶたびに、サーバーの資格情報とは別に作って取る。
    assert [key for key, _ in made] == [((google_drive.DRIVE_READONLY_SCOPE,), TEST_EMAIL)] * 2
    assert all(creds.refreshed == 1 for _, creds in made)
    assert first == second == "fresh-1"
    assert expiry > datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None) + datetime.timedelta(minutes=55)


def test_file_info_revision_falls_back_to_the_modified_time(client, drive, scan):
    # 版の印が無いファイルは、最終更新日時で差し替えを見分ける。
    del drive.metadata["scan-1"]["headRevisionId"]
    drive.metadata["scan-1"]["modifiedTime"] = "2026-10-20T01:02:03.000Z"

    assert client.get(f"{FILES_URL}/scan-1").json()["revision"] == "2026-10-20T01:02:03.000Z"


def test_read_token_failure_while_making_credentials_is_reported(credentials):
    # 資格情報を作るところ（ADC・署名元）で失敗しても、分かる 502 にする。
    _, monkeypatch = credentials

    def broken(scopes, subject):
        raise google.auth.exceptions.TransportError("metadata server unavailable")

    monkeypatch.setattr(google_drive, "_credentials", broken)

    with pytest.raises(DriveError, match="代理アクセスを用意できませんでした") as caught:
        google_drive.delegated_read_token(TEST_EMAIL)
    assert caught.value.status == 502


def test_signing_shares_adc_but_not_the_request_across_threads(monkeypatch):
    # ADC はプロセス全体で 1 度だけ探す。取り直しは 1 つずつ、通信の道具（Request）は
    # スレッドごと。利用者ごとにキャッシュした資格情報を別のスレッドが使っても、
    # 署名するスレッドの Request を使う。
    import threading

    defaults = []
    refreshed = []

    class Source:
        service_account_email = "runtime@example.iam.gserviceaccount.com"
        universe_domain = "googleapis.com"
        valid = False

        def refresh(self, request):
            # 取り直しは、いつも lock の中で。
            assert google_drive._adc_lock.locked()
            refreshed.append(request)
            self.valid = True

        def before_request(self, request, method, url, headers):
            if not self.valid:
                self.refresh(request)
            headers["authorization"] = "Bearer adc"

    adc = Source()

    def default():
        defaults.append(1)
        return adc, "project"

    signed = []

    class FakeIamSigner:
        def __init__(self, request, source, email):
            self.args = (request, source, email)

        def sign(self, message):
            # 本物の iam.Signer と同じく、signBlob を頼むたびに before_request を呼ぶ
            # （やり直しの分も）。
            # 最初の署名では、やり直す間に ADC のトークンが古くなったことにする。
            request, source, _ = self.args
            source.before_request(request, "POST", "https://iam", {})
            if not signed:
                adc.valid = False
            source.before_request(request, "POST", "https://iam", {})
            assert source.universe_domain == "googleapis.com"
            signed.append(self.args)
            return b"signature"

    monkeypatch.setattr(google_drive, "_signing_kind", None)
    monkeypatch.setattr(google_drive, "_thread", threading.local())
    monkeypatch.setattr(google_drive.google.auth, "default", default)
    monkeypatch.setattr(google_drive.iam, "Signer", FakeIamSigner)

    creds = google_drive._credentials([google_drive.DRIVE_READONLY_SCOPE], TEST_EMAIL)
    assert creds.service_account_email == "runtime@example.iam.gserviceaccount.com"
    assert creds.signer.sign(b"x") == b"signature"
    creds.signer.sign(b"y")
    worker = threading.Thread(target=lambda: creds.signer.sign(b"z"))
    worker.start()
    worker.join()
    google_drive._credentials([google_drive.DRIVE_READONLY_SCOPE], "other@example.com")

    assert defaults == [1]
    # ADC は 1 つで、取り直したのは、始めと、古くなったやり直しの 2 度だけ
    # （どちらも lock の中で。Source.refresh）。
    assert len(refreshed) == 2
    (r1, s1, _), (r2, s2, _), (r3, s3, _) = signed
    assert s1 is s2 is s3
    # 同じスレッドでは Request を使い回し、別のスレッドでは別のものを使う。
    assert r1 is r2
    assert r3 is not r1


def test_read_token_failure_is_reported(credentials):
    _, monkeypatch = credentials
    monkeypatch.setattr(google_drive, "_credentials", lambda scopes, subject: FakeCredentials(None, None, fail=True))

    with pytest.raises(DriveError, match="代理アクセスを用意できませんでした") as caught:
        google_drive.delegated_read_token(TEST_EMAIL)
    assert caught.value.status == 502
