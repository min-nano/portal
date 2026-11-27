"""Clerk セッション JWT 検証（clerk_auth.verify_token）の単体テスト。

署名にはテスト内で生成した RSA 鍵ペアを使い、JWKS の取得
（_signing_key_for）だけを公開鍵を返す関数に差し替える。署名検証・
有効期限・iss / azp・email クレーム・ドメイン制限の判定は実物を通す。
"""

import time

import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app import clerk_auth
from app.clerk_auth import AuthError

ISSUER = "https://clerk.example.com"
# PR プレビューで使う Clerk 開発インスタンス相当の第 2 発行者。
PREVIEW_ISSUER = "https://xxxx.clerk.accounts.dev"
FRONTEND_ORIGIN = "https://portal.example.com"
# PR プレビューのオリジンはデプロイごとに変わるためワイルドカードで許可する。
PREVIEW_ORIGIN_PATTERN = "https://portal--pr-*.web.app"

_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_PRIVATE_PEM = _PRIVATE_KEY.private_bytes(
    serialization.Encoding.PEM,
    serialization.PrivateFormat.PKCS8,
    serialization.NoEncryption(),
)
_PUBLIC_PEM = _PRIVATE_KEY.public_key().public_bytes(
    serialization.Encoding.PEM,
    serialization.PublicFormat.SubjectPublicKeyInfo,
)

_OTHER_PRIVATE_PEM = rsa.generate_private_key(
    public_exponent=65537, key_size=2048
).private_bytes(
    serialization.Encoding.PEM,
    serialization.PrivateFormat.PKCS8,
    serialization.NoEncryption(),
)


def make_token(key=_PRIVATE_PEM, **overrides):
    now = int(time.time())
    claims = {
        "iss": ISSUER,
        "azp": FRONTEND_ORIGIN,
        "sub": "user_123",
        "iat": now,
        "nbf": now,
        "exp": now + 60,
        "email": "tester@example.co.jp",
    }
    for k, v in overrides.items():
        if v is None:
            claims.pop(k, None)
        else:
            claims[k] = v
    return pyjwt.encode(claims, key, algorithm="RS256")


@pytest.fixture(autouse=True)
def auth_env(monkeypatch):
    monkeypatch.setenv("CLERK_ISSUER", f"{ISSUER},{PREVIEW_ISSUER}")
    monkeypatch.setenv(
        "CLERK_AUTHORIZED_PARTIES", f"{FRONTEND_ORIGIN},{PREVIEW_ORIGIN_PATTERN}"
    )
    monkeypatch.setenv("ALLOWED_EMAIL_DOMAINS", "example.co.jp")
    monkeypatch.delenv("ALLOW_EXTERNAL_USERS", raising=False)
    monkeypatch.setattr(
        clerk_auth, "_signing_key_for", lambda token, issuer: _PUBLIC_PEM
    )


def test_valid_token_returns_user_email():
    user = clerk_auth.verify_token(make_token())

    assert user.email == "tester@example.co.jp"


def test_expired_token_is_rejected():
    token = make_token(exp=int(time.time()) - 120, iat=int(time.time()) - 240)

    with pytest.raises(AuthError) as e:
        clerk_auth.verify_token(token)
    assert e.value.status == 401


def test_wrong_signature_is_rejected():
    with pytest.raises(AuthError):
        clerk_auth.verify_token(make_token(key=_OTHER_PRIVATE_PEM))


def test_wrong_issuer_is_rejected():
    with pytest.raises(AuthError) as e:
        clerk_auth.verify_token(make_token(iss="https://evil.example.com"))
    assert "iss" in str(e.value)


def test_second_issuer_is_accepted():
    # PR プレビュー用の開発インスタンス（CLERK_ISSUER に併記）も受け付ける。
    user = clerk_auth.verify_token(
        make_token(iss=PREVIEW_ISSUER, azp="https://portal--pr-12-abcd1234.web.app")
    )
    assert user.email == "tester@example.co.jp"


def test_unlisted_azp_is_rejected():
    # 他サイト向けに発行されたトークンの流用（azp 不一致）を拒否する。
    with pytest.raises(AuthError) as e:
        clerk_auth.verify_token(make_token(azp="https://other.example.com"))
    assert "azp" in str(e.value)


def test_azp_wildcard_matches_preview_origins_only():
    # ワイルドカードはプレビュー URL のパターンにだけマッチする。
    user = clerk_auth.verify_token(make_token(azp="https://portal--pr-3-xyz.web.app"))
    assert user.email == "tester@example.co.jp"

    with pytest.raises(AuthError):
        clerk_auth.verify_token(make_token(azp="https://portal-evil.web.app"))


def test_missing_azp_is_rejected_when_parties_configured():
    with pytest.raises(AuthError):
        clerk_auth.verify_token(make_token(azp=None))


def test_missing_email_claim_explains_session_token_customization():
    # Clerk の既定のセッショントークンには email が含まれない。設定手順を
    # 具体的に案内するエラーメッセージを返す。
    with pytest.raises(AuthError) as e:
        clerk_auth.verify_token(make_token(email=None))
    assert "Customize session token" in str(e.value)


