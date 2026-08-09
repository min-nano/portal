"""全利用者共通の共有設定の読み書き（Firestore）。

GAS 版のスクリプトプロパティ（TEMPLATE_FOLDER_ID / TEMPLATE_FILE_NAME）に
相当する置き場。当初は Drive 上の JSON ファイルも検討したが、管理ユーザーが
ファイルを誤って編集・削除して設定を壊すリスクがあるため、人が直接触らない
Firestore に保存する。

コレクション tool_settings のドキュメント（ID = ツール名）に保存する:

  tool_settings/excel-report-formatter:
    {"template_folder_id": "...", "template_file_name": "..."}

アクセスには Cloud Run のランタイムサービスアカウントの ADC をそのまま使う。
ランタイム SA に roles/datastore.user を付与しておくこと（README 参照）。
"""

import threading

from google.cloud import firestore

from . import config

_COLLECTION = "tool_settings"

_client_instance = None
_client_lock = threading.Lock()


class SettingsError(Exception):
    """共有設定の読み書きの失敗。message は利用者に表示できる日本語文。"""

    def __init__(self, message: str, status: int = 500):
        super().__init__(message)
        self.status = status


def _client():
    # Firestore クライアントは接続を再利用できるためプロセス内で共有する。
    global _client_instance
    with _client_lock:
        if _client_instance is None:
            _client_instance = firestore.Client(database=config.firestore_database())
        return _client_instance


def _wrap_error(e: Exception) -> SettingsError:
    return SettingsError(
        "共有設定（Firestore）へのアクセスに失敗しました。Firestore API の有効化と、"
        f"ランタイムサービスアカウントへの roles/datastore.user の付与を確認してください: {e}"
    )


def get_tool_settings(tool: str) -> dict:
    try:
        snapshot = _client().collection(_COLLECTION).document(tool).get()
    except Exception as e:
        raise _wrap_error(e) from e
    if not snapshot.exists:
        return {}
    data = snapshot.to_dict()
    return data if isinstance(data, dict) else {}


def set_tool_settings(tool: str, values: dict):
    try:
        _client().collection(_COLLECTION).document(tool).set(values)
    except Exception as e:
        raise _wrap_error(e) from e
