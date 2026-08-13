"""必要壁量ツール（app/wall_quantity.py）の検証。

このツールは計算をしない。確かめるのは「フォーム入力が、配布物の正しい
入力欄へ、配布物が受け取れる形で入るか」と「入れてはいけない欄が空のまま
残るか」の 2 つ。
"""

import io
import os
import zipfile

import pytest

from app import wall_quantity as wq
from app.wall_quantity import WallQuantityError
from app.xlsx_fill import XlsxTemplate

ONE_STORY = "表計算ツール（平屋建て）"
TWO_STORY = "表計算ツール（2階建て）"

_TEMPLATE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "app",
    "templates",
    "wall-quantity",
    "worksheet.xlsx",
)


def options(name):
    return wq.load_mapping()["options"][name]


def one_story_body(**overrides):
    """平屋建ての、そのまま出力できる最小限の入力。"""
    values = {
        "property_name": "見本邸",
        "created_at": "2026-08-12",
        "height_1f": "3",
        "ridge_minus_eaves": "0.5",
        "base_shear": "0.2",
        "floor_area_1f": "60",
        "eaves": "0.5",
        "roof_pitch": "4",
        "roof_spec": options("roof")[1],
        "wall_spec": options("exterior_wall")[2],
        "solar": options("solar")[0],
        "ceiling_insulation": options("ceiling_insulation")[0],
        "wall_insulation": options("wall_insulation")[0],
    }
    values.update(overrides.pop("values", {}))
    body = {
        "building": "one_story",
        "usage": "standard",
        "toggles": {},
        "values": values,
    }
    body.update(overrides)
    return body


def render(body):
    data = wq.normalize_data(body)
    wq.validate(data)
    return XlsxTemplate(wq.build_worksheet(data))


# --- 入力の解釈 --------------------------------------------------------------


def test_numbers_are_parsed_from_full_width_input():
    data = wq.normalize_data(one_story_body(values={"height_1f": "３．２"}))
    assert data["values"]["height_1f"] == 3.2


def test_whole_numbers_stay_integers():
    data = wq.normalize_data(one_story_body(values={"floor_area_1f": "60.0"}))
    assert data["values"]["floor_area_1f"] == 60


def test_non_numeric_input_is_reported_with_the_field_name():
    with pytest.raises(WallQuantityError, match="1階階高"):
        wq.normalize_data(one_story_body(values={"height_1f": "だいたい 3"}))


def test_unknown_building_is_rejected():
    with pytest.raises(WallQuantityError):
        wq.normalize_data(one_story_body(building="three_story"))


def test_usage_must_be_chosen():
    with pytest.raises(WallQuantityError, match="設計の用途"):
        wq.normalize_data(one_story_body(usage=""))


def test_a_non_dict_body_is_rejected():
    with pytest.raises(WallQuantityError):
        wq.normalize_data("入力ではない")


# --- 検証 --------------------------------------------------------------------


def test_missing_required_input_lists_every_missing_field():
    body = one_story_body(values={"floor_area_1f": "", "eaves": ""})
    with pytest.raises(WallQuantityError) as error:
        wq.validate(wq.normalize_data(body))
    assert "1階床面積" in str(error.value)
    assert "軒の出" in str(error.value)


def test_snow_inputs_are_required_only_in_a_heavy_snow_area():
    heavy = options("heavy_snow")[2]
    body = one_story_body(usage="performance", values={"heavy_snow": heavy})
    with pytest.raises(WallQuantityError, match="垂直積雪量"):
        wq.validate(wq.normalize_data(body))

    body["values"].update({"snow_depth": "100", "snow_unit_load": "30"})
    wq.validate(wq.normalize_data(body))  # 例外が出なければよい


def test_solar_mass_is_required_only_for_free_input():
    body = one_story_body(values={"solar": options("solar")[2]})
    with pytest.raises(WallQuantityError, match="設備等の質量"):
        wq.validate(wq.normalize_data(body))


def test_values_outside_the_option_list_are_rejected():
    body = one_story_body(values={"roof_spec": "かやぶき"})
    with pytest.raises(WallQuantityError, match="屋根の仕様"):
        wq.validate(wq.normalize_data(body))


