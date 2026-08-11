"""構造計算安全証明書の生成・解析ロジックのテスト。

雛形（Google ドキュメント）そのものは扱わず、書き出し後の PDF に対する
○ の描き込みと、PDF からフォームデータへの復元を検証する。
"""

import io

import pytest
from pypdf import PdfReader, PdfWriter

from app import pdf_tools, structural_cert
from app.structural_cert import CertificateError
from tests.pdf_util import SAMPLE_FIELDS, make_certificate_pdf, make_pdf

SAMPLE_CHOICES = {
    "building_category": "2",
    "calc_type": "1",
    "calc_method": "2",
    "program_certified": "有",
}


def sample_data(fields=None, choices=None):
    merged_fields = dict(SAMPLE_FIELDS)
    merged_fields.update(fields or {})
    merged_choices = dict(SAMPLE_CHOICES)
    merged_choices.update(choices or {})
    return structural_cert.normalize_data(
        {"fields": merged_fields, "choices": merged_choices}
    )


def strip_metadata(pdf_bytes: bytes) -> bytes:
    """このツールが作った PDF から文書情報を落とす（本文解析の経路を試すため）。"""
    reader = PdfReader(io.BytesIO(pdf_bytes))
    writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


# --- フォーム定義 -----------------------------------------------------------

def fields_of(item) -> list[str]:
    """画面の 1 項目が受け持つ記入欄のキー。

    日付ピッカー（date）は年号年・月・日の 3 欄をまとめて入力する。
    """
    if "field" in item:
        return [item["field"]]
    if "date" in item:
        return [item["date"][key] for key in ("era_year", "month", "day")]
    return []


def test_form_config_covers_every_field_and_choice():
    config = structural_cert.form_config()

    field_keys = {f["key"] for f in config["text_fields"]}
    choice_keys = {g["key"] for g in config["choice_groups"]}
    assert "building_name" in field_keys
    assert choice_keys == {
        "building_category",
        "calc_type",
        "calc_method",
        "program_certified",
    }

    # 画面の並び（sections）が参照するキーはすべて定義済みでなければならない。
    for section in config["sections"]:
        for item in section["items"]:
            if "choice" in item:
                assert item["choice"] in choice_keys
            else:
                keys = fields_of(item)
                assert keys, f"未知の項目です: {item}"
                for key in keys:
                    assert key in field_keys


def test_form_config_lists_every_field_in_some_section():
    config = structural_cert.form_config()
    placed = {
        key
        for section in config["sections"]
        for item in section["items"]
        for key in fields_of(item)
    }

    assert placed == {f["key"] for f in config["text_fields"]}


# --- 入力の正規化と検証 -----------------------------------------------------

def test_normalize_drops_unknown_keys_and_invalid_choices():
    data = structural_cert.normalize_data(
        {
            "fields": {"building_name": " サンプル邸 ", "unknown": "x"},
            "choices": {"building_category": "9", "unknown": "1"},
        }
    )

    assert data["fields"]["building_name"] == "サンプル邸"
    assert "unknown" not in data["fields"]
    # 定義に無い選択肢は未選択として扱う。
    assert data["choices"]["building_category"] == ""
    assert "unknown" not in data["choices"]


def test_normalize_clears_fields_of_unselected_options():
    # 「６ その他」を選んでいなければ、その内容は証明書に残さない。
    data = sample_data(fields={"other_calc_type": "限界耐力計算"}, choices={"calc_type": "1"})

    assert data["fields"]["other_calc_type"] == ""


def test_normalize_keeps_fields_of_selected_options():
    data = sample_data(fields={"other_calc_type": "限界耐力計算"}, choices={"calc_type": "6"})

    assert data["fields"]["other_calc_type"] == "限界耐力計算"


def test_validate_reports_every_missing_item_at_once():
    data = sample_data(fields={"building_name": "", "structure": ""}, choices={"calc_type": ""})

    with pytest.raises(CertificateError) as excinfo:
        structural_cert.validate(data)

    message = str(excinfo.value)
    assert "建築物の名称" in message
    assert "構造" in message
    assert "構造計算の種類" in message


def test_validate_requires_the_eaves_height():
    data = sample_data(fields={"eaves_height": ""})

    with pytest.raises(CertificateError) as excinfo:
        structural_cert.validate(data)

    assert "最高の軒の高さ" in str(excinfo.value)


def test_validate_allows_an_empty_remarks():
    structural_cert.validate(sample_data(fields={"remarks": ""}))


def test_validate_requires_the_field_of_the_selected_option():
    data = sample_data(choices={"calc_type": "6"}, fields={"other_calc_type": ""})

    with pytest.raises(CertificateError) as excinfo:
        structural_cert.validate(data)

    assert "その他の構造計算の種類" in str(excinfo.value)


def test_validate_passes_for_complete_input():
    structural_cert.validate(sample_data())


# --- プレースホルダー -------------------------------------------------------

