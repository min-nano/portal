"""外部ユーザー（組織外のアカウント）に開くもの・開かないもの。

外部ユーザーには代理アクセス（domain-wide delegation）が効かないので、
Drive を使わない機能だけを使わせる。断るのはいつもサーバー側で、

  - ツールは既定で社内専用。external_users を名乗ったツールだけを開く
  - 開いたツールの中でも、Drive を使う入口は代理アクセスの手前で断る
  - 全員共通の設定（ポータルの名前とロゴ）の書き換えは社内専用

を確かめる。画面の出し分け（/api/me の external）は目印にすぎない。
"""

import re
from pathlib import Path

import pytest

from app import portal_sdk
from app.clerk_auth import AuthError, User
from app.tools import TOOLS
from tests.conftest import EXTERNAL_EMAIL, TEST_EMAIL

FRONTEND_SRC = Path(__file__).resolve().parents[2] / "frontend" / "src"

# 外部ユーザーにも使わせるツール（Drive を使わずに、手元のファイルを読み、
# 編集したものをダウンロードできるもの）。増やすときは、そのツールの中で
# Drive を使う入口が代理アクセスを通っていることを確かめてから。
OPEN_TO_EXTERNAL_USERS = {"wall-quantity-calculator", "pdf-book-merger"}

DRIVE_ONLY_FOR_STAFF = "Google ドライブを使う機能は社内アカウント専用です。"
STAFF_ONLY = "この機能は社内アカウント専用です。"


def test_me_tells_the_screen_that_staff_are_not_external(client):
    assert client.get("/api/me").json() == {"email": TEST_EMAIL, "external": False}


def test_me_tells_the_screen_whether_the_user_is_external(external_client):
    assert external_client.get("/api/me").json() == {
        "email": EXTERNAL_EMAIL,
        "external": True,
    }


def test_only_the_named_tools_are_open_to_external_users():
    assert {tool.id for tool in TOOLS if tool.external_users} == OPEN_TO_EXTERNAL_USERS


@pytest.mark.parametrize("tool", TOOLS, ids=lambda t: t.id)
def test_the_web_manifest_declares_the_same_audience(tool):
    """画面（tool.js の externalUsers）とバックエンド（Tool.external_users）がそろう。

    ずれると、トップページは使えると案内するのに API が断る（またはその逆）。
    """
    manifest = (FRONTEND_SRC / tool.id / "tool.js").read_text(encoding="utf-8")
    # コメントの中の文字に引っかからないよう、行頭のプロパティだけを読む。
    # 書くなら true / false の素の値で（ほかの書き方は、ここで落とす）。
    declared = re.findall(r"^\s*externalUsers:\s*([^,\s/]+)", manifest, re.MULTILINE)
    assert declared in ([], ["true"], ["false"]), declared
    assert (declared == ["true"]) == tool.external_users


@pytest.mark.parametrize(
    "tool", [t for t in TOOLS if not t.external_users], ids=lambda t: t.id
)
def test_every_route_of_a_staff_only_tool_refuses_external_users(external_client, tool):
    """社内専用のツールは、どのルートも（中身に触れる前に）403 で断る。"""
    for route in tool.router.routes:
        method = sorted(route.methods)[0]
        path = route.path.replace("{file_id}", "x")
        resp = external_client.request(method, path)
        assert resp.status_code == 403, f"{method} {path}"
        assert resp.json() == {"error": STAFF_ONLY, "code": "staff_only"}


def test_staff_only_tools_stay_open_to_staff(client):
    resp = client.get("/api/tools/excel-report-formatter/config")
    assert resp.status_code == 200


def test_an_open_tool_works_for_external_users(external_client):
    resp = external_client.get("/api/tools/wall-quantity-calculator/config")
    assert resp.status_code == 200


def test_reading_drive_from_an_open_tool_is_refused(external_client, drive):
    """PDF 結合ツールは開いているが、Drive の PDF を読む入口は断る。"""
    drive.metadata["scan-1"] = {"id": "scan-1", "mimeType": "application/pdf"}

    resp = external_client.get("/api/tools/pdf-book-merger/files/scan-1")

    assert resp.status_code == 403
    assert resp.json() == {"error": DRIVE_ONLY_FOR_STAFF, "code": "drive_staff_only"}
    assert drive.delegated_emails == []  # なりかわりを頼む前に断っている


def test_the_drive_file_list_is_refused(external_client, drive):
    resp = external_client.get("/api/drive/items")

    assert resp.status_code == 403
    assert resp.json() == {"error": DRIVE_ONLY_FOR_STAFF, "code": "drive_staff_only"}
    assert drive.delegated_emails == []


def test_an_account_on_neither_list_is_refused_with_a_code(anon_client, monkeypatch):
    """使えないアカウントは、目印（code）付きの 403 で断る。"""

    def refuse(authorization):
        raise AuthError("このアプリは許可されたアカウント専用です。", 403, "account_not_allowed")

    monkeypatch.setattr(portal_sdk.clerk_auth, "user_from_authorization_header", refuse)

    resp = anon_client.get("/api/me", headers={"Authorization": "Bearer x"})

    assert resp.status_code == 403
    assert resp.json() == {
        "error": "このアプリは許可されたアカウント専用です。",
        "code": "account_not_allowed",
    }


def test_other_failures_carry_no_code(client):
    # 目印は、それを付けた失敗にだけ載る（ほかの失敗は本文が error だけ）。
    assert client.put("/api/site", json={}).json() == {"error": "設定の内容が不正です。"}


def test_site_settings_cannot_be_changed_by_external_users(external_client, drive):
    resp = external_client.put("/api/site", json={"title": "乗っ取り"})

    assert resp.status_code == 403
    assert drive.site == {}
    # 読むのは誰でも（サインイン画面にも出すもの）。
    assert external_client.get("/api/site").status_code == 200


@pytest.mark.parametrize(
    "delegate", ["delegated_session", "delegated_read_token", "delegated_write_session"]
)
def test_every_kind_of_delegation_refuses_external_users(drive, delegate):
    with pytest.raises(AuthError) as error:
        getattr(portal_sdk, delegate)(User(email=EXTERNAL_EMAIL, external=True))
    assert error.value.status == 403
    assert error.value.code == "drive_staff_only"  # 画面はツールを閉じない
    assert str(error.value) == DRIVE_ONLY_FOR_STAFF
    assert drive.delegated_emails == drive.write_emails == []


def test_staff_delegation_impersonates_the_user(drive, monkeypatch):
    staff = User(email=TEST_EMAIL, external=False)
    monkeypatch.setattr(
        portal_sdk.google_drive, "delegated_read_token", lambda email: (email, None)
    )

    assert portal_sdk.delegated_session(staff) == ("delegated", TEST_EMAIL)
    assert portal_sdk.delegated_write_session(staff) == ("write", TEST_EMAIL)
    assert portal_sdk.delegated_read_token(staff) == (TEST_EMAIL, None)
