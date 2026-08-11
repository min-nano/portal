"""Google Drive へのアクセス（ユーザー代理 / domain-wide delegation）。

Clerk JWT で確認したメールアドレスのユーザーとして Drive を読み書きする。
GAS 版の「実行ユーザーの権限で DriveApp を読む」に相当し、雛形ファイルに
アクセス権のあるユーザーだけが雛形を取得できるという権限モデルをそのまま
維持する。ファイルを選ぶ操作自体はブラウザ側の公式 Google Picker が担うが、
選ばれた ID を実際に開けるかどうかはここでの代理アクセスで決まる。

スコープは用途で 2 段階に分けている:

  * delegated_session() …… drive.readonly。雛形の取得と、選ばれたファイルの
    確認だけを行う（現況検査レポート作成ツールはこちらだけで完結する）。
  * delegated_write_session() … drive + documents。構造計算安全証明書
    作成ツールが、雛形の Google ドキュメントを複製して差し替え、PDF を
    Drive へ保存するために使う。書き込みが必要な操作だけこちらを使う。

同じ仕組みで、ブラウザの Google Picker に渡す読み取り専用トークンも発行する
（delegated_access_token）。サーバーが API を呼ぶのではなくトークンだけを
返す点だけが違う。

JSON 鍵ファイルなしで動作するよう、Cloud Run 上ではランタイム
サービスアカウントの IAM Credentials API（signJwt）で署名する。この方式には
ランタイム SA が自分自身に対して roles/iam.serviceAccountTokenCreator を
持っている必要がある（README 参照）。ローカル開発では
GOOGLE_APPLICATION_CREDENTIALS に JSON 鍵を指定すればそのまま動く。
"""

import datetime

import google.auth
from google.auth import iam
from google.auth.transport.requests import AuthorizedSession, Request
from google.oauth2 import service_account

from . import config

DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly"
DRIVE_SCOPE = "https://www.googleapis.com/auth/drive"
DOCUMENTS_SCOPE = "https://www.googleapis.com/auth/documents"

_TOKEN_URI = "https://oauth2.googleapis.com/token"
_FILES_URL = "https://www.googleapis.com/drive/v3/files"
_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files"

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
GOOGLE_DOC_MIME = "application/vnd.google-apps.document"
FOLDER_MIME = "application/vnd.google-apps.folder"
PDF_MIME = "application/pdf"


class DriveError(Exception):
    """Drive 操作の失敗。message は利用者に表示できる日本語文。"""

    def __init__(self, message: str, status: int = 500):
        super().__init__(message)
        self.status = status


def _credentials(scopes: list[str], subject: str) -> service_account.Credentials:
    """subject のユーザー代理となるサービスアカウント資格情報を作る。"""
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
    return service_account.Credentials(
        signer=signer,
        service_account_email=sa_email,
        token_uri=_TOKEN_URI,
        scopes=scopes,
        subject=subject,
    )


def delegated_session(user_email: str) -> AuthorizedSession:
    """user_email の代理（読み取り専用）で Drive を呼ぶセッション。"""
    return AuthorizedSession(_credentials([DRIVE_READONLY_SCOPE], subject=user_email))


def delegated_write_session(user_email: str) -> AuthorizedSession:
    """user_email の代理で Drive へ書き込み、Docs を編集できるセッション。

    証明書の生成は「雛形の複製 → プレースホルダー置換 → PDF 書き出し →
    複製の削除 → Drive へ保存」という流れで、いずれも実行ユーザー本人の
    権限で行う。本人が書き込めない場所には保存できない。
    """
    return AuthorizedSession(
        _credentials([DRIVE_SCOPE, DOCUMENTS_SCOPE], subject=user_email)
    )


def _seconds_until(expiry) -> int:
    """トークンの残り有効秒数。

    google-auth の expiry は UTC の naive datetime だが、実装が変わっても
    壊れないよう aware も受け付ける。
    """
    if not expiry:
        return 0
    if expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=datetime.timezone.utc)
    remaining = (expiry - datetime.datetime.now(datetime.timezone.utc)).total_seconds()
    return max(0, int(remaining))


