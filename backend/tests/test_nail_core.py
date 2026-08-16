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

# 壁の左下に張った 910 × 610 の面材（間柱 @455・釘 @150・へりあき 10 mm）。
# 面材は「壁の中で占める領域」なので、寸法も釘配列もこの領域と壁の間柱ピッチ
# から決まる。表 3.2.1 の「910×610 横置・日型（@455 / 釘 @150）」にあたる。
EXAMPLE = {
    "panelId": "w1-p1",
    "left": 0,
    "bottom": 0,
    "right": 910,
    "top": 610,
    "nailPitch": 150,
    "edgeDistance": 10,
}

EXAMPLE_WALL = {"wallId": "w1", "width": 910, "height": 2900, "studPitch": 455}


def compute(wall=None, **overrides) -> dict:
    """面材 1 枚分の釘配列諸定数（壁の計算の一部として返るもの）。"""
    panel = {**EXAMPLE, **overrides}
    response = nail_core.call(
        {
            "op": "computeAll",
            "data": {"walls": [{**EXAMPLE_WALL, **(wall or {}), "panels": [panel]}]},
        }
    )
    return response["walls"][0]["panelReports"][0]


def test_the_committed_wasm_loads():
    assert nail_core.WASM_PATH.exists()
    assert nail_core.wasm_bytes().startswith(b"\x00asm")
    assert len(nail_core.sha256()) == 64
    assert nail_core.version()


def test_config_reports_the_limits_the_screen_also_uses():
    config = nail_core.config()

    assert config["maxWalls"] == 50
    assert config["maxWallPanels"] == 20
    assert config["maxNails"] == 2000
    assert config["defaultEdgeDistance"] == 10
    assert config["defaultStudPitch"] == 455
    assert config["significantDigits"] == 6


def test_the_reference_example_matches_the_book():
    """壁の軸組と面材の領域から、表 3.2.1 と同じ配列が出ること。

    表 3.2.1 の「910×610 横置・日型（@455 / 釘 @150）」の欄は
    Ixy 1.56 / Zxy 0.0063 / Cxy 1.23。
    """
    report = compute()

    assert report["ok"] is True
    assert abs(report["result"]["Ixy"] - 1.56) <= 0.02
    assert len(report["nails"]) == 23
    assert report["result"]["x0"] == 455
    assert report["result"]["y0"] == 305
    assert (report["width"], report["height"]) == (910, 610)


def test_the_book_table_combinations_can_be_called_by_id():
    """グレー本 表 3.2.1 の組み合わせを、画面と同じ手順で呼び出せること。

    表 3.2.1 の全 106 通りと本の値との突き合わせは core/src/presets.rs の
    `cargo test` にある（計算そのものと同じ場所で検証する）。ここに出るのは
    画面の選択肢になる 33 通り（配列の型は面材の位置で決まるので入らない）。
    """
    presets = nail_core.call({"op": "presets"})["presets"]
    assert len(presets) == 33

    response = nail_core.call({"op": "preset", "data": {"id": "1820x910-s455-n150-hi"}})
    assert response["preset"]["label"] == "1820×910 横置（間柱・根太 @455 / 釘 @150）"
    # 読み込むのは、壁の間柱ピッチと、面材の釘ピッチ・へりあき・大きさ。
    assert response["wall"] == {"studPitch": 455}
    panel = response["panel"]
    assert (panel["width"], panel["height"]) == (1820, 910)
    assert panel["edgeDistance"] == 10

    report = nail_core.call(
        {
            "op": "computeAll",
            "data": {
                "walls": [
                    {
                        "width": 1820,
                        "height": 2900,
                        "studPitch": response["wall"]["studPitch"],
                        "panels": [
                            {
                                "left": 0,
                                "bottom": 0,
                                "right": panel["width"],
                                "top": panel["height"],
                                "nailPitch": panel["nailPitch"],
                                "edgeDistance": panel["edgeDistance"],
                            }
                        ],
                    }
                ]
            },
        }
    )["walls"][0]["panelReports"][0]
    assert report["ok"] is True
    assert len(report["nails"]) == response["preset"]["nailCount"]


def test_a_panel_that_cannot_be_calculated_comes_back_as_a_reason():
    report = compute(right=0, top=0)

    assert report["ok"] is False
    assert "壁の中で面材が占める領域" in report["error"]


def test_a_broken_request_raises():
    with pytest.raises(nail_core.CoreError, match="面材の右端 X"):
        nail_core.call(
            {"op": "normalize", "data": {"walls": [{"panels": [{"right": "ろく"}]}]}}
        )

    with pytest.raises(nail_core.CoreError):
        nail_core.call({"op": "そんな操作は無い"})


def test_repeated_calls_do_not_drift():
    """線形メモリの確保・解放を繰り返しても結果が変わらないこと。"""
    first = compute()["summary"]

    for _ in range(50):
        assert compute()["summary"] == first


def test_a_large_input_round_trips():
    """メモリを広げる大きさの入力でも、応答が壊れないこと。"""
    report = compute(
        wall={"width": 3640, "height": 2730},
        right=3640,
        top=2730,
        nailPitch=75,
    )

    assert report["ok"] is True
    assert len(report["nails"]) > 400


def test_the_nail_limit_is_reported_in_the_words_of_the_form():
    report = compute(nailPitch=0.5)

    assert report["ok"] is False
    assert "釘の本数が多すぎます" in report["error"]
