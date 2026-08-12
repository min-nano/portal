"""必要壁量ツールの API（/api/tools/wall-quantity-calculator/**）の検証。

このツールは Drive も共有設定も使わない（雛形はリポジトリに同梱している）
ので、確かめるのは認証・入力の検証・応答の形と、返るのが確かに
**Excel 形式のまま** であることだけ。
"""

import io
import zipfile
from urllib.parse import unquote

from tests.test_wall_quantity import one_story_body

TOOL_API = "/api/tools/wall-quantity-calculator"
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


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