def delegated_access_token(user_email: str) -> tuple[str, int]:
    """user_email 本人の読み取り専用アクセストークンを発行する。

    ブラウザの公式 Google Picker へ渡すためのもの。Picker は選択画面を描く
    ために Drive を読むトークンを要求する。ブラウザ側で OAuth の同意を取る
    方式（Google Identity Services）もあるが、それだと画面の URL を OAuth
    クライアントの「承認済みの JavaScript 生成元」へ登録する必要があり、
    URL が毎回変わる PR プレビューでは使えない（この欄はワイルドカードが
    使えず、追加するための API も無い）。ここでは既にある代理アクセスの
    仕組みで本人のトークンを発行する。

    渡すのは drive.readonly のトークンで、本人が既に Drive で見られる範囲を
    超えない。書き込みは従来どおりサーバー側でしか行わない。
    """
    creds = _credentials([DRIVE_READONLY_SCOPE], subject=user_email)
    try:
        creds.refresh(Request())
    except Exception as error:  # RefreshError など。原因は Google の応答にある。
        detail = " ".join(str(error).split())
        if len(detail) > 300:
            detail = detail[:300] + "…"
        raise DriveError(
            "Google Drive のアクセストークンを取得できませんでした。"
            "domain-wide delegation の設定（クライアント ID とスコープの登録）を"
            "確認してください。"
            + (f"（Google からの応答: {detail}）" if detail else ""),
            502,
        )
    return creds.token, _seconds_until(creds.expiry)


def _escape_query_value(value: str) -> str:
    return value.replace("\\", "\\\\").replace("'", "\\'")


def api_error_detail(resp) -> str:
    """Google API のエラー応答から、原因を示す文言を取り出す。

    拒否の理由は「スコープが足りない」「API が有効化されていない」「本人に
    権限が無い」など複数ありうる。こちらで推測した案内だけを出すと利用者を
    誤った調査へ誘導してしまうため、Google 自身の説明を必ず添える。
    """
    try:
        error = (resp.json() or {}).get("error")
    except Exception:
        return ""
    if isinstance(error, str):
        message = error
    elif isinstance(error, dict):
        message = error.get("message") or ""
    else:
        return ""
    message = " ".join(str(message).split())
    # 長い説明（有効化用の URL を含むことがある）は途中で切る。
    return message if len(message) <= 300 else message[:300] + "…"


def _with_detail(message: str, resp) -> str:
    detail = api_error_detail(resp)
    return f"{message}（Google からの応答: {detail}）" if detail else message


def _raise_for_status(resp, context: str):
    if resp.status_code == 401 or resp.status_code == 403:
        raise DriveError(
            _with_detail(
                f"{context}が拒否されました (HTTP {resp.status_code})。"
                "GCP プロジェクトでの API の有効化、domain-wide delegation の設定"
                "（クライアント ID とスコープの登録）、ファイルへのアクセス権を"
                "確認してください。",
                resp,
            ),
            502,
        )
    if resp.status_code == 404:
        raise DriveError(
            _with_detail(f"{context}に失敗しました（ファイルが見つかりません）。", resp), 404
        )
    if not resp.ok:
        raise DriveError(
            _with_detail(f"{context}に失敗しました (HTTP {resp.status_code})。", resp), 502
        )


def get_file_metadata(session: AuthorizedSession, file_id: str) -> dict:
    resp = session.get(
        f"{_FILES_URL}/{file_id}",
        params={
            "fields": "id, name, mimeType, parents, trashed, webViewLink",
            "supportsAllDrives": "true",
        },
    )
    _raise_for_status(resp, "ファイル情報の取得")
    return resp.json()


