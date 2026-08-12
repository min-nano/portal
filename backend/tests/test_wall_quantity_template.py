"""同梱している表計算ツールと、マッピングの突き合わせ（雛形の番人）。

配布物は改訂される。改訂そのものは
.github/workflows/howtec-worksheet-check.yml が拾って PR にしてくれるが、
**入力欄の位置や選択肢がずれていないか** は機械的に確かめないと分からない。

このテストは wall_quantity_mapping.json が指しているセルに、記録したとおりの
ラベル・選択肢が入っていることを実物に対して確かめる。ここが落ちたら、
配布物を開いて読み直し、マッピングを直すのが正しい対応
（README「表計算ツールが改訂されたときの手順」を参照）。
"""

import hashlib
import json
import os

import pytest

from app import wall_quantity
from app.xlsx_fill import XlsxTemplate


@pytest.fixture(scope="module")
def template():
    return XlsxTemplate(wall_quantity.template_bytes())


@pytest.fixture(scope="module")
def mapping():
    return wall_quantity.load_mapping()


def _sheet_of(mapping, key):
    return next(b["sheet"] for b in mapping["buildings"] if b["key"] == key)


def test_bundled_file_matches_the_recorded_fingerprint():
    """同梱ファイルと出所（source.json）が食い違っていないこと。

    差し替えのときに sha256 の書き換えを忘れると、更新の定期確認が
    毎回「違う」と言い続けることになる。
    """
    source = wall_quantity.load_source()
    data = wall_quantity.template_bytes()
    assert hashlib.sha256(data).hexdigest() == source["sha256"]
    assert len(data) == source["size"]


def test_version_recorded_matches_the_workbook():
    # 配布物に印字された版（ver1.2.1）と、出所に控えた版（1.2.1）を揃える。
    assert wall_quantity.template_version().replace("ver", "").strip() == (
        wall_quantity.load_source()["version"]
    )


def test_guard_cells_still_hold_the_recorded_labels(template, mapping):
    """マッピングを書いたときに読んだラベルが、今も同じ場所にあること。"""
    sheets = {
        "one_story": _sheet_of(mapping, "one_story"),
        "two_story": _sheet_of(mapping, "two_story"),
        "strength": "柱の圧縮基準強度",
    }
    for key, expected in mapping["guard"]["labels"].items():
        sheet = sheets[key]
        actual = {ref: template.cell_text(sheet, ref) for ref in expected}
        assert actual == expected, f"{sheet} のラベルが変わっています"


def test_every_mapped_cell_exists_in_the_workbook(template, mapping):
    """書き込み先のセルが実物にあること（行・セルの差し込みに頼らない）。"""
    for building in mapping["buildings"]:
        sheet = building["sheet"]
        xml = template._text(template._sheet_path(sheet))
        for ref in _all_cells(building):
            assert f'r="{ref}"' in xml, f"{sheet} に {ref} がありません"


def _all_cells(building):
    refs = list(building["usage_cells"].values())
    for section in building["sections"]:
        if section.get("toggle"):
            refs.append(section["toggle"]["cell"])
        for block in section.get("blocks", []):
            if block["kind"] == "fields":
                refs += [f["cell"] for f in block["fields"]]
            else:
                for row in block["rows"]:
                    refs += [f["cell"] for f in row["fields"]]
    return refs


def test_cell_references_are_not_reused_within_a_building(mapping):
    for building in mapping["buildings"]:
        refs = _all_cells(building)
        assert len(refs) == len(set(refs)), f"{building['key']} でセルが重複しています"


def test_field_keys_are_unique_within_a_building(mapping):
    for building in mapping["buildings"]:
        keys = []
        for section in building["sections"]:
            if section.get("toggle"):
                keys.append(section["toggle"]["key"])
            for block in section.get("blocks", []):
                if block["kind"] == "fields":
                    keys += [f["key"] for f in block["fields"]]
                else:
                    for row in block["rows"]:
                        keys += [f["key"] for f in row["fields"]]
        assert len(keys) == len(set(keys)), f"{building['key']} で key が重複しています"


def test_checkbox_cells_are_wired_to_form_controls(template, mapping):
    """用途・算定方法のチェックボックスが、実物のフォームコントロールとつながっていること。"""
    for building in mapping["buildings"]:
        sheet = building["sheet"]
        links = set()
        for path in template.related_parts(sheet, "ctrlProp"):
            links.update(
                x for x in template._text(path).split('fmlaLink="')[1:]
            )
        linked = {x.split('"')[0] for x in links}

        expected = set(building["usage_cells"].values())
        for section in building["sections"]:
            if section.get("toggle"):
                expected.add(section["toggle"]["cell"])
        for ref in expected:
            column, row = ref[0], ref[1:]
            assert f"${column}${row}" in linked, f"{sheet} の {ref} にチェックボックスがない"


def test_option_lists_match_the_workbook(template, mapping):
    """選択肢が、配布物のプルダウンが引いている一覧と一致すること。

    地震地域係数と多雪区域だけは、配布物側が「用途を選ばないと『ー』しか
    出ない」数式になっていて読み出せないので、ここでは確かめない
    （マッピングの _readme に理由を書いてある）。
    """
    one = _sheet_of(mapping, "one_story")
    strength = "柱の圧縮基準強度"
    ranges = {
        "qualification": (one, "AG", 3, 5),
        "base_shear": (one, "AE", 4, 5),
        "solar": (one, "Y", 3, 5),
        "roof": (one, "Y", 6, 8),
        "ceiling_insulation": (one, "Y", 11, 12),
        "exterior_wall": (one, "Y", 19, 23),
        "wall_insulation": (one, "Y", 24, 25),
    }
    for key, (sheet, column, first, last) in ranges.items():
        actual = [template.cell_text(sheet, f"{column}{r}") for r in range(first, last + 1)]
        assert mapping["options"][key] == actual, f"{key} の選択肢が変わっています"

    jas = [template.cell_text(strength, f"{c}1") for c in "IJKLM"]
    assert mapping["options"]["jas"] == jas

    species_ranges = [("I", 2, 11), ("J", 2, 11), ("K", 2, 26), ("L", 2, 2), ("M", 2, 2)]
    grade_ranges = [("I", 29, 34), ("J", 29, 31), ("K", 29, 29), ("L", 29, 61), ("M", 29, 61)]
    for name, ranges_ in (("species", species_ranges), ("grade", grade_ranges)):
        for standard, (column, first, last) in zip(jas, ranges_):
            actual = [
                template.cell_text(strength, f"{column}{r}") for r in range(first, last + 1)
            ]
            assert mapping[name][standard] == actual, f"{standard} の {name} が変わっています"


def test_seismic_zone_and_heavy_snow_options_are_documented(mapping):
    """読み出せない 2 つの選択肢は、少なくとも「ー」を含み、雛形の初期値と揃うこと。"""
    assert mapping["options"]["seismic_zone"][0] == "ー"
    assert mapping["options"]["heavy_snow"][0] == "ー"


def test_the_template_directory_holds_only_the_worksheet_and_its_source():
    directory = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "app",
        "templates",
        "wall-quantity",
    )
    assert sorted(os.listdir(directory)) == ["source.json", "worksheet.xlsx"]


def test_source_json_points_at_the_distribution_page():
    source = wall_quantity.load_source()
    assert source["page_url"].startswith("https://www.howtec.or.jp/")
    assert source["publisher"]
    assert json.dumps(source, ensure_ascii=False)  # 壊れた JSON でないこと
