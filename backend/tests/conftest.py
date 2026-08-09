"""API テスト用の共通フィクスチャ。

Drive・共有設定・認証を偽物に差し替え、ルートハンドラのロジック
（バリデーション・エラー応答・Excel 生成）を実際に通して検証する。
"""

import pytest
from fastapi.testclient import TestClient

from app import main
from app.clerk_auth import User
from app.google_drive import DriveError
from tests.util import make_template_bytes

TEST_EMAIL = "tester@example.co.jp"
TOOL = main.TOOL_EXCEL_REPORT


class FakeDrive:
    """Drive と共有設定の代役。テストから状態を注入・観測する。"""

    def __init__(self):
        self.settings = {}  # tool 名 -> 設定 dict
        self.template_bytes = None  # fetch_latest_template が返すバイト列
        self.metadata = {}  # file_id -> files.get のメタデータ
        self.search_results = []
        self.saved = []  # set_tool_settings の呼び出し記録
        self.fetch_calls = []  # fetch_latest_template の呼び出し記録
        self.delegated_emails = []  # 代理セッションを要求されたメールアドレス

    def configure_template(self, folder_id="folder-1", file_name="雛形.xlsx"):
        self.settings[TOOL] = {
            "template_folder_id": folder_id,
            "template_file_name": file_name,
        }
        if self.template_bytes is None:
            self.template_bytes = make_template_bytes()


@pytest.fixture
def drive(monkeypatch):
    fake = FakeDrive()

    def delegated_session(email):
        fake.delegated_emails.append(email)
        return ("delegated", email)

    monkeypatch.setattr(main.google_drive, "delegated_session", delegated_session)
    monkeypatch.setattr(main.google_drive, "service_session", lambda: "service")

    monkeypatch.setattr(
        main.settings_store,
        "get_tool_settings",
        lambda session, tool: fake.settings.get(tool, {}),
    )

    def set_tool_settings(session, tool, values):
        fake.settings[tool] = values
        fake.saved.append((tool, values))

    monkeypatch.setattr(main.settings_store, "set_tool_settings", set_tool_settings)

    def fetch_latest_template(session, folder_id, file_name):
        fake.fetch_calls.append((folder_id, file_name))
        if fake.template_bytes is None:
            raise DriveError(
                f"指定フォルダ内に雛形ファイル「{file_name}」が見つかりませんでした。", 404
            )
        return fake.template_bytes

    monkeypatch.setattr(
        main.google_drive, "fetch_latest_template", fetch_latest_template
    )

    def get_file_metadata(session, file_id):
        if file_id not in fake.metadata:
            raise DriveError("ファイル情報の取得に失敗しました（ファイルが見つかりません）。", 404)
        return fake.metadata[file_id]

    monkeypatch.setattr(main.google_drive, "get_file_metadata", get_file_metadata)
    monkeypatch.setattr(
        main.google_drive, "search_xlsx_files", lambda session, q: fake.search_results
    )
    return fake


@pytest.fixture
def client(drive):
    """認証済みユーザー（TEST_EMAIL）としてアクセスするテストクライアント。"""
    main.app.dependency_overrides[main.require_user] = lambda: User(email=TEST_EMAIL)
    with TestClient(main.app, raise_server_exceptions=False) as c:
        yield c
    main.app.dependency_overrides.clear()


@pytest.fixture
def anon_client(drive):
    """認証をバイパスしない（Authorization ヘッダーが実際に検証される）クライアント。"""
    with TestClient(main.app, raise_server_exceptions=False) as c:
        yield c
