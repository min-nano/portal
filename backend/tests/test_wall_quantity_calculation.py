"""必要壁量の計算（Rust → wasm）と、配布物そのものとの突き合わせ。

必要壁量・柱の小径の計算は core/src/wall_quantity.rs にあり、配布物
（日本住宅・木材技術センターの表計算ツール）の数式を写したもの。写し間違い
は「配布物と違う値を画面に出す」ことになるので、このテストは **同梱している
配布物そのもの** を相手に確かめる:

  1. 配布物の「表計算ツール入力例」シートには、入力と、Excel が計算した
     結果の両方が入っている。その入力を wasm へ渡し、同じ結果になること。
  2. 配布物のシートに書かれている数式が、マッピングへ控えたものと同じこと
     （改訂で計算が変われば、写し直しが要ると分かる）。
  3. 柱の圧縮基準強度の表が、配布物の隠しシートと同じこと。
  4. 計算が読む入力欄の key が、すべてマッピングにあること。

1 が「計算が合っている」ことの根拠で、2〜4 が「配布物が変わったら気付ける」
ための番人。落ちたときの直し方は README「表計算ツールが改訂されたときの手順」。
"""

import pytest

from app import portal_sdk
from app import wall_quantity as wq
from app.xlsx_fill import XlsxTemplate


@pytest.fixture(scope="module")
def template():
    return XlsxTemplate(wq.template_bytes())


@pytest.fixture(scope="module")
def mapping():
    return wq.load_mapping()


def _building(mapping, key):
    return next(b for b in mapping["buildings"] if b["key"] == key)


def _fields(building):
    """建物の全入力欄を (節, 行, 入力欄) で返す。"""
    for section in building["sections"]:
        for block in section.get("blocks", []):
            if block["kind"] == "fields":
                for field in block["fields"]:
                    yield section, None, field
            else:
                for row in block["rows"]:
                    for field in row["fields"]:
                        yield section, row, field


# --- 1. 配布物の入力例と同じ結果になること -----------------------------------


def _example_request(template, mapping):
    """配布物の「表計算ツール入力例」シートを、そのまま計算の入力にする。

    入力例のシートは 2 階建てのシートと同じ作りなので、マッピングが持って
    いるセル（書き込み先）から、そのまま入力値を読み出せる。
    """
    sheet = mapping["template"]["example_sheet"]
    building = _building(mapping, "two_story")

    values = {}
    for _section, _row, field in _fields(building):
        text = template.cell_text(sheet, field["cell"])
        if text not in (None, ""):
            values[field["key"]] = text

    usage = next(
        key
        for key, cell in building["usage_cells"].items()
        if _checked(template.cell_text(sheet, cell))
    )
    toggles = {
        section["toggle"]["key"]: _checked(
            template.cell_text(sheet, section["toggle"]["cell"])
        )
        for section in building["sections"]
        if section.get("toggle")
    }
    return {
        "building": "two_story",
        "usage": usage,
        "values": values,
        "toggles": toggles,
    }


def _checked(text):
    """チェックボックスのリンクセル（TRUE / 1 が入り）。"""
    return str(text).strip().upper() in {"1", "TRUE"}


def test_the_example_of_the_workbook_is_read_as_expected(template, mapping):
    """入力例シートから読めた入力が、想定どおりであること。

    1 つ下のテストが本命だが、そちらが落ちたときに「読み方が変わったのか、
    計算が違うのか」をすぐ切り分けられるよう、読み取り結果も押さえておく。
    """
    request = _example_request(template, mapping)

    assert request["usage"] == "performance"
    assert request["toggles"] == {
        "use_column_1": True,
        "use_column_2": True,
        "use_column_3": True,
    }
    values = request["values"]
    assert values["height_2f"] == "3"
    assert values["height_1f"] == "3"
    assert values["floor_area_1f"] == "60"
    assert values["heavy_snow"] == "あり(多雪区域)"
    assert values["roof_spec"] == "スレート屋根"
    assert values["c2_2f_①_grade"] == "二級"
    assert values["free_1_long"] == "210"


def test_the_calculation_reproduces_every_output_of_the_example(template, mapping):
    """配布物が計算した値と、この実装が計算した値が、1 つ残らず同じこと。

    入力例シートには Excel が計算した結果が残っている（配布物を開かなくても
    読める）。出力欄の場所は guard.outputs に控えてあるので、そこに入って
    いる値と、計算結果の升目を key ごとに突き合わせる。
    """
    sheet = mapping["template"]["example_sheet"]
    request = _example_request(template, mapping)
    result = wq.compute(request)
    cells = wq.result_cells(result)
    values = _result_values(result)

    compared = 0
    for key, ref in mapping["guard"]["outputs"]["two_story"].items():
        expected = template.cell_text(sheet, ref)
        expected = "" if expected is None else expected
        _assert_same(key, ref, expected, cells[key], values[key])
        compared += 1
    assert compared == len(mapping["guard"]["outputs"]["two_story"])


def _result_values(result):
    """計算結果を key → 数値（数値でなければ None）にする。"""
    return {
        cell["key"]: cell.get("value")
        for section in result["sections"]
        for table in section["tables"]
        for row in table["rows"]
        for cell in row["cells"]
    }


def _assert_same(key, ref, expected, text, value):
    """配布物のセルの値と、計算結果の升目が同じことを確かめる。

    Excel は 20.4 を 20.399999999999999 のように 17 桁で書き出すので、
    数値のセルは数値として比べる（表示は 6 桁より短く丸めていない）。
    """
    try:
        expected_number = float(expected)
    except ValueError:
        assert text == expected, f"{key}（{ref}）が配布物と違います"
        return
    assert value is not None, f"{key}（{ref}）は数値のはずです: {text!r}"
    assert value == pytest.approx(expected_number, rel=1e-9, abs=1e-9), (
        f"{key}（{ref}）が配布物と違います"
    )


