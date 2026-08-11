"""公式 Google Picker 向けの API（設定の配信とトークンの発行）のテスト。

Picker が必要とするのは「API キー（ブラウザキー）」と「Drive を読める
アクセストークン」の 2 つ。前者は環境ごとに違うので環境変数から配り、
後者はバックエンドが実行ユーザー本人の代理で発行する。
"""

from tests.conftest import TEST_EMAIL

CONFIG_URL = "/api/picker/config"
TOKEN_URL = "/api/picker/token"

API_KEY = "AIzaSyTest"


# --- 設定の配信 -------------------------------------------------------------

def test_picker_config_returns_the_values_the_browser_needs(
    client, drive, monkeypatch
):
    monkeypatch.setenv("GOOGLE_PICKER_API_KEY", API_KEY)
    monkeypatch.setenv("GOOGLE_PICKER_APP_ID", "1234567890")

    resp = client.get(CONFIG_URL)

    assert resp.status_code == 200
    assert resp.json() == {
        "configured": True,
        "apiKey": API_KEY,
        "appId": "1234567890",
    }


def test_picker_app_id_is_optional(client, drive, monkeypatch):
    # アプリ ID は drive.file スコープでのみ必須。未設定なら Picker に渡さない。
    monkeypatch.setenv("GOOGLE_PICKER_API_KEY", API_KEY)
    monkeypatch.delenv("GOOGLE_PICKER_APP_ID", raising=False)

    body = client.get(CONFIG_URL).json()

    assert body["configured"] is True
    assert body["appId"] == ""


def test_picker_config_reports_a_missing_api_key(client, drive, monkeypatch):
    # 設定漏れはエラーではなく configured: false。画面側が「Picker が未設定」と
    # 案内でき、原因の分からない失敗にならない。
    monkeypatch.delenv("GOOGLE_PICKER_API_KEY", raising=False)

    resp = client.get(CONFIG_URL)

    assert resp.status_code == 200
    assert resp.json()["configured"] is False


def test_picker_config_requires_auth(anon_client):
    assert anon_client.get(CONFIG_URL).status_code == 401


# --- トークンの発行 ---------------------------------------------------------

def test_picker_token_is_issued_for_the_signed_in_user(client, drive):
    drive.access_token = ("ya29.test", 3599)

    resp = client.get(TOKEN_URL)

    assert resp.status_code == 200
    assert resp.json() == {"token": "ya29.test", "expiresIn": 3599}
    # 発行されるのは、あくまでアクセスしている本人のトークン。
    assert drive.token_emails == [TEST_EMAIL]


def test_picker_token_is_not_cached_on_the_way(client, drive):
    resp = client.get(TOKEN_URL)

    assert resp.headers["Cache-Control"] == "no-store"


def test_picker_token_requires_auth(anon_client):
    assert anon_client.get(TOKEN_URL).status_code == 401