def test_build_replacements_covers_all_placeholders_including_empty_fields():
    data = sample_data(fields={"program_name": ""})

    replacements = structural_cert.build_replacements(data)

    assert replacements["{{建物名称}}"] == "サンプル邸"
    assert replacements["{{備考}}"] == "特記事項なし"
    # 未入力でも置換対象にする（プレースホルダーが証明書に残らないように）。
    assert replacements["{{プログラム名}}"] == ""
    # 雛形の表記ゆれ（波括弧 1 つ）にも両方対応する。
    assert "{{その他の構造計算の種類}}" in replacements
    assert "{その他の構造計算の種類}" in replacements


def test_missing_placeholder_warning_only_for_filled_fields():
    data = sample_data(fields={"program_name": ""})
    counts = {p: 1 for p in structural_cert.build_replacements(data)}
    counts["{{建物名称}}"] = 0
    counts["{{プログラム名}}"] = 0

    warnings = structural_cert.missing_placeholder_warnings(counts, data)

    assert len(warnings) == 1
    assert "建築物の名称" in warnings[0]


def test_missing_placeholder_warning_accepts_any_alternative_placeholder():
    data = sample_data(fields={"other_calc_type": "限界耐力計算"}, choices={"calc_type": "6"})
    counts = {p: 1 for p in structural_cert.build_replacements(data)}
    # 雛形には波括弧 1 つの表記しか無い、という状況。
    counts["{{その他の構造計算の種類}}"] = 0

    assert structural_cert.missing_placeholder_warnings(counts, data) == []


# --- ファイル名 -------------------------------------------------------------

def test_default_file_name_uses_the_building_name():
    assert structural_cert.default_file_name(sample_data()) == "構造計算安全証明書_サンプル邸.pdf"


def test_default_file_name_without_building_name():
    data = sample_data(fields={"building_name": ""})

    assert structural_cert.default_file_name(data) == "構造計算安全証明書.pdf"


def test_default_file_name_strips_path_separators():
    data = sample_data(fields={"building_name": "A/B:C"})

    assert structural_cert.default_file_name(data) == "構造計算安全証明書_ABC.pdf"


@pytest.mark.parametrize(
    "given, expected",
    [
        ("証明書", "証明書.pdf"),
        ("証明書.pdf", "証明書.pdf"),
        ("証明書.PDF", "証明書.PDF"),
        ("", "構造計算安全証明書.pdf"),
        ("  ", "構造計算安全証明書.pdf"),
        ("a/b", "ab.pdf"),
    ],
)
def test_ensure_pdf_extension(given, expected):
    assert structural_cert.ensure_pdf_extension(given) == expected


# --- ○ の描き込み -----------------------------------------------------------

def test_finalize_marks_only_the_selected_options():
    pdf = make_certificate_pdf()

    result = structural_cert.finalize_pdf(pdf, sample_data())

    page = pdf_tools.read_layout(result)[0]
    # 選んだ 4 グループぶんだけ ○ が描かれる。
    assert len(page.curves) == 4
    # ○ は「２法第20条…」の行頭の番号を囲む。
    line = page.line_equal("2法第20条第1項第2号に掲げる建築物")
    number = line.box_for(0, 1)
    assert any(curve.contains(number, tolerance=0.5) for curve in page.curves)
    # 選んでいない選択肢には描かない。
    other = page.line_equal("3法第20条第1項第3号に掲げる建築物").box_for(0, 1)
    assert not any(curve.contains(other, tolerance=0.5) for curve in page.curves)


def test_finalize_circles_numbers_and_checks_the_box():
    """番号は正円で囲み、□ にはレ点を入れる。"""
    pdf = make_certificate_pdf()
    data = sample_data(choices={"building_category": "2", "program_certified": "有"})

    page = pdf_tools.read_layout(structural_cert.finalize_pdf(pdf, data))[0]

    number = page.line_equal("2法第20条第1項第2号に掲げる建築物").box_for(0, 1)
    circle = next(c for c in page.curves if c.contains(number, tolerance=0.5))
    # 文字の外接矩形は縦長でも、○ は正円になる。
    assert circle.width == pytest.approx(circle.height, abs=0.3)
    assert circle.width > number.width

    checkbox_line = page.line_equal("2国土交通大臣の認定□有□無")
    checkbox = checkbox_line.box_for(checkbox_line.text.index("□有"), 1)
    check = next(c for c in page.curves if checkbox.contains(c, tolerance=1.0))
    # レ点は □ の中に収まる（○ のように文字を囲まない）。
    assert not check.contains(checkbox)

    # 「無」の □ には何も付けない。
    unchecked = checkbox_line.box_for(checkbox_line.text.index("□無"), 1)
    assert not any(unchecked.contains(c, tolerance=1.0) for c in page.curves)


