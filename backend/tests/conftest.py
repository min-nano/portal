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
CERT_TOOL = main.TOOL_STRUCTURAL_CERT

GOOGLE_DOC_MIME = "application/vnd.google-apps.document"
FOLDER_MIME = "application/vnd.google-apps.folder"
PDF_MIME = "application/pdf"


class FakeDrive:
    """Drive・Docs と共有設定の代役。テストから状態を注入・観測する。"""

    def __init__(self):
        self.settings = {}  # tool 名 -> 設定 dict
        self.template_bytes = None  # fetch_latest_template が返すバイト列
        self.metadata = {}  # file_id -> files.get のメタデータ
        self.saved = []  # set_tool_settings の呼び出し記録
        self.fetch_calls = []  # fetch_latest_template の呼び出し記録
        self.delegated_emails = []  # 読み取り代理セッションを要求されたメール
        self.write_emails = []  # 書き込み代理セッションを要求されたメール
        self.token_emails = []  # Picker 用トークンを要求されたメール
        self.access_token = ("picker-token", 3600)  # (トークン, 残り秒数)

        # 構造計算安全証明書ツール用。
        self.doc_template = None  # find_latest_file が返すメタデータ
        self.export_bytes = b""  # Google ドキュメントの PDF 書き出し結果
        self.download_bytes = b""  # download_file が返すバイト列
        self.replace_counts = None  # replace_all_text の戻り値（None なら全件 1）
        self.copies = []  # (元 file_id, 複製名)
        self.deleted = []  # 完全削除された file_id
        self.created = []  # (folder_id, name, bytes, mime)
        self.updated = []  # (file_id, bytes, mime)
        self.replaced = []  # replace_all_text に渡された置換表

    def configure_template(self, folder_id="folder-1", file_name="雛形.xlsx"):
        self.settings[TOOL] = {
            "template_folder_id": folder_id,
            "template_file_name": file_name,
        }
        if self.template_bytes is None:
            self.template_bytes = make_template_bytes()

    def configure_certificate(
        self,
        folder_id="doc-folder",
        file_name="安全証明書 雛形",
        output_folder_id="out-folder",
        output_folder_name="証明書",
        export_bytes=None,
    ):
        """雛形（Google ドキュメント）と保存先フォルダを設定済みにする。"""
        settings = {}
        if folder_id and file_name:
            settings["template_folder_id"] = folder_id
            settings["template_file_name"] = file_name
        if output_folder_id:
            settings["output_folder_id"] = output_folder_id
            settings["output_folder_name"] = output_folder_name
        self.settings[CERT_TOOL] = settings
        self.doc_template = {
            "id": "template-doc",
            "name": file_name,
            "mimeType": GOOGLE_DOC_MIME,
        }
        if export_bytes is not None:
            self.export_bytes = export_bytes


@pytest.fixture
def drive(monkeypatch):
    fake = FakeDrive()

    def delegated_session(email):
        fake.delegated_emails.append(email)
        return ("delegated", email)

    monkeypatch.setattr(main.google_drive, "delegated_session", delegated_session)

    def delegated_access_token(email):
        fake.token_emails.append(email)
        return fake.access_token

    monkeypatch.setattr(
        main.google_drive, "delegated_access_token", delegated_access_token
    )

    monkeypatch.setattr(
        main.settings_store,
        "get_tool_settings",
        lambda tool: fake.settings.get(tool, {}),
    )

    def set_tool_settings(tool, values):
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

    # --- 構造計算安全証明書ツールが使う Drive / Docs 操作 -------------------

    def delegated_write_session(email):
        fake.write_emails.append(email)
        return ("write", email)

    monkeypatch.setattr(
        main.google_drive, "delegated_write_session", delegated_write_session
    )

    def find_latest_file(session, folder_id, file_name):
        fake.fetch_calls.append((folder_id, file_name))
        if fake.doc_template is None:
            raise DriveError(
                f"指定フォルダ内に雛形ファイル「{file_name}」が見つかりませんでした。", 404
            )
        return fake.doc_template

    monkeypatch.setattr(main.google_drive, "find_latest_file", find_latest_file)

    def copy_file(session, file_id, name):
        fake.copies.append((file_id, name))
        return {"id": f"copy-of-{file_id}", "name": name}

    monkeypatch.setattr(main.google_drive, "copy_file", copy_file)
    monkeypatch.setattr(
        main.google_drive, "export_file", lambda session, fid, mime: fake.export_bytes
    )
    monkeypatch.setattr(
        main.google_drive,
        "download_file",
        lambda session, fid, context="ファイルのダウンロード": fake.download_bytes,
    )
    monkeypatch.setattr(
        main.google_drive,
        "delete_file",
        lambda session, fid: fake.deleted.append(fid),
    )

    def create_file(session, folder_id, name, content, mime_type):
        fake.created.append((folder_id, name, content, mime_type))
        return {
            "id": "new-file",
            "name": name,
            "webViewLink": "https://drive.example/new-file",
        }

    monkeypatch.setattr(main.google_drive, "create_file", create_file)

    def update_file_content(session, file_id, content, mime_type):
        fake.updated.append((file_id, content, mime_type))
        return {
            "id": file_id,
            "name": fake.metadata.get(file_id, {}).get("name", ""),
            "webViewLink": f"https://drive.example/{file_id}",
        }

    monkeypatch.setattr(main.google_drive, "update_file_content", update_file_content)

    def replace_all_text(session, document_id, replacements):
        fake.replaced.append(replacements)
        if fake.replace_counts is not None:
            return fake.replace_counts
        return {placeholder: 1 for placeholder in replacements}

    monkeypatch.setattr(main.google_docs, "replace_all_text", replace_all_text)
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
