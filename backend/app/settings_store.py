"""全利用者共通の共有設定の読み書き。

GAS 版のスクリプトプロパティ（TEMPLATE_FOLDER_ID / TEMPLATE_FILE_NAME）に
相当する置き場として、Workspace の Drive 上に置いた JSON ファイルを使う。
ファイルはサービスアカウント自身の権限で読み書きするため、あらかじめ

  1. Drive 上に JSON ファイル（中身は {} でよい）を作成し、
  2. サービスアカウントのメールアドレスに「編集者」で共有し、
  3. そのファイル ID を Cloud Run の環境変数 SETTINGS_FILE_ID に設定する。

設定はツール名で名前空間を切って保存する（将来ツールが増えても 1 ファイル）:

  {"excel-report-formatter": {"template_folder_id": "...", "template_file_name": "..."}}
"""

import json

from . import config, google_drive

SETTINGS_MIME = "application/json"


def _settings_file_id() -> str:
    file_id = config.settings_file_id()
    if not file_id:
        raise google_drive.DriveError(
            "サーバーの設定（SETTINGS_FILE_ID）が未設定のため、共有設定を保存できません。",
            500,
        )
    return file_id


def load_all(session) -> dict:
    raw = google_drive.download_file(
        session, _settings_file_id(), context="設定ファイルの読み込み"
    )
    if not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except ValueError as e:
        raise google_drive.DriveError(
            f"設定ファイル（SETTINGS_FILE_ID）を JSON として読み込めませんでした: {e}",
            500,
        ) from e
    return data if isinstance(data, dict) else {}


def get_tool_settings(session, tool: str) -> dict:
    values = load_all(session).get(tool)
    return values if isinstance(values, dict) else {}


def set_tool_settings(session, tool: str, values: dict):
    settings = load_all(session)
    settings[tool] = values
    google_drive.upload_file_content(
        session,
        _settings_file_id(),
        json.dumps(settings, ensure_ascii=False, indent=2).encode("utf-8"),
        SETTINGS_MIME,
    )
