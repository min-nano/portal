"""Google API のエラー応答を利用者に伝えるところのテスト。

拒否の理由は「スコープが足りない」「GCP プロジェクトで API が有効化されて
いない」「本人に権限が無い」など複数ありうる。こちら側で推測した案内だけを
出すと、実際とは違う設定を調べさせてしまうため、Google 自身の説明を必ず
画面まで届ける。
"""

import datetime
import json
import re

import pytest
from google.auth.exceptions import RefreshError

from app import google_docs, google_drive
from app.google_drive import DriveError


class FakeResponse:
    def __init__(self, status_code, payload=None, body=None):
        self.status_code = status_code
        self.ok = 200 <= status_code < 300
        self._payload = payload
        self._body = body

    def json(self):
        if self._payload is not None:
            return self._payload
        return json.loads(self._body)


SERVICE_DISABLED = {
    "error": {
        "code": 403,
        "message": (
            "Google Docs API has not been used in project 123 before or it is "
            "disabled. Enable it by visiting "
            "https://console.developers.google.com/apis/api/docs.googleapis.com/overview"
        ),
        "status": "PERMISSION_DENIED",
    }
}


# --- 応答からの原因の取り出し -----------------------------------------------

def test_api_error_detail_reads_the_message():
    detail = google_drive.api_error_detail(FakeResponse(403, SERVICE_DISABLED))

    assert "has not been used in project" in detail


def test_api_error_detail_collapses_whitespace():
    payload = {"error": {"message": "line one\n  line two"}}

    assert google_drive.api_error_detail(FakeResponse(403, payload)) == "line one line two"


def test_api_error_detail_truncates_long_messages():
    payload = {"error": {"message": "x" * 500}}

    detail = google_drive.api_error_detail(FakeResponse(403, payload))

    assert len(detail) == 301
    assert detail.endswith("…")


@pytest.mark.parametrize(
    "response",
    [
        FakeResponse(403, body="<html>not json</html>"),
        FakeResponse(403, payload={}),
        FakeResponse(403, payload={"error": {}}),
        FakeResponse(403, payload={"error": ["unexpected shape"]}),
    ],
)
def test_api_error_detail_tolerates_unusable_bodies(response):
    assert google_drive.api_error_detail(response) == ""


# --- Drive -------------------------------------------------------------------

def test_drive_error_includes_the_google_message():
    with pytest.raises(DriveError) as excinfo:
        google_drive._raise_for_status(FakeResponse(403, SERVICE_DISABLED), "雛形の検索")

    message = str(excinfo.value)
    assert "雛形の検索が拒否されました" in message
    assert "has not been used in project" in message
    # API の有効化も候補として案内する（スコープだけを疑わせない）。
    assert "有効化" in message


def test_drive_error_without_a_usable_body_keeps_the_plain_message():
    with pytest.raises(DriveError) as excinfo:
        google_drive._raise_for_status(
            FakeResponse(500, body="<html>oops</html>"), "ファイルの保存"
        )

    assert str(excinfo.value) == "ファイルの保存に失敗しました (HTTP 500)。"


# --- 代理アクセストークン（Google Picker 用） --------------------------------

class FakeCredentials:
    """refresh() でトークンを得る資格情報の代役。"""

    def __init__(self, error=None, lifetime_seconds=3600):
        self._error = error
        self._lifetime = lifetime_seconds
        self.token = None
        self.expiry = None

    def refresh(self, request):
        if self._error:
            raise self._error
        self.token = "ya29.test"
        # google-auth は UTC の naive datetime を入れる。
        self.expiry = datetime.datetime.now(datetime.timezone.utc).replace(
            tzinfo=None
        ) + datetime.timedelta(seconds=self._lifetime)


def fake_credentials(monkeypatch, creds):
    monkeypatch.setattr(
        google_drive, "_credentials", lambda scopes, subject: creds
    )


def test_access_token_reports_the_remaining_lifetime(monkeypatch):
    fake_credentials(monkeypatch, FakeCredentials(lifetime_seconds=3600))

    token, expires_in = google_drive.delegated_access_token("user@example.co.jp")

    assert token == "ya29.test"
    # 端数の切り捨てだけがずれる。
    assert 3595 <= expires_in <= 3600


def test_access_token_failure_points_at_delegation_and_quotes_google(monkeypatch):
    # 代理を許可していないと unauthorized_client で拒否される。原因は Google の
    # 応答にしか書かれていないので、そのまま画面まで届ける。
    error = RefreshError(
        "('unauthorized_client: Client is unauthorized to retrieve access "
        "tokens using this method', {'error': 'unauthorized_client'})"
    )
    fake_credentials(monkeypatch, FakeCredentials(error=error))

    with pytest.raises(DriveError) as excinfo:
        google_drive.delegated_access_token("user@example.co.jp")

    message = str(excinfo.value)
    assert "domain-wide delegation" in message
    assert "unauthorized_client" in message
    assert excinfo.value.status == 502


def test_access_token_without_an_expiry_is_treated_as_expired(monkeypatch):
    # 期限が分からないトークンは使い回さない（画面側が毎回取り直す）。
    creds = FakeCredentials()
    creds.refresh = lambda request: setattr(creds, "token", "ya29.test")
    fake_credentials(monkeypatch, creds)

    assert google_drive.delegated_access_token("user@example.co.jp") == (
        "ya29.test",
        0,
    )


# --- Docs --------------------------------------------------------------------

def test_docs_403_points_at_api_enablement_and_quotes_google(monkeypatch):
    class FakeSession:
        def post(self, url, json=None):
            return FakeResponse(403, SERVICE_DISABLED)

    with pytest.raises(DriveError) as excinfo:
        google_docs.replace_all_text(FakeSession(), "doc-1", {"{{a}}": "b"})

    message = str(excinfo.value)
    # 利用者がそのまま使える名前（有効化するサービス ID と登録するスコープ）が
    # 案内に出ていること。ホスト名だけの部分一致で確かめると、URL の検証を
    # している箇所と見分けが付かず CodeQL に誤検知されるため、前後の文言まで
    # 含めて確認する。
    assert re.search(r"Google Docs API \(docs\.googleapis\.com\) が有効", message)
    assert re.search(r"auth/documents\) が登録", message)
    assert "has not been used in project" in message


def test_docs_replace_returns_occurrence_counts():
    class FakeSession:
        def post(self, url, json=None):
            requests = json["requests"]
            assert [r["replaceAllText"]["containsText"]["text"] for r in requests] == [
                "{{a}}",
                "{{b}}",
            ]
            return FakeResponse(
                200,
                {
                    "replies": [
                        {"replaceAllText": {"occurrencesChanged": 2}},
                        {"replaceAllText": {}},
                    ]
                },
            )

    counts = google_docs.replace_all_text(FakeSession(), "doc-1", {"{{a}}": "x", "{{b}}": ""})

    # 置換が起きなかったプレースホルダーは 0 件として扱う（呼び出し側が
    # 「雛形に記入欄が無い」と気づけるようにするため）。
    assert counts == {"{{a}}": 2, "{{b}}": 0}


def test_docs_replace_with_no_placeholders_makes_no_request():
    class FakeSession:
        def post(self, url, json=None):
            raise AssertionError("空の置換表で API を呼んではいけない")

    assert google_docs.replace_all_text(FakeSession(), "doc-1", {}) == {}
