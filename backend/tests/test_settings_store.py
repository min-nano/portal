"""共有設定ストア（Firestore）の単体テスト。

Firestore クライアントをフェイクに差し替え、ドキュメントの読み書きと
エラーの包み直し（利用者向けメッセージ化）を検証する。
"""

import pytest

from app import settings_store
from app.settings_store import SettingsError


class FakeSnapshot:
    def __init__(self, data):
        self._data = data

    @property
    def exists(self):
        return self._data is not None

    def to_dict(self):
        return self._data


class FakeDocument:
    def __init__(self, store, doc_id):
        self._store = store
        self._doc_id = doc_id

    def get(self):
        return FakeSnapshot(self._store.get(self._doc_id))

    def set(self, values):
        self._store[self._doc_id] = values


class FakeClient:
    def __init__(self):
        self.collections = {}

    def collection(self, name):
        store = self.collections.setdefault(name, {})
        client = self

        class _Collection:
            def document(self, doc_id):
                return FakeDocument(store, doc_id)

        return _Collection()


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
    # コレクション tool_settings のツール名ドキュメントに保存される。
    assert fake_client.collections["tool_settings"]["excel-report-formatter"] == values


def test_tools_are_namespaced_per_document(fake_client):
    settings_store.set_tool_settings("tool-a", {"x": 1})
    settings_store.set_tool_settings("tool-b", {"y": 2})

    assert settings_store.get_tool_settings("tool-a") == {"x": 1}
    assert settings_store.get_tool_settings("tool-b") == {"y": 2}


def test_firestore_failure_is_wrapped_with_guidance(monkeypatch):
    class BrokenClient:
        def collection(self, name):
            raise RuntimeError("permission denied")

    monkeypatch.setattr(settings_store, "_client", lambda: BrokenClient())

    with pytest.raises(SettingsError) as e:
        settings_store.get_tool_settings("excel-report-formatter")
    assert e.value.status == 500
    assert "Firestore" in str(e.value)
    assert "datastore.user" in str(e.value)
