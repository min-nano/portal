"""Excel の雛形を表にする（xlsx_preview）のテスト。

画面は返した形をそのまま <table> に組み立てるので、結合で隠れるセルを
含めないこと・隠した行と列を落とすこと・見せる範囲の決め方を固定する。
"""

import datetime
import io

import pytest
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Color, Font, PatternFill, Side

from app import xlsx_preview

THIN = Side(style="thin")


def workbook_bytes(build) -> bytes:
    """build(wb) で中身を作ったワークブックを、保存したバイト列にする。"""
    wb = Workbook()
    build(wb)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def only_sheet(build) -> dict:
    (sheet,) = xlsx_preview.sheets(workbook_bytes(build))
    return sheet


def values(sheet) -> list[list[str]]:
    return [[cell["v"] for cell in row["cells"]] for row in sheet["rows"]]


def test_empty_sheet_has_no_rows():
    sheet = only_sheet(lambda wb: None)

    assert sheet == {"name": "Sheet", "cols": [], "rows": [], "truncated": False}


def test_area_surrounds_values_borders_fills_and_merges():
    def build(wb):
        ws = wb.active
        ws["B2"] = "値"
        ws["D3"].border = Border(bottom=THIN)
        ws["C5"].fill = PatternFill("solid", fgColor="FFFF00")
        ws.merge_cells("E2:F2")
        # 書式だけで中身の無いセルは、範囲を広げない。
        ws["J20"].font = Font(b=True)
        ws["J21"] = ""

    sheet = only_sheet(build)

    assert len(sheet["cols"]) == 5  # B〜F
    assert len(sheet["rows"]) == 4  # 2〜5
    assert values(sheet)[0] == ["値", "", "", ""]  # E2:F2 は 1 つにまとまる


def test_far_away_formatted_cell_does_not_blow_up():
    # シートの端に、中身の無い書式だけのセルが 1 つある（Ctrl+End が飛ぶ
    # ブックによくある）。升目をすべて作ると止まらなくなる。
    def build(wb):
        ws = wb.active
        ws["A1"] = "値"
        ws["XFD1048576"].font = Font(b=True)

    assert values(only_sheet(build)) == [["値"]]


def test_far_away_value_is_cut_at_the_limit():
    def build(wb):
        ws = wb.active
        ws["A1"] = "近く"
        ws["A1"].border = Border(top=THIN)
        ws["XFD1048576"] = "遠く"

    sheet = only_sheet(build)

    assert sheet["truncated"] is True
    assert len(sheet["cols"]) == xlsx_preview.MAX_COLS
    assert len(sheet["rows"]) == xlsx_preview.MAX_ROWS
    assert sheet["rows"][0]["cells"][0] == {"v": "近く", "bd": "t"}


def test_print_area_decides_the_area():
    def build(wb):
        ws = wb.active
        ws["A1"] = "範囲の外"
        ws["B2"] = "左上"
        ws["C3"] = "右下"
        ws.print_area = "B2:C3"

    assert values(only_sheet(build)) == [["左上", ""], ["", "右下"]]


def test_hidden_sheets_rows_and_columns_are_left_out():
    def build(wb):
        ws = wb.active
        ws.title = "表示"
        for row in range(1, 4):
            for col in "ABC":
                ws[f"{col}{row}"] = f"{col}{row}"
        ws.row_dimensions[2].hidden = True
        ws.column_dimensions["B"].hidden = True
        wb.create_sheet("隠し").sheet_state = "hidden"

    (sheet,) = xlsx_preview.sheets(workbook_bytes(build))

    assert sheet["name"] == "表示"
    assert values(sheet) == [["A1", "C1"], ["A3", "C3"]]


def test_merged_cells_span_and_hide_the_rest():
    def build(wb):
        ws = wb.active
        ws["A1"] = "見出し"
        ws.merge_cells("A1:C2")
        ws["D1"] = "右"
        ws["A3"] = "下"

    sheet = only_sheet(build)

    assert [row["cells"] for row in sheet["rows"]] == [
        [{"v": "見出し", "rs": 2, "cs": 3}, {"v": "右"}],
        [{"v": ""}],
        [{"v": "下"}, {"v": ""}, {"v": ""}, {"v": ""}],
    ]


