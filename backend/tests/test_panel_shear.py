"""計算書の入力整形・表示整形・PDF の生成と読み戻しのテスト。

PDF はバックエンドが直接組み立てるため、雛形を用意せずにここで完結する。
「作った PDF から入力を復元できる」ことが保存形式としての要（スプレッド
シートの代わり）なので、往復を通して確かめる。
"""

import io
import json

import pytest
from pdfminer.high_level import extract_text

from app import panel_shear
from app.nail_array import Nail

EXAMPLE = dict(panel_shear.EXAMPLE_PATTERN, patternId="p1")


def make_data(**overrides):
    body = {
        "projectName": "○○邸 新築工事",
        "issuedOn": "2026-08-11",
        "patterns": [dict(EXAMPLE)],
    }
    body.update(overrides)
    return panel_shear.normalize_data(body)


# --- 入力の正規化 ------------------------------------------------------------


def test_normalize_keeps_only_known_keys():
    data = panel_shear.normalize_data(
        {"projectName": " 邸 ", "unknown": 1, "patterns": [{"width": "610", "junk": 2}]}
    )

    assert data["projectName"] == "邸"
    assert "unknown" not in data
    assert data["patterns"][0]["width"] == 610.0
    assert "junk" not in data["patterns"][0]


def test_normalize_gives_an_empty_form_one_pattern():
    """パターンが 1 つも無い入力でも、画面が編集を始められる形にする。"""
    data = panel_shear.normalize_data({})

    assert len(data["patterns"]) == 1
    assert data["patterns"][0]["patternId"] == "p1"
    assert data["patterns"][0]["mode"] == "grid"


def test_normalize_rejects_a_non_numeric_dimension():
    with pytest.raises(panel_shear.PanelShearError, match="面材の幅 W"):
        panel_shear.normalize_data({"patterns": [{"width": "ろく"}]})


def test_normalize_rejects_too_many_patterns():
    patterns = [{"patternId": f"p{i}"} for i in range(panel_shear.MAX_PATTERNS + 1)]
    with pytest.raises(panel_shear.PanelShearError, match="パターンは"):
        panel_shear.normalize_data({"patterns": patterns})


def test_parse_number_list_ignores_separators_and_junk():
    assert panel_shear.parse_number_list("0, 445  890\n1200") == [0, 445, 890, 1200]
    assert panel_shear.parse_number_list("0, あ, 445") == [0, 445]
    assert panel_shear.parse_number_list("") == []


def test_parse_coord_lines_needs_two_numbers_per_line():
    nails = panel_shear.parse_coord_lines("0, 0\n445 295\n\n910\n")
    assert nails == [Nail(0, 0), Nail(445, 295)]


def test_nails_of_grid_is_every_combination():
    nails = panel_shear.nails_of(panel_shear.normalize_pattern(EXAMPLE))
    assert len(nails) == 15


def test_nails_of_rejects_an_absurd_grid():
    """桁を間違えた入力で計算とページ描画が止まらないようにする。"""
    pattern = panel_shear.normalize_pattern(
        {"mode": "grid", "gridX": ",".join(str(i) for i in range(100)),
         "gridY": ",".join(str(i) for i in range(100))}
    )
    with pytest.raises(panel_shear.PanelShearError, match="釘の本数が多すぎます"):
        panel_shear.nails_of(pattern)


# --- 表示用の整形 ------------------------------------------------------------


@pytest.mark.parametrize(
    "value,expected",
    [
        (445, "445.000"),
        (657150, "657,150"),
        (0.0035885, "0.00358850"),
        (1.2615536, "1.26155"),
        (0, "0"),
        (-2227.63, "-2,227.63"),
        # 有効桁で丸めた結果が繰り上がっても、桁数が増えないこと。
        (9.999999, "10.0000"),
        (None, "-"),
    ],
)
def test_significant_keeps_six_significant_digits(value, expected):
    assert panel_shear.significant(value) == expected


def test_format_int_rounds_and_groups():
    assert panel_shear.format_int(555100) == "555,100"
    assert panel_shear.format_int(2227.63) == "2,228"


# --- 計算（画面と PDF が共有する表示用データ） ------------------------------


def test_compute_pattern_matches_the_reference_example():
    report = panel_shear.compute_pattern(panel_shear.normalize_pattern(EXAMPLE))

    values = {row["key"]: row["value"] for row in report["summary"]}
    assert values == {"Ixy": "0.888868", "Zxy": "0.00358851", "Cxy": "1.26155"}
    assert len(report["nails"]) == 15
    assert report["panelArea"] == 555100

    steps = {row["label"]: row["value"] for row in report["steps"]}
    assert steps["X方向 中立軸 x0"] == "445.000 mm"
    assert steps["二次モーメント Iy"] == "1,980,250 mm²"
    assert steps["変形割合 αx"] == "0.750834"


