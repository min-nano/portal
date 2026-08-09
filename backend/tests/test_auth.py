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
FRONTEND_ORIGIN = "https://portal.example.com"

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
    monkeypatch.setenv("CLERK_ISSUER", ISSUER)
    monkeypatch.setenv("CLERK_AUTHORIZED_PARTIES", FRONTEND_ORIGIN)
    monkeypatch.setenv("ALLOWED_EMAIL_DOMAINS", "example.co.jp")
    monkeypatch.setattr(clerk_auth, "_signing_key_for", lambda token: _PUBLIC_PEM)


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
    with pytest.raises(AuthError):
        clerk_auth.verify_token(make_token(iss="https://evil.example.com"))


def test_unlisted_azp_is_rejected():
    # 他サイト向けに発行されたトークンの流用（azp 不一致）を拒否する。
    with pytest.raises(AuthError) as e:
        clerk_auth.verify_token(make_token(azp="https://other.example.com"))
    assert "azp" in str(e.value)


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


def test_domain_check_skipped_when_unset(monkeypatch):
    monkeypatch.setenv("ALLOWED_EMAIL_DOMAINS", "")

    user = clerk_auth.verify_token(make_token(email="someone@gmail.com"))
    assert user.email == "someone@gmail.com"


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