def test_values_for_fields_that_cannot_be_filled_in_are_ignored():
    """入力できない欄に何が入っていても、それを理由に断らない。

    画面は入力できなくなった欄を消すが、古いタブから送られてくることは
    ありうる。どのみち配布物へは書かないので、断る理由がない。
    """
    body = one_story_body(
        usage="standard",  # このとき地震地域係数は入力できない
        values={"seismic_zone": "とんでもない値"},
    )
    wq.validate(wq.normalize_data(body))


def test_a_grade_that_does_not_belong_to_the_standard_is_rejected():
    body = one_story_body(
        toggles={"use_column_2": True},
        values={
            "c2_1f_①_jas": "JAS目視等級区分構造用製材",
            "c2_1f_①_species": "すぎ",
            "c2_1f_①_grade": "E90",  # 機械等級の等級。目視等級では選べない。
        },
    )
    with pytest.raises(WallQuantityError, match="等級等"):
        wq.validate(wq.normalize_data(body))


# --- 書き込み ----------------------------------------------------------------


def test_input_lands_in_the_cells_the_mapping_points_at():
    book = render(one_story_body())
    assert book.cell_text(ONE_STORY, "K4") == "見本邸"
    assert book.cell_text(ONE_STORY, "D4") == "2026/8/12"
    assert book.cell_text(ONE_STORY, "H15") == "3"
    assert book.cell_text(ONE_STORY, "H22") == "60"
    assert book.cell_text(ONE_STORY, "H25") == options("roof")[1]


def test_the_chosen_usage_checkbox_is_the_only_one_ticked():
    book = render(one_story_body(usage="office"))
    assert book.cell_text(ONE_STORY, "W8") == "0"
    assert book.cell_text(ONE_STORY, "W9") == "1"
    assert book.cell_text(ONE_STORY, "W10") == "0"


def test_calculation_methods_follow_their_checkboxes():
    book = render(one_story_body(toggles={"use_column_1": True}))
    assert book.cell_text(ONE_STORY, "W52") == "1"
    assert book.cell_text(ONE_STORY, "W61") == "0"
    assert book.cell_text(ONE_STORY, "W72") == "0"


def test_input_for_an_unused_calculation_method_is_not_written():
    """使わない算定方法へ送られてきた値は、配布物に入れない。"""
    book = render(
        one_story_body(
            toggles={"use_column_2": False},
            values={"c2_1f_①_jas": "無等級材", "c2_1f_①_species": "すぎ"},
        )
    )
    assert book.cell_text(ONE_STORY, "D66") is None
    assert book.cell_text(ONE_STORY, "I66") is None


def test_seismic_zone_is_fixed_to_the_dash_without_the_performance_scheme():
    """住宅性能表示制度を使わないとき、配布物の注意書きどおり「ー」にする。"""
    book = render(one_story_body(usage="standard", values={"seismic_zone": "0.9"}))
    assert book.cell_text(ONE_STORY, "H17") == "ー"
    assert book.cell_text(ONE_STORY, "H19") == "ー"


def test_seismic_zone_is_written_when_the_performance_scheme_is_used():
    book = render(
        one_story_body(usage="performance", values={"seismic_zone": "0.9"})
    )
    assert book.cell_text(ONE_STORY, "H17") == "0.9"


def test_snow_cells_are_cleared_outside_a_heavy_snow_area():
    book = render(
        one_story_body(
            usage="performance",
            values={"heavy_snow": options("heavy_snow")[1], "snow_depth": "100"},
        )
    )
    assert book.cell_text(ONE_STORY, "H20") is None


