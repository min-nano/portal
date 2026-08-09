"""Clerk セッション JWT の検証。

フロントエンド（Firebase Hosting 上の SPA）は、Clerk でサインインした
セッションのトークンを Authorization: Bearer ヘッダーに付けて API を呼ぶ。
ここでは GAS 版の「実行ユーザーとして実行」に相当する本人確認として、
以下を検証したうえでメールアドレスを取り出す。

  1. 署名: Clerk の JWKS（{issuer}/.well-known/jwks.json）による RS256 検証
  2. exp / nbf / iss（有効期限と発行者）
  3. azp が CLERK_AUTHORIZED_PARTIES のいずれかであること
     （他サイト向けに発行されたトークンの流用を防ぐ）
  4. email クレームの存在
  5. メールドメインが ALLOWED_EMAIL_DOMAINS に含まれること

email は Clerk の既定のセッショントークンには含まれないため、Clerk
ダッシュボードの Sessions → Customize session token で

    {"email": "{{user.primary_email_address}}"}

を設定しておく必要がある（README 参照）。ここで得たメールアドレスが、
そのまま Workspace API の代理アクセス（domain-wide delegation）の
impersonate 対象になる。
"""

import threading
from dataclasses import dataclass

import jwt
from jwt import PyJWKClient

from . import config

# JWT の検証時刻に許容するずれ（秒）。Clerk のトークンは短命（約 60 秒）で、
# サーバー間のわずかな時計ずれで nbf 検証に失敗しやすいため少し許容する。
_CLOCK_LEEWAY_SECONDS = 10

_jwk_client: PyJWKClient | None = None
_jwk_client_url: str | None = None
_jwk_lock = threading.Lock()


class AuthError(Exception):
    """認証・認可の失敗。status は HTTP ステータスコード。"""

    def __init__(self, message: str, status: int = 401):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class User:
    email: str


def _signing_key_for(token: str):
    """トークンの kid に対応する公開鍵を Clerk の JWKS から取得する。

    PyJWKClient は鍵をキャッシュするため、リクエストごとに JWKS への
    HTTP アクセスは発生しない。テストではこの関数を差し替える。
    """
    global _jwk_client, _jwk_client_url
    jwks_url = config.clerk_issuer() + "/.well-known/jwks.json"
    with _jwk_lock:
        if _jwk_client is None or _jwk_client_url != jwks_url:
            _jwk_client = PyJWKClient(jwks_url, cache_keys=True)
            _jwk_client_url = jwks_url
        client = _jwk_client
    return client.get_signing_key_from_jwt(token).key


def verify_token(token: str) -> User:
    issuer = config.clerk_issuer()
    if not issuer:
        raise AuthError("サーバーの認証設定（CLERK_ISSUER）が未設定です。", 500)

    try:
        key = _signing_key_for(token)
        claims = jwt.decode(
            token,
            key,
            algorithms=["RS256"],
            issuer=issuer,
            leeway=_CLOCK_LEEWAY_SECONDS,
            # Clerk のセッショントークンに aud は含まれない。トークンの
            # 発行先の確認は aud ではなく azp（authorized party）で行う。
            options={"verify_aud": False, "require": ["exp", "iat"]},
        )
    except jwt.PyJWTError as e:
        raise AuthError(f"認証トークンを検証できませんでした: {e}") from e

    authorized_parties = config.clerk_authorized_parties()
    azp = claims.get("azp")
    if authorized_parties and azp not in authorized_parties:
        raise AuthError("認証トークンの発行元オリジン (azp) が許可されていません。")

    email = claims.get("email")
    if not email or not isinstance(email, str):
        raise AuthError(
            "認証トークンに email クレームが含まれていません。Clerk ダッシュボードの "
            "Sessions → Customize session token で "
            '{"email": "{{user.primary_email_address}}"} を設定してください。'
        )

    domains = config.allowed_email_domains()
    if domains:
        email_domain = email.rpartition("@")[2].lower()
        if email_domain not in [d.lower() for d in domains]:
            raise AuthError(
                f"このアプリは社内アカウント専用です（{email} は利用できません）。", 403
            )

    return User(email=email)


def user_from_authorization_header(authorization: str | None) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        raise AuthError("サインインが必要です（Authorization ヘッダーがありません）。")
    return verify_token(authorization.removeprefix("Bearer ").strip())