def test_email_outside_allowed_domain_is_403():
    with pytest.raises(AuthError) as e:
        clerk_auth.verify_token(make_token(email="someone@gmail.com"))
    assert e.value.status == 403
    # 画面が、ほかの 403 と取り違えずに見分けるための目印。
    assert e.value.code == clerk_auth.ACCOUNT_NOT_ALLOWED


def test_other_domains_are_external_users_when_enabled(monkeypatch):
    # 誰がサインインできるかは Clerk（Invite-only）が決めるので、ここでは
    # 社内ドメインかどうかだけで分ける。
    monkeypatch.setenv("ALLOW_EXTERNAL_USERS", "true")

    user = clerk_auth.verify_token(make_token(email="partner@gmail.com"))
    assert user == clerk_auth.User(email="partner@gmail.com", external=True)
    assert clerk_auth.verify_token(make_token()).external is False


@pytest.mark.parametrize("value", ["", "false", "1", "yes"])
def test_other_domains_are_refused_unless_enabled_exactly(monkeypatch, value):
    # true 以外（未設定・書き損じ）は、社員だけで使う環境の既定どおり断る。
    monkeypatch.setenv("ALLOW_EXTERNAL_USERS", value)

    with pytest.raises(AuthError) as e:
        clerk_auth.verify_token(make_token(email="partner@gmail.com"))
    assert e.value.status == 403
    assert e.value.code == clerk_auth.ACCOUNT_NOT_ALLOWED


def test_other_subaddresses_outside_the_staff_domain_are_external(monkeypatch):
    # 独自ドメインで作った Google アカウントは、主のアドレスに + を含みうる。
    monkeypatch.setenv("ALLOW_EXTERNAL_USERS", "true")

    assert clerk_auth.verify_token(make_token(email="jane+portal@partner.example")).external


def test_enabling_is_case_insensitive(monkeypatch):
    monkeypatch.setenv("ALLOW_EXTERNAL_USERS", " True ")

    assert clerk_auth.verify_token(make_token(email="partner@gmail.com")).external


@pytest.mark.parametrize(
    "email",
    [
        "x+clerk_test@example.co.jp",
        "Tester+a@Example.co.jp",
        "x+clerk_test@gmail.com",
        "example.co.jp",
        "@example.co.jp",
        "someone@",
        "x@evil.example@example.co.jp",
    ],
)
@pytest.mark.parametrize("external", ["", "true"])
def test_subaddresses_and_malformed_addresses_are_refused(monkeypatch, email, external):
    # 社員+x@ 宛てのメールは社員本人に届くので、そのサブアドレスで個人の
    # Google アカウントを作られうる（同意画面が「外部」だと Google ログインも
    # 通る）。Clerk のテストモードの +clerk_test も同じ。Workspace のアドレスに
    # + は無いので、社内ドメインでは + を通さない（外部ユーザーとしても通さない）。
    # 社外の +clerk_test も、外部ユーザーを通す環境でメール無しで入られないよう断る。
    # @ の前後が欠けたアドレスも、社内・社外の判定をせずに断る。
    monkeypatch.setenv("ALLOW_EXTERNAL_USERS", external)
    with pytest.raises(AuthError) as e:
        clerk_auth.verify_token(make_token(email=email))
    assert e.value.status == 403
    assert e.value.code == clerk_auth.ACCOUNT_NOT_ALLOWED


def test_nobody_gets_in_when_the_staff_domain_is_unset(monkeypatch):
    # 判定を飛ばすと、組織外のアカウントまで社内ユーザーとして通ってしまう。
    monkeypatch.setenv("ALLOWED_EMAIL_DOMAINS", "")

    for email in ("someone@gmail.com", "tester@example.co.jp"):
        with pytest.raises(AuthError) as e:
            clerk_auth.verify_token(make_token(email=email))
        assert e.value.status == 500
        assert "ALLOWED_EMAIL_DOMAINS" in str(e.value)


def test_external_users_are_refused_too_when_the_staff_domain_is_unset(monkeypatch):
    # 設定の漏れなので、外部ユーザーも含めて誰も通さない（README のとおり）。
    monkeypatch.setenv("ALLOWED_EMAIL_DOMAINS", "")
    monkeypatch.setenv("ALLOW_EXTERNAL_USERS", "true")

    with pytest.raises(AuthError) as e:
        clerk_auth.verify_token(make_token(email="partner@gmail.com"))
    assert e.value.status == 500


def test_azp_check_skipped_when_unset(monkeypatch):
    monkeypatch.setenv("CLERK_AUTHORIZED_PARTIES", "")

    user = clerk_auth.verify_token(make_token(azp="https://anywhere.example.com"))
    assert user.email == "tester@example.co.jp"


def test_missing_issuer_config_is_500(monkeypatch):
    monkeypatch.setenv("CLERK_ISSUER", "")

    with pytest.raises(AuthError) as e:
        clerk_auth.verify_token(make_token())
    assert e.value.status == 500


def test_missing_authorization_header_is_401():
    with pytest.raises(AuthError) as e:
        clerk_auth.user_from_authorization_header(None)
    assert e.value.status == 401


def test_non_bearer_authorization_header_is_401():
    with pytest.raises(AuthError):
        clerk_auth.user_from_authorization_header("Basic abc")