def test_the_two_story_sheet_is_used_for_two_story_buildings():
    values = {
        "property_name": "2 階建ての家",
        "height_2f": "3",
        "height_1f": "3",
        "ridge_minus_eaves": "0.5",
        "base_shear": "0.2",
        "floor_area_2f": "60",
        "floor_area_1f": "60",
        "eaves": "0.5",
        "roof_pitch": "4",
        "roof_spec": options("roof")[1],
        "wall_spec": options("exterior_wall")[2],
        "solar": options("solar")[0],
        "ceiling_insulation": options("ceiling_insulation")[0],
        "wall_insulation": options("wall_insulation")[0],
    }
    book = render(
        {
            "building": "two_story",
            "usage": "standard",
            "toggles": {},
            "values": values,
        }
    )
    assert book.cell_text(TWO_STORY, "H15") == "3"
    assert book.cell_text(TWO_STORY, "H23") == "60"
    # 平屋建てのシートには何も書かない。
    assert book.cell_text(ONE_STORY, "K4") is None


def test_the_workbook_keeps_every_part_of_the_distribution():
    data = wq.build_worksheet(wq.normalize_data(one_story_body()))
    with zipfile.ZipFile(io.BytesIO(wq.template_bytes())) as original:
        expected = set(original.namelist())
    with zipfile.ZipFile(io.BytesIO(data)) as produced:
        assert set(produced.namelist()) == expected


def test_the_workbook_recalculates_when_opened():
    data = wq.build_worksheet(wq.normalize_data(one_story_body()))
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        assert b'fullCalcOnLoad="1"' in zf.read("xl/workbook.xml")


def test_the_bundled_template_is_never_modified():
    before = wq.template_bytes()
    wq.build_worksheet(wq.normalize_data(one_story_body()))
    assert wq.template_bytes() == before


def test_a_broken_template_is_reported_as_a_server_error(monkeypatch):
    monkeypatch.setattr(wq, "_TEMPLATE_BYTES", None)
    monkeypatch.setattr(wq, "template_bytes", _template_without_a_sheet)
    with pytest.raises(WallQuantityError) as error:
        wq.build_worksheet(wq.normalize_data(one_story_body()))
    assert error.value.status == 500


def _template_without_a_sheet() -> bytes:
    """平屋建てのシートの名前を変えたブック（配布物の改訂で起こりうる形）。"""
    with open(_TEMPLATE_PATH, "rb") as f:
        original = f.read()
    buf = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(original)) as zf, zipfile.ZipFile(buf, "w") as out:
        for name in zf.namelist():
            content = zf.read(name)
            if name == "xl/workbook.xml":
                content = content.replace(
                    '<sheet name="表計算ツール（平屋建て）"'.encode(),
                    '<sheet name="別の名前"'.encode(),
                )
            out.writestr(name, content)
    return buf.getvalue()


# --- ファイル名 --------------------------------------------------------------


def test_file_name_includes_the_building_type_and_property():
    data = wq.normalize_data(one_story_body())
    assert wq.file_name(data) == "必要壁量 表計算ツール（平屋建て）_見本邸.xlsx"


def test_file_name_falls_back_without_a_property_name():
    data = wq.normalize_data(one_story_body(values={"property_name": ""}))
    assert wq.file_name(data) == "必要壁量 表計算ツール（平屋建て）.xlsx"


def test_file_name_drops_characters_that_cannot_be_used():
    data = wq.normalize_data(one_story_body(values={"property_name": 'A/B:C*?"<>|'}))
    assert wq.file_name(data) == "必要壁量 表計算ツール（平屋建て）_ABC.xlsx"


# --- フォーム定義 ------------------------------------------------------------


def test_form_config_carries_everything_the_screen_needs():
    config = wq.form_config("/api/tools/wall-quantity-calculator/core.wasm")
    assert [b["key"] for b in config["buildings"]] == ["one_story", "two_story"]
    # 編集中の計算に使う wasm の在り処（中身のハッシュ付き）。
    assert config["core"]["url"].startswith(
        "/api/tools/wall-quantity-calculator/core.wasm?v="
    )
    assert config["core"]["version"]
    assert config["worksheet"]["version"] == wq.template_version()
    assert config["worksheet"]["pageUrl"].startswith("https://www.howtec.or.jp/")
    assert config["options"]["roof"]
    assert config["species"]["無等級材"]
    # 書き込み先のセルも配る（画面は使わないが、定義が 1 か所であることの確認）。
    header = config["buildings"][0]["sections"][0]["blocks"][0]["fields"][0]
    assert header["cell"] == "D4"
