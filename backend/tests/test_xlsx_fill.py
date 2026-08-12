"""xlsx を壊さずに書き換えるエディタ（app/xlsx_fill.py）の検証。

このモジュールが担うのは「触った場所以外は 1 バイトも変えない」こと。
配布物（表計算ツール）はチェックボックス・図・印刷設定を含んでいて、
それが消えると提出物として使えなくなるため、そこを実物で確かめる。
"""

import datetime
import io
import zipfile
import xml.etree.ElementTree as ET

import pytest

from app import wall_quantity
from app.xlsx_fill import XlsxError, XlsxTemplate, column_index, split_ref, to_serial

ONE_STORY = "表計算ツール（平屋建て）"


@pytest.fixture
def template():
    return XlsxTemplate(wall_quantity.template_bytes())


def parts(data: bytes) -> dict:
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        return {name: zf.read(name) for name in zf.namelist()}


def _related(template, after: dict, kind: str) -> list:
    """平屋建てシートに紐づく部品だけを取り出す。"""
    return [
        after[path].decode("utf-8")
        for path in template.related_parts(ONE_STORY, kind)
    ]


def _linked(template, after: dict, kind: str, marker: str) -> list:
    return [x for x in _related(template, after, kind) if marker in x]


def test_column_index_and_split_ref():
    assert column_index("A") == 1
    assert column_index("Z") == 26
    assert column_index("AA") == 27
    assert split_ref("AB123") == ("AB", 123)
    with pytest.raises(XlsxError):
        split_ref("123")


def test_to_serial_matches_excel_1900_system():
    # 配布物の入力例に入っている 45018 は 2023-04-02。
    assert to_serial(datetime.date(2023, 4, 2)) == 45018
    assert to_serial(datetime.datetime(2023, 4, 2, 12, 0)) == 45018


def test_sheet_names_are_resolved(template):
    names = template.sheet_paths()
    assert ONE_STORY in names
    assert names[ONE_STORY].startswith("xl/worksheets/")


def test_cell_text_reads_shared_strings_without_phonetic(template):
    # C15 の共有文字列にはふりがな（rPh）が付いている。表示される文字だけを返す。
    assert template.cell_text(ONE_STORY, "C15") == "1階階高（ｍ）"
    assert template.cell_text(ONE_STORY, "H18") == "0.2"
    assert template.cell_text(ONE_STORY, "A3") is None


def test_cell_text_reads_a_value_that_ends_with_a_space(template):
    """末尾に空白がある値（<v xml:space="preserve">）も読めること。

    配布物の機械等級区分は「E150 」と末尾に空白が入っていて、これを
    読み落とすと圧縮基準強度の引き当てが静かに外れる。
    """
    assert template.cell_text("柱の圧縮基準強度", "D8") == "E150 "
    assert template.cell_text("柱の圧縮基準強度", "A8") == (
        "JAS機械等級区分構造用製材あかまつE150 "
    )


def test_formulas_can_be_read_for_the_guard(template):
    """数式が読めること（配布物の計算が変わっていないかの番人テストで使う）。"""
    # 平屋建ての「1階の壁荷重」。
    assert template.cell_formula(ONE_STORY, "Z36").startswith("(VLOOKUP($H26,")
    # 数式の無いセル・存在しないセルは None。
    assert template.cell_formula(ONE_STORY, "H18") is None
    assert template.cell_formula(ONE_STORY, "ZZ999") is None

    cells = template.formula_cells(ONE_STORY)
    assert cells["Z36"] == template.cell_formula(ONE_STORY, "Z36")
    # 空のセル（<c r="…"/>）の次にある数式を取り違えないこと。
    assert cells == _formulas_by_xml(template, ONE_STORY)


def _formulas_by_xml(template, sheet: str) -> dict:
    """同じものを XML パーサで読み直す（正規表現の取りこぼしの検出）。"""
    ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    root = ET.fromstring(template._text(template._sheet_path(sheet)))
    found = {}
    for cell in root.iter(f"{ns}c"):
        formula = cell.find(f"{ns}f")
        if formula is not None and formula.text:
            found[cell.get("r")] = formula.text
    return found