def test_compute_all_reports_a_broken_pattern_without_losing_the_others():
    data = panel_shear.normalize_data(
        {"patterns": [dict(EXAMPLE), {"patternId": "p2", "width": 610, "height": 910}]}
    )

    reports = panel_shear.compute_all(data)

    assert reports[0]["ok"] is True
    assert reports[1]["ok"] is False
    assert "釘座標" in reports[1]["error"]


def test_validate_names_the_pattern_that_cannot_be_calculated():
    data = panel_shear.normalize_data(
        {"patterns": [{"patternName": "南面", "width": 610, "height": 910}]}
    )

    with pytest.raises(panel_shear.PanelShearError, match="「南面」を計算できません"):
        panel_shear.validate(data)


# --- ファイル名 --------------------------------------------------------------


def test_default_file_name_uses_the_project_name():
    assert panel_shear.default_file_name(make_data()) == (
        "釘配列諸定数計算書_○○邸 新築工事.pdf"
    )


def test_default_file_name_without_a_project_name():
    data = make_data(projectName="")
    assert panel_shear.default_file_name(data) == panel_shear.DEFAULT_FILE_NAME


@pytest.mark.parametrize(
    "name,expected",
    [
        ("計算書", "計算書.pdf"),
        ("計算書.pdf", "計算書.pdf"),
        ("a/b:c", "abc.pdf"),
        ("   ", panel_shear.DEFAULT_FILE_NAME),
    ],
)
def test_ensure_pdf_extension(name, expected):
    assert panel_shear.ensure_pdf_extension(name) == expected


# --- PDF の生成と読み戻し ----------------------------------------------------


def build_example_pdf(**overrides) -> tuple[dict, bytes]:
    data = make_data(**overrides)
    return data, panel_shear.build_pdf(data, panel_shear.validate(data))


def test_pdf_has_one_page_per_pattern():
    second = dict(EXAMPLE, patternId="p2", patternName="南面")
    _, pdf_bytes = build_example_pdf(patterns=[dict(EXAMPLE), second])

    # ページ区切り（改ページ）で数える。
    assert extract_text(io.BytesIO(pdf_bytes)).count("\x0c") == 2


def test_pdf_prints_the_inputs_and_the_results():
    _, pdf_bytes = build_example_pdf()

    text = extract_text(io.BytesIO(pdf_bytes))

    assert "面材張り耐力要素 釘配列諸定数 計算書" in text
    assert "○○邸 新築工事" in text
    assert "作成日: 2026年8月11日" in text
    # 入力（面材寸法・面積）と、画面に出るのと同じ桁の結果。
    assert "610 × 910 mm" in text
    assert "555,100 mm²" in text
    assert "0.888868" in text
    assert "0.00358851" in text
    assert "1.26155" in text
    # 途中経過は式番号つきで白箱化する。
    assert "(3.2.7)" in text
    assert "0.750834" in text


def test_pdf_round_trips_the_form_input():
    """保存した PDF を開き直せば、入力を完全に復元できる（保存形式そのもの）。"""
    data, pdf_bytes = build_example_pdf()

    assert panel_shear.parse_pdf(pdf_bytes) == data


def test_pdf_round_trips_coordinate_input():
    pattern = {
        "patternId": "p9",
        "patternName": "座標入力",
        "width": 910,
        "height": 2730,
        "mode": "coords",
        "coords": "0, 0\n0, 455\n455, 910",
    }
    data, pdf_bytes = build_example_pdf(patterns=[pattern])

    parsed = panel_shear.parse_pdf(pdf_bytes)

    assert parsed["patterns"][0]["mode"] == "coords"
    assert parsed["patterns"][0]["coords"] == "0, 0\n0, 455\n455, 910"


def test_embedded_input_is_ascii_only():
    """文書情報は ASCII に収め、PDF の文字コードの差異を避ける。"""
    _, pdf_bytes = build_example_pdf()

    from app import pdf_tools

    raw = pdf_tools.read_metadata_value(pdf_bytes, panel_shear.METADATA_KEY)
    assert raw.isascii()
    assert json.loads(raw)["projectName"] == "○○邸 新築工事"


def test_parse_pdf_rejects_a_pdf_from_another_tool():
    from app import pdf_write

    document = pdf_write.Document()
    document.add_page().text(50, 700, "別のツールが作った PDF", 10)

    with pytest.raises(panel_shear.PanelShearError, match="このツールで作成した"):
        panel_shear.parse_pdf(document.to_bytes())


@pytest.mark.parametrize("content", [b"", b"%PNG\r\n"])
def test_parse_pdf_rejects_non_pdf_content(content):
    with pytest.raises(panel_shear.PanelShearError):
        panel_shear.parse_pdf(content)
