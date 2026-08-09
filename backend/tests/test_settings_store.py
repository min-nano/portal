"""共有設定ストア（Firestore）の単体テスト。

Firestore クライアントをフェイクに差し替え、ドキュメントの読み書き、
チャンネル（本番 / 開発 / PR プレビュー）の切り替え、エラーの包み直し
（利用者向けメッセージ化）を検証する。
"""

import pytest

from app import settings_store
from app.settings_store import SettingsError

DEVELOPMENT_ROOT = "static-channels/development/tool_settings"


class FakeSnapshot:
    def __init__(self, data):
        self._data = data

    @property
    def exists(self):
        return self._data is not None

    def to_dict(self):
        return self._data


class FakeDocument:
    def __init__(self, store, path):
        self._store = store
        self._path = path

    def get(self):
        return FakeSnapshot(self._store.get(self._path))

    def set(self, values):
        self._store[self._path] = values


class FakeClient:
    """パス文字列をキーにドキュメントを保持するフェイク。

    本物の Client と同じく、document() にはコレクション/ドキュメントが交互に
    並ぶフルパスを渡す。
    """

    def __init__(self):
        self.documents = {}

    def document(self, path):
        return FakeDocument(self.documents, path)


@pytest.fixture
def fake_client(monkeypatch):
    client = FakeClient()
    monkeypatch.setattr(settings_store, "_client", lambda: client)
    return client


def test_missing_document_returns_empty_dict(fake_client):
    assert settings_store.get_tool_settings("excel-report-formatter") == {}


def test_set_then_get_roundtrip(fake_client):
    values = {"template_folder_id": "folder-1", "template_file_name": "雛形.xlsx"}
    settings_store.set_tool_settings("excel-report-formatter", values)

    assert settings_store.get_tool_settings("excel-report-formatter") == values
    assert fake_client.documents[f"{DEVELOPMENT_ROOT}/excel-report-formatter"] == values


def test_default_channel_is_development_not_production(fake_client):
    """環境変数の設定漏れが本番データに届かないこと（この構成の要点）。"""
    settings_store.set_tool_settings("excel-report-formatter", {"x": 1})

    assert list(fake_client.documents) == [
        f"{DEVELOPMENT_ROOT}/excel-report-formatter"
    ]
    assert not any("production" in path for path in fake_client.documents)


def test_settings_root_selects_preview_channel(fake_client, monkeypatch):
    monkeypatch.setenv("SETTINGS_ROOT", "preview-channels/pr-123/tool_settings")
    settings_store.set_tool_settings("excel-report-formatter", {"x": 1})

    assert fake_client.documents == {
        "preview-channels/pr-123/tool_settings/excel-report-formatter": {"x": 1}
    }


def test_channels_do_not_see_each_others_data(fake_client, monkeypatch):
    monkeypatch.setenv("SETTINGS_ROOT", "static-channels/production/tool_settings")
    settings_store.set_tool_settings("excel-report-formatter", {"channel": "prod"})

    monkeypatch.setenv("SETTINGS_ROOT", "preview-channels/pr-1/tool_settings")
    assert settings_store.get_tool_settings("excel-report-formatter") == {}

    settings_store.set_tool_settings("excel-report-formatter", {"channel": "pr-1"})

    monkeypatch.setenv("SETTINGS_ROOT", "static-channels/production/tool_settings")
    assert settings_store.get_tool_settings("excel-report-formatter") == {
        "channel": "prod"
    }


def test_surrounding_slashes_in_settings_root_are_ignored(fake_client, monkeypatch):
    monkeypatch.setenv("SETTINGS_ROOT", "/static-channels/production/tool_settings/")
    settings_store.set_tool_settings("excel-report-formatter", {"x": 1})

    assert fake_client.documents == {
        "static-channels/production/tool_settings/excel-report-formatter": {"x": 1}
    }


@pytest.mark.parametrize(
    "root",
    [
        "static-channels/production",  # 偶数セグメント = ドキュメントパス
        "",
    ],
)
def test_settings_root_that_is_not_a_collection_path_is_rejected(
    fake_client, monkeypatch, root
):
    monkeypatch.setenv("SETTINGS_ROOT", root)

    with pytest.raises(SettingsError) as e:
        settings_store.get_tool_settings("excel-report-formatter")
    assert "SETTINGS_ROOT" in str(e.value)
    # 権限やネットワークの問題と取り違えないよう、Firestore の一般的な
    # エラーメッセージには包み直さない。
    assert "datastore.user" not in str(e.value)


def test_tools_are_namespaced_per_document(fake_client):
    settings_store.set_tool_settings("tool-a", {"x": 1})
    settings_store.set_tool_settings("tool-b", {"y": 2})

    assert settings_store.get_tool_settings("tool-a") == {"x": 1}
    assert settings_store.get_tool_settings("tool-b") == {"y": 2}


def test_firestore_failure_is_wrapped_with_guidance(monkeypatch):
    class BrokenClient:
        def document(self, path):
            raise RuntimeError("permission denied")

    monkeypatch.setattr(settings_store, "_client", lambda: BrokenClient())

    with pytest.raises(SettingsError) as e:
        settings_store.get_tool_settings("excel-report-formatter")
    assert e.value.status == 500
    assert "Firestore" in str(e.value)
    assert "datastore.user" in str(e.value)