def find_latest_file(
    session: AuthorizedSession, folder_id: str, file_name: str
) -> dict:
    """フォルダ内の同名ファイルのうち最新のもののメタデータを返す。

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
            "fields": "files(id, name, mimeType)",
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
    return files[0]


def fetch_latest_template(
    session: AuthorizedSession, folder_id: str, file_name: str
) -> bytes:
    """フォルダ内の同名ファイルのうち最新のものをダウンロードする。"""
    latest = find_latest_file(session, folder_id, file_name)
    return download_file(session, latest["id"], context="雛形のダウンロード")


def copy_file(session: AuthorizedSession, file_id: str, name: str) -> dict:
    """ファイルを複製する（複製先は実行ユーザーのマイドライブ）。

    雛形そのものを書き換えないよう、置換は必ず複製に対して行う。
    """
    resp = session.post(
        f"{_FILES_URL}/{file_id}/copy",
        params={"fields": "id, name", "supportsAllDrives": "true"},
        json={"name": name},
    )
    _raise_for_status(resp, "雛形の複製")
    return resp.json()


def export_file(session: AuthorizedSession, file_id: str, mime_type: str) -> bytes:
    """Google ドキュメント等を指定の形式へ書き出す。"""
    resp = session.get(
        f"{_FILES_URL}/{file_id}/export",
        params={"mimeType": mime_type},
    )
    _raise_for_status(resp, "PDF への書き出し")
    return resp.content


def delete_file(session: AuthorizedSession, file_id: str):
    """ファイルを完全に削除する（ゴミ箱に残さない）。"""
    resp = session.delete(
        f"{_FILES_URL}/{file_id}", params={"supportsAllDrives": "true"}
    )
    # 既に消えている場合は成功扱いにする（後片付けのための呼び出しのため）。
    if resp.status_code == 404:
        return
    _raise_for_status(resp, "一時ファイルの削除")


def create_file(
    session: AuthorizedSession,
    folder_id: str,
    name: str,
    content: bytes,
    mime_type: str,
) -> dict:
    """フォルダに新しいファイルを作成して内容をアップロードする。

    Drive のマルチパートアップロードは multipart/related を要求し、
    requests の files= が送る multipart/form-data とは別物のため、
    「メタデータだけ作成 → 本体を差し替え」の 2 段階で行う。
    """
    resp = session.post(
        _FILES_URL,
        params={"fields": "id", "supportsAllDrives": "true"},
        json={"name": name, "parents": [folder_id], "mimeType": mime_type},
    )
    _raise_for_status(resp, "ファイルの作成")
    file_id = resp.json()["id"]
    try:
        return update_file_content(session, file_id, content, mime_type)
    except Exception:
        # 本体のアップロードに失敗したら、中身の無いファイルを残さない。
        try:
            delete_file(session, file_id)
        except DriveError:
            # 後片付けの失敗は握りつぶす。利用者に伝えるべきなのは
            # 「アップロードに失敗した」ことであり、下の raise で送出する
            # 元の例外をこちらで置き換えてしまわないようにする。
            pass
        raise


def update_file_content(
    session: AuthorizedSession,
    file_id: str,
    content: bytes,
    mime_type: str,
) -> dict:
    """既存ファイルの内容を差し替える。

    Drive はファイル本体を差し替えると新しいリビジョンを作るため、上書き
    保存をしても直前の内容は版履歴から復元できる。keepRevisionForever は
    付けない（古い版は Drive の自動整理に任せ、一定期間が過ぎたら最新の
    ものだけが残ればよいという運用）。
    """
    resp = session.patch(
        f"{_UPLOAD_URL}/{file_id}",
        params={
            "uploadType": "media",
            "fields": "id, name, webViewLink, modifiedTime",
            "supportsAllDrives": "true",
        },
        data=content,
        headers={"Content-Type": mime_type},
    )
    _raise_for_status(resp, "ファイルの保存")
    return resp.json()


def download_file(
    session: AuthorizedSession, file_id: str, context: str = "ファイルのダウンロード"
) -> bytes:
    resp = session.get(
        f"{_FILES_URL}/{file_id}",
        params={"alt": "media", "supportsAllDrives": "true"},
    )
    _raise_for_status(resp, context)
    return resp.content
