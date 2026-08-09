"""Google Drive へのアクセス。

2 種類の資格情報を使い分ける。

1. ユーザー代理（domain-wide delegation）
   Clerk JWT で確認したメールアドレスのユーザーとして Drive を読む。
   GAS 版の「実行ユーザーの権限で DriveApp を読む」に相当し、雛形ファイルに
   アクセス権のあるユーザーだけが雛形を取得・検索できるという権限モデルを
   そのまま維持する。スコープは読み取り専用（drive.readonly）に限定。

2. サービスアカウント自身
   全利用者共通の設定ファイル（SETTINGS_FILE_ID の JSON）の読み書きにのみ使う。
   設定ファイルをサービスアカウントのメールに共有しておくことで、delegation の
   スコープを広げずに共有設定を保存できる。

どちらも JSON 鍵ファイルなしで動作するよう、Cloud Run 上ではランタイム
サービスアカウントの IAM Credentials API（signJwt）で署名する。この方式には
ランタイム SA が自分自身に対して roles/iam.serviceAccountTokenCreator を
持っている必要がある（README 参照）。ローカル開発では
GOOGLE_APPLICATION_CREDENTIALS に JSON 鍵を指定すればそのまま動く。
"""

import google.auth
from google.auth import iam
from google.auth.transport.requests import AuthorizedSession, Request
from google.oauth2 import service_account

from . import config

DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly"
DRIVE_SCOPE = "https://www.googleapis.com/auth/drive"

_TOKEN_URI = "https://oauth2.googleapis.com/token"
_FILES_URL = "https://www.googleapis.com/drive/v3/files"
_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files"

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


class DriveError(Exception):
    """Drive 操作の失敗。message は利用者に表示できる日本語文。"""

    def __init__(self, message: str, status: int = 500):
        super().__init__(message)
        self.status = status


def _credentials(scopes: list[str], subject: str | None = None):
    """サービスアカウント資格情報を作る。subject を渡すとそのユーザーの代理になる。"""
    source, _ = google.auth.default()

    # ローカル開発: JSON 鍵ファイル（service_account.Credentials）ならそのまま使う。
    if isinstance(source, service_account.Credentials):
        creds = source.with_scopes(scopes)
        if subject:
            creds = creds.with_subject(subject)
        return creds

    # Cloud Run: 鍵ファイルなし。IAM Credentials API で署名する。
    sa_email = config.delegated_sa_email() or getattr(
        source, "service_account_email", ""
    )
    if not sa_email or sa_email == "default":
        # metadata server から実際のメールアドレスを確定させる。
        source.refresh(Request())
        sa_email = getattr(source, "service_account_email", "")
    if not sa_email or sa_email == "default":
        raise DriveError(
            "サービスアカウントを特定できませんでした。環境変数 "
            "DWD_SERVICE_ACCOUNT_EMAIL を設定してください。"
        )

    signer = iam.Signer(Request(), source, sa_email)
    kwargs = {"subject": subject} if subject else {}
    return service_account.Credentials(
        signer=signer,
        service_account_email=sa_email,
        token_uri=_TOKEN_URI,
        scopes=scopes,
        **kwargs,
    )


def delegated_session(user_email: str) -> AuthorizedSession:
    """user_email の代理（読み取り専用）で Drive を呼ぶセッション。"""
    return AuthorizedSession(_credentials([DRIVE_READONLY_SCOPE], subject=user_email))


def service_session() -> AuthorizedSession:
    """サービスアカウント自身として Drive を呼ぶセッション（設定ファイル専用）。"""
    return AuthorizedSession(_credentials([DRIVE_SCOPE]))


def _escape_query_value(value: str) -> str:
    return value.replace("\\", "\\\\").replace("'", "\\'")


def _raise_for_status(resp, context: str):
    if resp.status_code == 401 or resp.status_code == 403:
        raise DriveError(
            f"{context}が拒否されました (HTTP {resp.status_code})。"
            "domain-wide delegation の設定（クライアント ID とスコープの登録）と、"
            "ファイルへのアクセス権を確認してください。",
            502,
        )
    if resp.status_code == 404:
        raise DriveError(f"{context}に失敗しました（ファイルが見つかりません）。", 404)
    if not resp.ok:
        raise DriveError(f"{context}に失敗しました (HTTP {resp.status_code})。", 502)


def get_file_metadata(session: AuthorizedSession, file_id: str) -> dict:
    resp = session.get(
        f"{_FILES_URL}/{file_id}",
        params={
            "fields": "id, name, mimeType, parents, trashed",
            "supportsAllDrives": "true",
        },
    )
    _raise_for_status(resp, "ファイル情報の取得")
    return resp.json()


def search_xlsx_files(session: AuthorizedSession, name_query: str) -> list[dict]:
    """ファイル名で .xlsx を検索する（Google Picker の代替となる選択 UI 用）。

    実行ユーザーの代理で検索するため、本人に閲覧権限のあるファイルだけが
    候補に挙がる。
    """
    q = (
        f"name contains '{_escape_query_value(name_query)}' "
        f"and mimeType = '{XLSX_MIME}' and trashed = false"
    )
    resp = session.get(
        _FILES_URL,
        params={
            "q": q,
            "orderBy": "modifiedTime desc",
            "pageSize": "20",
            "fields": "files(id, name, modifiedTime, parents)",
            "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true",
            "corpora": "allDrives",
        },
    )
    _raise_for_status(resp, "雛形候補の検索")
    return resp.json().get("files", [])


def fetch_latest_template(
    session: AuthorizedSession, folder_id: str, file_name: str
) -> bytes:
    """フォルダ内の同名ファイルのうち最新のものをダウンロードする。

    GAS 版 fetchTemplateBase64_ と同じ追従ルール: フォーマットが同じフォルダに
    同名で差し替えられても、最終更新日時が最も新しいもの（ゴミ箱は除く）を
    自動的に採用する。
    """
    q = (
        f"'{_escape_query_value(folder_id)}' in parents "
        f"and name = '{_escape_query_value(file_name)}' and trashed = false"
    )
    resp = session.get(
        _FILES_URL,
        params={
            "q": q,
            "orderBy": "modifiedTime desc",
            "pageSize": "1",
            "fields": "files(id, name)",
            "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true",
        },
    )
    _raise_for_status(resp, "雛形の検索")
    files = resp.json().get("files", [])
    if not files:
        raise DriveError(
            f"指定フォルダ内に雛形ファイル「{file_name}」が見つかりませんでした。"
            "フォーマットが差し替えられた可能性があります。「雛形を設定」から選び直してください。",
            404,
        )
    return download_file(session, files[0]["id"], context="雛形のダウンロード")


def download_file(
    session: AuthorizedSession, file_id: str, context: str = "ファイルのダウンロード"
) -> bytes:
    resp = session.get(
        f"{_FILES_URL}/{file_id}",
        params={"alt": "media", "supportsAllDrives": "true"},
    )
    _raise_for_status(resp, context)
    return resp.content


def upload_file_content(
    session: AuthorizedSession, file_id: str, content: bytes, mime_type: str
):
    resp = session.patch(
        f"{_UPLOAD_URL}/{file_id}",
        params={"uploadType": "media", "supportsAllDrives": "true"},
        data=content,
        headers={"Content-Type": mime_type},
    )
    _raise_for_status(resp, "設定ファイルの保存")