def test_unknown_sheet_is_rejected(template):
    with pytest.raises(XlsxError):
        template.cell_text("ないシート", "A1")


def test_only_touched_parts_change(template):
    before = parts(wall_quantity.template_bytes())
    template.set_values(ONE_STORY, {"K4": "見本邸"})
    after = parts(template.to_bytes())

    assert set(before) == set(after)  # 部品が 1 つも消えない
    changed = [name for name in before if before[name] != after[name]]
    assert changed == [template.sheet_paths()[ONE_STORY]]


def test_checkbox_state_is_written_in_all_three_places(template):
    template.set_checkbox(ONE_STORY, "W8", True)
    after = parts(template.to_bytes())

    sheet = after[template.sheet_paths()[ONE_STORY]].decode("utf-8")
    assert '<c r="W8"' in sheet and 't="b"' in sheet

    # 同じ $W$8 を参照するチェックボックスは入力例シートにもあるので、
    # このシートに紐づく部品だけを見る。
    ctrl = _linked(template, after, "ctrlProp", 'fmlaLink="$W$8"')
    assert ctrl and all('checked="Checked"' in x for x in ctrl)

    vml = _related(template, after, "vmlDrawing")
    assert any("<x:Checked>1</x:Checked><x:FmlaLink>$W$8</x:FmlaLink>" in x for x in vml)


def test_checkbox_can_be_cleared(template):
    template.set_checkbox(ONE_STORY, "W8", True)
    template.set_checkbox(ONE_STORY, "W8", False)
    after = parts(template.to_bytes())

    ctrl = _linked(template, after, "ctrlProp", 'fmlaLink="$W$8"')
    assert ctrl and all("checked=" not in x for x in ctrl)

    vml = _related(template, after, "vmlDrawing")
    assert not any("<x:Checked>1</x:Checked><x:FmlaLink>$W$8</x:FmlaLink>" in x for x in vml)


def test_unknown_checkbox_is_rejected(template):
    with pytest.raises(XlsxError):
        template.set_checkbox(ONE_STORY, "A1", True)


def test_recalculate_on_open_is_set_once(template):
    template.recalculate_on_open()
    template.recalculate_on_open()
    workbook = parts(template.to_bytes())["xl/workbook.xml"].decode("utf-8")
    assert workbook.count('fullCalcOnLoad="1"') == 1


def test_written_xml_stays_well_formed(template):
    template.set_values(
        ONE_STORY,
        {
            "K4": '記号 < > & " を含む名前',
            "H15": 3.25,
            "H22": 60,
            "D4": datetime.date(2026, 8, 12),
            "H20": None,
        },
    )
    template.set_checkbox(ONE_STORY, "W52", True)
    template.recalculate_on_open()
    for name, content in parts(template.to_bytes()).items():
        if name.endswith((".xml", ".rels", ".vml")):
            ET.fromstring(content)  # 壊れていれば例外


def test_newline_in_a_string_survives_the_round_trip(template):
    # 選択肢の文字列は配布物の数式が VLOOKUP で引き当てるので、改行を含めて
    # 1 文字も変えずに書けないと計算が崩れる。
    value = wall_quantity.load_mapping()["options"]["solar"][1]
    assert "\n" in value
    template.set_values(ONE_STORY, {"H27": value})
    assert XlsxTemplate(template.to_bytes()).cell_text(ONE_STORY, "H27") == value


def test_style_is_kept_when_a_value_is_written(template):
    original = parts(wall_quantity.template_bytes())[template.sheet_paths()[ONE_STORY]]
    original = original.decode("utf-8")
    assert '<c r="D4" s="408"/>' in original

    template.set_values(ONE_STORY, {"D4": "2026/8/12"})
    sheet = parts(template.to_bytes())[template.sheet_paths()[ONE_STORY]].decode("utf-8")
    assert '<c r="D4" s="408" t="inlineStr">' in sheet


