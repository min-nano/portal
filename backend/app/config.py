"""環境変数からの設定読み込み。

Cloud Run のサービスに一度だけ設定する運用を想定している（デプロイごとに
--set-env-vars を渡す必要はなく、既存のサービス設定が引き継がれる）。
テストから環境変数を差し替えられるよう、モジュール読み込み時ではなく
参照のたびに os.environ を読む。
"""

import os


def _csv(name: str) -> list[str]:
    return [v.strip() for v in os.environ.get(name, "").split(",") if v.strip()]


def clerk_issuer() -> str:
    """Clerk の Frontend API の URL（JWT の iss と一致させる）。

    例: https://xxxx.clerk.accounts.dev（開発インスタンス）
        https://clerk.example.com（本番インスタンス）
    """
    return os.environ.get("CLERK_ISSUER", "").rstrip("/")


def clerk_authorized_parties() -> list[str]:
    """Clerk セッション JWT の azp として許可するフロントエンドのオリジン。

    例: https://<project>.web.app,http://localhost:5173
    未設定の場合は azp 検証をスキップする（ローカル開発用。本番では必ず設定する）。
    """
    return _csv("CLERK_AUTHORIZED_PARTIES")


def allowed_email_domains() -> list[str]:
    """利用を許可する Workspace のメールドメイン（例: example.co.jp）。

    未設定の場合はドメイン検証をスキップするが、その場合でも代理アクセス
    （domain-wide delegation）は Workspace 外のユーザーには発行されないため、
    Drive へのアクセスはドメイン内ユーザーに限られる。
    """
    return _csv("ALLOWED_EMAIL_DOMAINS")


def delegated_sa_email() -> str:
    """ユーザー代理（domain-wide delegation）に使うサービスアカウントのメール。

    未設定の場合はランタイムの Application Default Credentials から推定する。
    """
    return os.environ.get("DWD_SERVICE_ACCOUNT_EMAIL", "")


def firestore_database() -> str:
    """共有設定の保存先 Firestore データベース名。通常は既定の "(default)"。"""
    return os.environ.get("FIRESTORE_DATABASE", "(default)")


def cors_allowed_origins() -> list[str]:
    """CORS を許可するオリジン。

    本番は Firebase Hosting のリライトで同一オリジンになるため通常は不要。
    ローカル開発（Vite の dev サーバーがプロキシしない構成）向け。
    """
    return _csv("CORS_ALLOWED_ORIGINS") or ["http://localhost:5173"]
