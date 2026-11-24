"""Clerk セッション JWT の検証。

フロントエンド（Firebase Hosting 上の SPA）は、Clerk でサインインした
セッションのトークンを Authorization: Bearer ヘッダーに付けて API を呼ぶ。
ここでは GAS 版の「実行ユーザーとして実行」に相当する本人確認として、
以下を検証したうえでメールアドレスを取り出す。

  1. iss が CLERK_ISSUER に列挙した発行者のいずれかであること
     （本番インスタンスに加え、PR プレビュー用の開発インスタンスを併記できる）
  2. 署名: その発行者の JWKS（{issuer}/.well-known/jwks.json）による RS256 検証
  3. exp / nbf（有効期限）
  4. azp が CLERK_AUTHORIZED_PARTIES のいずれかにマッチすること
     （他サイト向けに発行されたトークンの流用を防ぐ。PR プレビューの URL は
     デプロイごとに変わるため fnmatch 形式のワイルドカードを許可する）
  5. email クレームの存在
  6. メールアドレスが ALLOWED_EXTERNAL_EMAILS に載っている（外部ユーザー）か、
     メールドメインが ALLOWED_EMAIL_DOMAINS に含まれる（社内ユーザー）こと

email は Clerk の既定のセッショントークンには含まれないため、Clerk
ダッシュボードの Sessions → Customize session token で

    {"email": "{{user.primary_email_address}}"}

を設定しておく必要がある（README 参照）。社内ユーザーでは、ここで得た
メールアドレスがそのまま Workspace API の代理アクセス（domain-wide
delegation）の impersonate 対象になる。

外部ユーザー（組織外の Google アカウント）は、代理アクセスが効かない
（Workspace の外のアカウントにはなりかわれない）ため、Drive を使わない
機能だけを使える。Drive を使う入口と全員共通の設定の書き換えは
portal_sdk が断る（README「外部ユーザー」）。
"""

import fnmatch
import threading
from dataclasses import dataclass

import jwt
from jwt import PyJWKClient

from . import config
from .errors import PortalError

# JWT の検証時刻に許容するずれ（秒）。Clerk のトークンは短命（約 60 秒）で、
# サーバー間のわずかな時計ずれで nbf 検証に失敗しやすいため少し許容する。
_CLOCK_LEEWAY_SECONDS = 10

# 発行者（JWKS URL）ごとの PyJWKClient キャッシュ。
_jwk_clients: dict[str, PyJWKClient] = {}
_jwk_lock = threading.Lock()


# どちらの許可リストにも無いアカウント。画面はこの目印で見分け、ツールを
# 閉じて理由を出す（ほかの 403——プロキシなど——と取り違えないため）。
ACCOUNT_NOT_ALLOWED = "account_not_allowed"


class AuthError(PortalError):
    """認証・認可の失敗。status は HTTP ステータスコード。"""

    def __init__(self, message: str, status: int = 401, code: str | None = None):
        super().__init__(message, status, code)


@dataclass(frozen=True)
class User:
    email: str
    # 組織外のアカウント（ALLOWED_EXTERNAL_EMAILS で個別に許可したもの）か。
    # False だと Drive の代理アクセスまで通るので、既定値は置かない（作る側が
    # 必ず決める。書き忘れた User が黙って社内ユーザーになることがないように）。
    external: bool


def _signing_key_for(token: str, issuer: str):
    """トークンの kid に対応する公開鍵を、その発行者の JWKS から取得する。

    PyJWKClient は鍵をキャッシュするため、リクエストごとに JWKS への
    HTTP アクセスは発生しない。テストではこの関数を差し替える。
    """
    jwks_url = issuer + "/.well-known/jwks.json"
    with _jwk_lock:
        client = _jwk_clients.get(jwks_url)
        if client is None:
            client = PyJWKClient(jwks_url, cache_keys=True)
            _jwk_clients[jwks_url] = client
    return client.get_signing_key_from_jwt(token).key


def _token_issuer(token: str, allowed_issuers: list[str]) -> str:
    """署名検証前にトークンの iss を読み、許可リストと突き合わせる。

    ここで返した発行者の JWKS で署名を検証し、jwt.decode の issuer 検証にも
    同じ値を渡すため、許可リスト外の発行者の鍵で検証することはない。
    """
    try:
        unverified = jwt.decode(token, options={"verify_signature": False})
    except jwt.PyJWTError as e:
        raise AuthError(f"認証トークンを解析できませんでした: {e}") from e
    issuer = str(unverified.get("iss", "")).rstrip("/")
    if issuer not in allowed_issuers:
        raise AuthError("認証トークンの発行者 (iss) が許可されていません。")
    return issuer


def _azp_allowed(azp, patterns: list[str]) -> bool:
    # PR プレビューの URL（https://<project>--pr-N-<hash>.web.app）のように
    # 動的なオリジンを許可できるよう、fnmatch のワイルドカードで照合する。
    # ワイルドカードを含まないパターンは完全一致として振る舞う。
    return isinstance(azp, str) and any(
        fnmatch.fnmatchcase(azp, pattern) for pattern in patterns
    )


def verify_token(token: str) -> User:
    issuers = config.clerk_issuers()
    if not issuers:
        raise AuthError("サーバーの認証設定（CLERK_ISSUER）が未設定です。", 500)

    issuer = _token_issuer(token, issuers)
    try:
        key = _signing_key_for(token, issuer)
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
    if authorized_parties and not _azp_allowed(claims.get("azp"), authorized_parties):
        raise AuthError("認証トークンの発行元オリジン (azp) が許可されていません。")

    email = claims.get("email")
    if not email or not isinstance(email, str):
        raise AuthError(
            "認証トークンに email クレームが含まれていません。Clerk ダッシュボードの "
            "Sessions → Customize session token で "
            '{"email": "{{user.primary_email_address}}"} を設定してください。'
        )

    # 個別に許可した外部アカウントは、ドメインの判定より先に見る。社内の
    # ドメインに当たる場合でも外部として扱う（できることが少ない側に倒す）。
    if email.lower() in [e.lower() for e in config.allowed_external_emails()]:
        return User(email=email, external=True)

    # 社内ドメインが未設定なら、誰も通さない（設定の漏れとして 500）。以前は
    # 判定を飛ばして全員を通していたが、外部ユーザーのために確認コードでの
    # サインインを有効にすると、どのメールアドレスでもここまで来られるので、
    # 全員が社内ユーザー（Drive の代理アクセスまで通る）扱いになってしまう。
    domains = config.allowed_email_domains()
    if not domains:
        raise AuthError("サーバーの認証設定（ALLOWED_EMAIL_DOMAINS）が未設定です。", 500)
    local_part, _, email_domain = email.lower().rpartition("@")
    # 社内ドメインでも、+ を含むアドレス（サブアドレス）は社内ユーザーにしない。
    # Workspace のアドレスには + を使えないので社員は困らない一方、Clerk の
    # テストモード（開発インスタンスは既定でオン）では、+clerk_test を含む
    # アドレスがメールを受け取らずに固定のコードで通ってしまうため。
    if email_domain not in [d.lower() for d in domains] or "+" in local_part:
        raise AuthError(
            f"このアプリは許可されたアカウント専用です（{email} は利用できません）。",
            403,
            ACCOUNT_NOT_ALLOWED,
        )

    return User(email=email, external=False)


def user_from_authorization_header(authorization: str | None) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        raise AuthError("サインインが必要です（Authorization ヘッダーがありません）。")
    return verify_token(authorization.removeprefix("Bearer ").strip())
