"""フォーム定義配信 API（GET /config）のテスト。

mapping.json を単一の情報源として、フロントエンドのフォーム定義
（旧 GAS 版の MEASUREMENT_GROUPS / VALIDATION 定数に相当）を導出する。
"""

from tests.util import MAPPING, STARTS

CONFIG_URL = "/api/tools/excel-report-formatter/config"


def test_config_groups_follow_mapping(client, drive):
    resp = client.get(CONFIG_URL)

    assert resp.status_code == 200
    body = resp.json()

    groups = body["measurement_groups"]
    assert [g["group"] for g in groups] == ["床", "壁", "柱"]
    assert [g["select_label"] for g in groups] == ["傾斜方向", "測定した壁", "測定した柱"]

    points = {p["key"]: p for g in groups for p in g["points"]}
    # 計測点と選択肢は mapping.json（＝雛形のプルダウン）と一致する。
    for m in MAPPING["room_block"]["measurements"]:
        assert points[m["key"]]["label"] == m["label"]
        assert points[m["key"]]["options"] == m["select"]["options"]


def test_config_validation_and_limits(client, drive):
    body = client.get(CONFIG_URL).json()

    assert body["validation"] == MAPPING["validation"]
    assert body["max_rooms"] == len(STARTS)
    assert body["report_file_name"] == "傾斜測定報告書.xlsx"


def test_config_requires_auth(anon_client):
    resp = anon_client.get(CONFIG_URL)

    assert resp.status_code == 401
