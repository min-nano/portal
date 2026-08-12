"""唯一の計算実装（wasm）を、サーバから呼べていることのテスト。

式ごとの検証（グレー本 3.2【解説】の計算例、各関数のユニットテスト、入力
検証）は Rust 側の `cargo test`（core/src/*.rs）に置いてある。同じ .wasm を
画面も動かすので、二重にテストを書くと「どちらが正か」が分かりにくくなる。

ここで確かめるのは、サーバがその実装を**正しく呼べていること**:
  - コミットしてある .wasm を読み込めて、版とハッシュが取れる
  - JSON の受け渡し（線形メモリの確保・解放）が往復する
  - グレー本の計算例が、GAS 版・Python 版と同じ数字で返る
  - 失敗が例外として上がる
"""

import pytest

from app import nail_core

# グレー本 3.2【解説】の計算例（図 3.2.2）。
EXAMPLE = {
    "patternId": "p1",
    "width": 610,
    "height": 910,
    "mode": "grid",
    "gridX": "0, 445, 890",
    "gridY": "0, 145, 295, 445, 590",
}


def compute(**overrides) -> dict:
    pattern = {**EXAMPLE, **overrides}
    response = nail_core.call({"op": "computeAll", "data": {"patterns": [pattern]}})
    return response["patterns"][0]


def test_the_committed_wasm_loads():
    assert nail_core.WASM_PATH.exists()
    assert nail_core.wasm_bytes().startswith(b"\x00asm")
    assert len(nail_core.sha256()) == 64
    assert nail_core.version()


def test_config_reports_the_limits_the_screen_also_uses():
    config = nail_core.config()

    assert config["maxPatterns"] == 50
    assert config["maxNails"] == 2000
    assert config["significantDigits"] == 6


def test_the_reference_example_matches_the_book():
    """移植の前後で数字が変わっていないこと（GAS 版・Python 版と同じ）。"""
    report = compute()

    assert report["ok"] is True
    assert {row["key"]: row["value"] for row in report["summary"]} == {
        "Ixy": "0.888868",
        "Zxy": "0.00358851",
        "Cxy": "1.26155",
    }
    assert len(report["nails"]) == 15
    assert report["result"]["x0"] == 445
    assert report["result"]["Ix"] == 657150


def test_a_pattern_that_cannot_be_calculated_comes_back_as_a_reason():
    report = compute(gridX="", gridY="")

    assert report["ok"] is False
    assert "釘座標が入力されていません" in report["error"]


def test_a_broken_request_raises():
    with pytest.raises(nail_core.CoreError, match="面材の幅 W"):
        nail_core.call({"op": "normalize", "data": {"patterns": [{"width": "ろく"}]}})

    with pytest.raises(nail_core.CoreError):
        nail_core.call({"op": "そんな操作は無い"})


def test_repeated_calls_do_not_drift():
    """線形メモリの確保・解放を繰り返しても結果が変わらないこと。"""
    first = compute()["summary"]

    for _ in range(50):
        assert compute()["summary"] == first


def test_a_large_input_round_trips():
    """メモリを広げる大きさの入力でも、応答が壊れないこと。"""
    axis = ", ".join(str(index * 10) for index in range(40))

    report = compute(gridX=axis, gridY=axis)

    assert report["ok"] is True
    assert len(report["nails"]) == 1600


def test_the_nail_limit_is_reported_in_the_words_of_the_form():
    axis = ", ".join(str(index) for index in range(100))

    report = compute(gridX=axis, gridY=axis)

    assert report["ok"] is False
    assert "釘の本数が多すぎます" in report["error"]