# --- 空のブックに対する「行・セルの差し込み」 -------------------------------
#
# 配布物の入力欄はすべて書式が付いていて XML 上に既にあるため、差し込みの
# 経路は実物では通らない。将来の改訂で空のセルが来ても壊れないよう、
# 最小限のブックを組み立てて確かめておく。


def _minimal_workbook(sheet_xml: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/'
            'package/2006/content-types"/>',
        )
        zf.writestr(
            "xl/workbook.xml",
            '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/'
            'spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/'
            'officeDocument/2006/relationships"><sheets><sheet name="Sheet1" '
            'sheetId="1" r:id="rId1"/></sheets><calcPr calcId="1"/></workbook>',
        )
        zf.writestr(
            "xl/_rels/workbook.xml.rels",
            '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats'
            '.org/package/2006/relationships"><Relationship Id="rId1" Type="http://'
            'schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
            'Target="worksheets/sheet1.xml"/></Relationships>',
        )
        zf.writestr("xl/worksheets/sheet1.xml", sheet_xml)
    return buf.getvalue()


def _sheet(body: str) -> str:
    return (
        '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/'
        f"spreadsheetml/2006/main\"><sheetData>{body}</sheetData></worksheet>"
    )


def _read(data: bytes) -> str:
    return parts(data)["xl/worksheets/sheet1.xml"].decode("utf-8")


def test_a_missing_cell_is_inserted_in_column_order():
    book = XlsxTemplate(
        _minimal_workbook(_sheet('<row r="1"><c r="A1"/><c r="C1"/></row>'))
    )
    book.set_values("Sheet1", {"B1": 5})
    sheet = _read(book.to_bytes())
    assert sheet.index('r="A1"') < sheet.index('r="B1"') < sheet.index('r="C1"')


def test_a_missing_cell_is_appended_after_the_last_column():
    book = XlsxTemplate(_minimal_workbook(_sheet('<row r="1"><c r="A1"/></row>')))
    book.set_values("Sheet1", {"D1": 5})
    sheet = _read(book.to_bytes())
    assert sheet.index('r="A1"') < sheet.index('r="D1"')


def test_a_missing_row_is_inserted_in_row_order():
    book = XlsxTemplate(
        _minimal_workbook(_sheet('<row r="1"><c r="A1"/></row><row r="3"/>'))
    )
    book.set_values("Sheet1", {"A2": "中", "B3": "後"})
    sheet = _read(book.to_bytes())
    assert sheet.index('r="A1"') < sheet.index('r="A2"') < sheet.index('r="B3"')


def test_a_row_is_added_to_an_empty_sheet():
    book = XlsxTemplate(
        _minimal_workbook(
            '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/'
            'spreadsheetml/2006/main"><sheetData/></worksheet>'
        )
    )
    book.set_values("Sheet1", {"B2": True})
    sheet = _read(book.to_bytes())
    assert '<row r="2"><c r="B2" t="b"><v>1</v></c></row>' in sheet


def test_values_are_written_with_the_right_type():
    book = XlsxTemplate(_minimal_workbook(_sheet("")))
    book.set_values(
        "Sheet1",
        {"A1": 3, "A2": 1.5, "A3": "文字", "A4": True, "A5": None, "A6": ""},
    )
    sheet = _read(book.to_bytes())
    assert "<v>3</v>" in sheet
    assert "<v>1.5</v>" in sheet
    assert 't="inlineStr"' in sheet and "文字" in sheet
    assert '<c r="A4" t="b"><v>1</v></c>' in sheet
    assert '<c r="A5"/>' in sheet and '<c r="A6"/>' in sheet


def test_a_workbook_without_calcpr_is_reported():
    book = XlsxTemplate(_minimal_workbook(_sheet("")))
    book._parts["xl/workbook.xml"] = b"<workbook/>"
    with pytest.raises(XlsxError):
        book.recalculate_on_open()