def test_merge_counts_only_shown_rows_and_columns():
    def build(wb):
        ws = wb.active
        ws["A1"] = "結合"
        ws.merge_cells("A1:C3")
        ws.row_dimensions[1].hidden = True  # 左上の行が隠れていても値は出す
        ws.column_dimensions["B"].hidden = True
        ws["D4"] = "端"

    sheet = only_sheet(build)

    assert sheet["rows"][0]["cells"][0] == {"v": "結合", "rs": 2, "cs": 2}


def test_merge_outside_the_shown_area_is_ignored():
    def build(wb):
        ws = wb.active
        ws["A1"] = "外"
        ws.merge_cells("A1:B1")
        ws["C3"] = "中"
        ws.print_area = "C2:D3"

    assert values(only_sheet(build)) == [["", ""], ["中", ""]]


def test_merge_borders_come_from_the_edges():
    def build(wb):
        ws = wb.active
        ws["B2"] = "枠"
        ws.merge_cells("B2:C3")
        ws["B2"].border = Border(top=THIN, left=THIN)
        ws["C2"].border = Border(right=THIN)
        ws["B3"].border = Border(bottom=THIN)

    sheet = only_sheet(build)

    assert sheet["rows"][0]["cells"][0]["bd"] == "trbl"


def test_cell_styles():
    def build(wb):
        ws = wb.active
        ws["A1"] = "太字"
        ws["A1"].font = Font(b=True, sz=14)
        ws["B1"] = "中央"
        ws["B1"].alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        ws["C1"] = 12
        ws["D1"] = "左"
        ws["D1"].alignment = Alignment(horizontal="left", vertical="top")
        ws["E1"] = 3
        ws["E1"].alignment = Alignment(horizontal="left")
        ws["F1"] = "罫線"
        ws["F1"].border = Border(top=THIN, bottom=THIN)
        ws["G1"] = "塗り"
        ws["G1"].fill = PatternFill("solid", fgColor="FFCCE5FF")
        ws["H1"] = "テーマの色"
        ws["H1"].fill = PatternFill("solid", fgColor=Color(theme=4))
        ws["I1"] = True

    cells = only_sheet(build)["rows"][0]["cells"]

    assert cells == [
        {"v": "太字", "b": True, "fs": 19},
        {"v": "中央", "a": "center", "va": "middle", "w": True},
        {"v": "12", "a": "right"},  # 標準の揃えでは、数値は右
        {"v": "左", "va": "top"},
        {"v": "3"},  # 左揃えを指定した数値
        {"v": "罫線", "bd": "tb"},
        {"v": "塗り", "bg": "#cce5ff"},
        {"v": "テーマの色"},  # テーマの色は出さない
        {"v": "True"},
    ]


@pytest.mark.parametrize(
    ("value", "text"),
    [
        (datetime.datetime(2026, 4, 1), "2026/04/01"),
        (datetime.datetime(2026, 4, 1, 9, 30), "2026/04/01 09:30"),
        (2.0, "2"),
        (0.1 + 0.2, "0.3"),
        ("(例)ＬＤＫ", "(例)ＬＤＫ"),
    ],
)
def test_values_become_text(value, text):
    def build(wb):
        wb.active["A1"] = value

    assert values(only_sheet(build)) == [[text]]


def test_sizes_are_in_pixels():
    def build(wb):
        ws = wb.active
        ws["A1"] = "既定"
        ws["B2"] = "指定"
        ws.column_dimensions["B"].width = 20
        ws.row_dimensions[2].height = 30

    sheet = only_sheet(build)

    assert sheet["cols"] == [64, 145]
    assert [row["h"] for row in sheet["rows"]] == [20, 40]


def test_sheet_default_column_width():
    def build(wb):
        ws = wb.active
        ws["A1"] = "既定"
        ws.sheet_format.defaultColWidth = 10

    assert only_sheet(build)["cols"] == [75]


def test_large_area_is_truncated(monkeypatch):
    monkeypatch.setattr(xlsx_preview, "MAX_ROWS", 2)
    monkeypatch.setattr(xlsx_preview, "MAX_COLS", 3)

    def build(wb):
        wb.active["E5"] = "遠く"
        wb.active["A1"] = "近く"

    sheet = only_sheet(build)

    assert sheet["truncated"] is True
    assert len(sheet["cols"]) == 3
    assert len(sheet["rows"]) == 2


def test_broken_file_raises_preview_error():
    with pytest.raises(xlsx_preview.PreviewError):
        xlsx_preview.sheets(b"not a zip")
