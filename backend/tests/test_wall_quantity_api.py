"""必要壁量ツールの API（/api/tools/wall-quantity-calculator/**）の検証。

このツールは Drive も共有設定も使わない（雛形はリポジトリに同梱している）
ので、確かめるのは認証・入力の検証・応答の形と、返るのが確かに
**Excel 形式のまま** であることだけ。
"""

import io
import json
import zipfile
from urllib.parse import unquote

from app import nail_core, wall_quantity as wq
from tests.test_wall_quantity import one_story_body

TOOL_API = "/api/tools/wall-quantity-calculator"
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
VERIFICATION_HEADER = "x-wall-quantity-verification"


def test_config_requires_authentication(anon_client):
    assert anon_client.get(f"{TOOL_API}/config").status_code == 401


def test_creating_a_worksheet_requires_authentication(anon_client):
    assert anon_client.post(f"{TOOL_API}/worksheets", json={}).status_code == 401


def test_config_returns_the_form_definition(client):
    resp = client.get(f"{TOOL_API}/config")
    assert resp.status_code == 200
    body = resp.json()
    assert [b["key"] for b in body["buildings"]] == ["one_story", "two_story"]
    assert body["worksheet"]["version"].startswith("ver")
    assert body["usage"]["options"][0]["value"] == "performance"


def test_a_worksheet_comes_back_as_an_excel_file(client):
    resp = client.post(f"{TOOL_API}/worksheets", json=one_story_body())
    assert resp.status_code == 200
    assert resp.headers["content-type"] == XLSX_MIME
    # ファイル名は日本語なので RFC 5987 の形で入る。
    assert "filename*=UTF-8''" in resp.headers["content-disposition"]

    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        # 配布物のチェックボックスも図も残っていること（Google スプレッドシート等へ
        # 変換していない、素の xlsx であることの裏付け）。
        names = zf.namelist()
    assert any(n.startswith("xl/ctrlProps/") for n in names)
    assert any(n.endswith(".emf") for n in names)


def test_missing_input_comes_back_as_a_readable_message(client):
    body = one_story_body()
    body["values"]["floor_area_1f"] = ""
    resp = client.post(f"{TOOL_API}/worksheets", json=body)
    assert resp.status_code == 400
    assert "1階床面積" in resp.json()["error"]


def test_an_empty_body_is_rejected(client):
    resp = client.post(f"{TOOL_API}/worksheets", json={})
    assert resp.status_code == 400
    assert resp.json()["error"]


def test_a_body_that_is_not_json_is_rejected(client):
    resp = client.post(
        f"{TOOL_API}/worksheets",
        content=b"not json",
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 400


def test_a_two_story_worksheet_can_be_created(client):
    body = one_story_body()
    body["building"] = "two_story"
    body["values"].update({"height_2f": "3", "height_1f": "3", "floor_area_2f": "60"})
    resp = client.post(f"{TOOL_API}/worksheets", json=body)
    assert resp.status_code == 200
    assert "（2階建て）" in _file_name(resp)


def _file_name(resp) -> str:
    _, _, encoded = resp.headers["content-disposition"].partition("UTF-8''")
    return unquote(encoded)


# --- 計算実装（wasm）と、保存時の突き合わせ ----------------------------------


def test_the_core_wasm_requires_authentication(anon_client):
    assert anon_client.get(f"{TOOL_API}/core.wasm").status_code == 401


def test_the_core_wasm_is_the_same_bytes_the_server_calculates_with(client):
    """画面が受け取る wasm と、サーバが自分の計算に使う wasm が同じであること。"""
    resp = client.get(f"{TOOL_API}/core.wasm")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/wasm"
    assert resp.content == nail_core.wasm_bytes()
    # 中身が変わらないうちはブラウザのキャッシュから読ませる。
    assert resp.headers["etag"] == f'"{nail_core.sha256()}"'


def test_the_config_points_at_the_core_wasm(client):
    core = client.get(f"{TOOL_API}/config").json()["core"]
    assert core["url"].startswith(f"{TOOL_API}/core.wasm?v=")
    assert core["sha256"] == nail_core.sha256()


def test_a_worksheet_carries_the_verification_of_the_screen(client):
    """画面が出していた値と同じなら、突き合わせは ok で返る。

    画面は送るのと同じ本文をそのまま計算に掛けているので、ここでもそうする
    （サーバは受け取ってから整えるが、結果は同じでなければならない）。
    """
    body = one_story_body()
    body["toggles"] = {"use_column_1": True}
    body["verify"] = {
        "coreVersion": nail_core.version(),
        "cells": wq.result_cells(wq.compute(body)),
    }

    resp = client.post(f"{TOOL_API}/worksheets", json=body)

    assert resp.status_code == 200
    verification = json.loads(resp.headers[VERIFICATION_HEADER])
    assert verification["checked"] is True
    assert verification["ok"] is True, verification["differences"]


def test_a_worksheet_is_still_created_when_the_screen_disagreed(client):
    """食い違っても生成は止めない（xlsx に入るのは入力値で、計算するのは
    Excel の数式なので、成果物は壊れない）。画面には警告の材料を返す。"""
    body = one_story_body()
    body["verify"] = {"coreVersion": nail_core.version(), "cells": {"lw.1f.grade1": "1"}}

    resp = client.post(f"{TOOL_API}/worksheets", json=body)

    assert resp.status_code == 200
    assert resp.headers["content-type"] == XLSX_MIME
    verification = json.loads(resp.headers[VERIFICATION_HEADER])
    assert verification["ok"] is False
    assert {"key": "lw.1f.grade1", "client": "1", "server": "17"} in (
        verification["differences"]
    )


def test_the_verification_header_is_ascii_only(client):
    """ヘッダには非 ASCII を置けないので、日本語の文言は必ず退避されること。"""
    body = one_story_body()
    body["values"]["ceiling_insulation"] = "任意入力"
    body["verify"] = {"coreVersion": nail_core.version(), "cells": {}}

    resp = client.post(f"{TOOL_API}/worksheets", json=body)

    raw = resp.headers[VERIFICATION_HEADER]
    assert raw.isascii()
    assert json.loads(raw)["checked"] is True


def test_a_worksheet_without_a_verification_is_accepted(client):
    """画面が突き合わせの材料を送ってこなくても生成できる。"""
    resp = client.post(f"{TOOL_API}/worksheets", json=one_story_body())

    assert resp.status_code == 200
    assert json.loads(resp.headers[VERIFICATION_HEADER]) == {
        "checked": False,
        "ok": True,
        "differences": [],
    }