def test_finalize_marks_nothing_when_no_option_is_selected():
    pdf = make_certificate_pdf()
    data = structural_cert.normalize_data({"fields": {}, "choices": {}})

    result = structural_cert.finalize_pdf(pdf, data)

    assert pdf_tools.read_layout(result)[0].curves == []


def test_finalize_fails_when_the_template_lost_a_choice():
    # 選択肢の行が無い PDF（雛形のレイアウトが変わった状況）。
    pdf = make_pdf([("建築物の区分", 100.0, 700.0)])
    data = structural_cert.normalize_data(
        {"fields": {}, "choices": {"building_category": "2"}}
    )

    with pytest.raises(CertificateError) as excinfo:
        structural_cert.finalize_pdf(pdf, data)

    assert excinfo.value.status == 409
    assert "建築物の区分" in str(excinfo.value)


def test_finalize_fails_when_a_choice_anchor_is_ambiguous():
    # 同じ選択肢の行が 2 つある PDF。どちらに ○ を付けるか決められない。
    line = "２法第20条第1項第2号に掲げる建築物"
    pdf = make_pdf([(line, 250.0, 700.0), (line, 250.0, 600.0)])
    data = structural_cert.normalize_data(
        {"fields": {}, "choices": {"building_category": "2"}}
    )

    with pytest.raises(CertificateError) as excinfo:
        structural_cert.finalize_pdf(pdf, data)

    assert excinfo.value.status == 409
    assert "複数見つかった" in str(excinfo.value)


# --- 解析（編集機能） -------------------------------------------------------

def test_parse_restores_everything_from_metadata():
    data = sample_data()
    pdf = structural_cert.finalize_pdf(make_certificate_pdf(), data)

    parsed = structural_cert.parse_pdf(pdf)

    assert parsed["source"] == "metadata"
    assert parsed["warnings"] == []
    assert parsed["fields"] == data["fields"]
    assert parsed["choices"] == data["choices"]


def test_parse_falls_back_to_the_document_body():
    data = sample_data()
    pdf = strip_metadata(structural_cert.finalize_pdf(make_certificate_pdf(), data))

    parsed = structural_cert.parse_pdf(pdf)

    assert parsed["source"] == "content"
    fields = parsed["fields"]
    assert fields["era_year"] == "令和7"
    assert fields["month"] == "8"
    assert fields["day"] == "10"
    assert fields["client_name"] == "株式会社サンプル"
    assert fields["building_address"] == "神奈川県相模原市緑区青山1766番地6"
    assert fields["building_area"] == "62.10"
    assert fields["total_floor_area"] == "115.52"
    assert fields["max_height"] == "8.750"
    assert fields["eaves_height"] == "6.320"
    assert fields["floors_above"] == "2"
    assert fields["floors_below"] == "0"
    assert fields["structure"] == "木"
    assert fields["structure_part"] == "鉄筋コンクリート"
    assert fields["program_name"] == "サンプル構造計算"
    assert fields["program_cert_number"] == "TPRG-1234"
    assert fields["remarks"] == "特記事項なし"
    # ○ はベクター図形なので、位置から選択を復元できる。
    assert parsed["choices"] == data["choices"]


def test_parse_from_body_warns_about_estimation_and_unsplittable_fields():
    pdf = strip_metadata(structural_cert.finalize_pdf(make_certificate_pdf(), sample_data()))

    warnings = structural_cert.parse_pdf(pdf)["warnings"]

    assert "推定" in warnings[0]
    # 名称と用途は雛形上で同じ行に並ぶため分離できない旨を伝える。
    assert any("建築物の用途" in w for w in warnings[1:])


def test_parse_from_body_keeps_name_and_use_together():
    pdf = strip_metadata(structural_cert.finalize_pdf(make_certificate_pdf(), sample_data()))

    fields = structural_cert.parse_pdf(pdf)["fields"]

    assert fields["building_name"] == "サンプル邸一戸建ての住宅"
    assert fields["building_use"] == ""


def test_parse_of_an_unmarked_certificate_leaves_choices_empty():
    parsed = structural_cert.parse_pdf(make_certificate_pdf())

    assert parsed["source"] == "content"
    assert parsed["choices"] == {
        "building_category": "",
        "calc_type": "",
        "calc_method": "",
        "program_certified": "",
    }


def test_parse_rejects_non_pdf_input():
    with pytest.raises(CertificateError):
        structural_cert.parse_pdf(b"")
    with pytest.raises(CertificateError):
        structural_cert.parse_pdf(b"%ZIP not a pdf")


def test_parse_ignores_broken_metadata_and_reads_the_body():
    pdf = pdf_tools.stamp_marks(
        make_certificate_pdf(),
        {},
        metadata={structural_cert.load_mapping()["metadata_key"]: "壊れた JSON"},
    )

    parsed = structural_cert.parse_pdf(pdf)

    assert parsed["source"] == "content"
    assert parsed["fields"]["client_name"] == "株式会社サンプル"