# --- 2〜4. 配布物が変わったら気付けること ------------------------------------


def test_the_formulas_of_the_workbook_have_not_changed(template, mapping):
    """配布物の数式が、マッピングへ控えたものと同じこと。

    ここが落ちたら配布物の計算が変わったということ。差分の数式を読み直し、
    core/src/wall_quantity.rs を直してから guard.formulas を更新する。
    """
    for key, expected in mapping["guard"]["formulas"].items():
        sheet = _building(mapping, key)["sheet"]
        actual = template.formula_cells(sheet)
        assert actual == expected, f"{sheet} の数式が変わっています"


def test_the_compressive_strength_table_matches_the_workbook(template, mapping):
    """柱の圧縮基準強度の表が、配布物の隠しシートと同じこと。

    配布物は「JAS 規格 + 樹種等 + 等級等」を連結した A 列で VLOOKUP して
    いるので、こちらもその連結キーで突き合わせる。
    """
    sheet = "柱の圧縮基準強度"
    expected = {}
    for row in range(4, 188):
        key = template.cell_text(sheet, f"A{row}")
        strength = template.cell_text(sheet, f"F{row}")
        if not key or key == "VLOOKUP引き当て用":
            continue
        try:
            expected[key] = float(strength)
        except (TypeError, ValueError):
            continue

    table = wq.calculation_inputs("one_story")["columnStrengths"]
    actual = {
        entry["jas"] + entry["species"] + entry["grade"]: entry["strength"]
        for entry in table
    }
    assert len(actual) == len(table), "連結キーが重複しています"
    assert actual == expected


def test_every_input_the_calculation_reads_exists_in_the_mapping(mapping):
    """計算が読む入力欄が、すべてマッピング（書き込み先）にあること。

    マッピングは「どのセルへ書くか」、計算は「その値をどう使うか」を持って
    いる。key がずれると、画面には値が入っているのに計算では空欄、という
    静かな食い違いになるので、ここで縛っておく。
    """
    for building in mapping["buildings"]:
        known = {field["key"] for _s, _r, field in _fields(building)}
        toggles = {
            section["toggle"]["key"]
            for section in building["sections"]
            if section.get("toggle")
        }
        core = wq.calculation_inputs(building["key"])

        missing = sorted(set(core["inputKeys"]) - known)
        assert not missing, f"{building['key']}: マッピングに無い入力欄 {missing}"
        assert set(core["toggleKeys"]) == toggles


def test_the_screen_and_the_server_calculate_the_same_thing(template, mapping):
    """画面が送ってくる形と、サーバが整えた形で、同じ結果になること。

    画面は入力欄の文字列をそのまま（{building, usage, toggles, values}）送り、
    サーバはそれを normalize_data で整えてから計算する。整える途中で形が
    変わると、突き合わせが毎回ずれる（利用者にはいつも警告が出る）ので、
    ここで縛っておく。
    """
    request = _example_request(template, mapping)

    as_sent = wq.compute(request)
    as_normalized = wq.compute(wq.normalize_data(request))

    assert wq.result_cells(as_normalized) == wq.result_cells(as_sent)
    # 算定方法のチェックが効いていること（形の取り違えは、ここが空欄になる）。
    assert wq.result_cells(as_normalized)["column1.2f.size"] == "84"


# --- 保存時の突き合わせ -------------------------------------------------------


def test_verify_accepts_the_result_the_screen_calculated(template, mapping):
    """画面と同じ値なら、突き合わせは ok。"""
    result = wq.compute(_example_request(template, mapping))
    claim = {
        "coreVersion": wq.nail_core.version(),
        "cells": wq.result_cells(result),
    }

    verification = wq.verify(result, claim)

    assert verification == {
        "checked": True,
        "ok": True,
        "coreVersion": {
            "client": wq.nail_core.version(),
            "server": wq.nail_core.version(),
        },
        "differences": [],
        "omittedDifferences": 0,
    }


def test_verify_reports_a_value_the_screen_showed_differently(template, mapping):
    """画面が違う値を出していたら、その升目を挙げて警告する。"""
    result = wq.compute(_example_request(template, mapping))
    cells = dict(wq.result_cells(result))
    cells["lw.1f.grade1"] = "999"

    verification = wq.verify(
        result, {"coreVersion": wq.nail_core.version(), "cells": cells}
    )

    assert verification["ok"] is False
    assert verification["differences"] == [
        {"key": "lw.1f.grade1", "client": "999", "server": "44"}
    ]


def test_verify_reports_a_screen_running_an_older_calculation(template, mapping):
    """計算実装の版が違えば、値が合っていても警告する
    （画面を開いたまま新しい版がデプロイされた場合）。"""
    result = wq.compute(_example_request(template, mapping))

    verification = wq.verify(
        result, {"coreVersion": "0.0.0", "cells": wq.result_cells(result)}
    )

    assert verification["ok"] is False
    assert verification["differences"] == []
    assert verification["coreVersion"]["client"] == "0.0.0"


def test_verify_is_skipped_when_the_screen_sends_nothing():
    """突き合わせの材料が無ければ、確かめずに通す（生成は止めない）。"""
    assert wq.verify({}, None) == {"checked": False, "ok": True, "differences": []}


def test_verify_lists_at_most_a_handful_of_differences(template, mapping):
    """全部ずれていても、応答が膨れないよう件数を抑える。"""
    result = wq.compute(_example_request(template, mapping))

    verification = wq.verify(result, {"coreVersion": "0.0.0", "cells": {}})

    assert len(verification["differences"]) == portal_sdk.MAX_REPORTED_DIFFERENCES
    assert verification["omittedDifferences"] > 0
