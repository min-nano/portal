"""環境変数からの設定読み込み。

本番・PR プレビューとも、値の出どころは GitHub のリポジトリ変数で、デプロイの
たびにワークフローが --set-env-vars で Cloud Run のサービスへ渡す（README
「ランタイム環境変数の出どころ」参照）。GCP 側に手で設定して覚えさせておく値は
無いので、サービスの環境変数はワークフローの内容と常に一致する。
テストから環境変数を差し替えられるよう、モジュール読み込み時ではなく
参照のたびに os.environ を読む。
"""

import os


def _csv(name: str) -> list[str]:
    return [v.strip() for v in os.environ.get(name, "").split(",") if v.strip()]


def clerk_issuers() -> list[str]:
    """許可する Clerk の Frontend API の URL（JWT の iss。カンマ区切りで複数可）。

    例: https://clerk.example.com（本番インスタンス）
        https://xxxx.clerk.accounts.dev（開発インスタンス。PR プレビューで使用）
    本番と PR プレビュー（開発インスタンス）を同じバックエンドで受けるため、
    両方を列挙できるようにしている。
    """
    return [v.rstrip("/") for v in _csv("CLERK_ISSUER")]


def clerk_authorized_parties() -> list[str]:
    """Clerk セッション JWT の azp として許可するフロントエンドのオリジン。

    カンマ区切りで複数指定でき、fnmatch 形式のワイルドカードが使える。
    PR プレビューの URL はデプロイごとに変わるためパターンで許可する。
    例: https://<project>.web.app,https://<project>--pr-*.web.app
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


def picker_api_key() -> str:
    """公式 Google Picker に渡す API キー（ブラウザキー）。

    ページに埋め込まれる公開情報で、悪用の防止はキー側の HTTP リファラー
    制限で行う（こちらはワイルドカードが使えるので、PR プレビューの URL も
    まとめて許可できる）。Picker の表示に使うアクセストークンは、この鍵とは
    別にバックエンドが代理発行する（google_drive.delegated_access_token）。
    """
    return os.environ.get("GOOGLE_PICKER_API_KEY", "").strip()


def picker_app_id() -> str:
    """（任意）Picker に渡すアプリ ID（＝ GCP のプロジェクト番号）。

    drive.file スコープでは必須だが、こちらは drive.readonly のトークンを
    渡すため無くても動く。未設定なら Picker には渡さない。
    """
    return os.environ.get("GOOGLE_PICKER_APP_ID", "").strip()


def firestore_database() -> str:
    """共有設定の保存先 Firestore データベース名。通常は既定の "(default)"。"""
    return os.environ.get("FIRESTORE_DATABASE", "(default)")


# 環境変数が未設定のときに使うチャンネル。本番ではなく development を
# 指しているのは意図的（下の settings_channel_path を参照）。
DEFAULT_SETTINGS_CHANNEL_PATH = "static-channels/development"


def settings_channel_path() -> str:
    """共有設定を置くチャンネルの Firestore ドキュメントパス。

    同じデータベース内をチャンネル単位で分割し、本番・開発・PR プレビューが
    互いのデータを踏まないようにする:

      static-channels/production   本番（main）
      static-channels/development  既定・ローカル開発
      preview-channels/pr-<番号>   PR プレビュー

    環境ごとに変わるのはここまでで、この下にどんなコレクションを置くかは
    アプリ側の都合（settings_store を参照）。

    既定を development にしているのは、環境変数の設定漏れ・ローカル開発・
    壊れたワークフローのいずれもが本番データに到達しないようにするため。
    本番の Cloud Run にだけ SETTINGS_CHANNEL_PATH を明示的に設定する運用に
    することで、「本番を汚す」は起こらず、設定ミスの症状は必ず「設定が空に
    見える」になる。
    """
    return os.environ.get(
        "SETTINGS_CHANNEL_PATH", DEFAULT_SETTINGS_CHANNEL_PATH
    ).strip("/")


def cors_allowed_origins() -> list[str]:
    """CORS を許可するオリジン。

    本番は Firebase Hosting のリライトで同一オリジンになるため通常は不要。
    ローカル開発（Vite の dev サーバーがプロキシしない構成）向け。
    """
    return _csv("CORS_ALLOWED_ORIGINS") or ["http://localhost:5173"]
