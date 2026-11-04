"""Excel の雛形を、画面で表として見せるための形にする（雛形のプレビュー）。

Google ドキュメントの雛形は Drive が PDF に書き出せるが、ネイティブの
.xlsx は書き出せない（変換するには Google スプレッドシートへの複製が要り、
書き込みの権限と一時ファイルが要る）。そこで openpyxl で読み、シートごとに
「列の幅・行の高さ・セルの値・結合・罫線・太字・揃え・塗り」だけを返し、
画面（frontend/src/template-preview.js）が <table> に組み立てる。

見た目は近似で、印刷の体裁そのものではない（テーマの色・図形・画像・
条件付き書式は出ない）。何の雛形が設定されているか、どんな欄があるかを
確かめるための表示。

値は Excel が最後に保存したときの計算結果（data_only）。数式そのものは
見せない。
"""

import datetime
import io
import re

from openpyxl import load_workbook
from openpyxl.utils import range_boundaries

# 1 シートで返す行・列の上限。雛形は数百行に収まる。印刷範囲が広すぎる
# シートで、応答が膨らみすぎないようにする。
MAX_ROWS = 500
MAX_COLS = 100

# Excel の既定の列幅（文字数）。
_DEFAULT_COL_WIDTH = 8.43
# 既定のフォントの大きさ（pt）。これと違うときだけ返す。
_DEFAULT_FONT_SIZE = 11.0

# 印刷範囲（"'シート'!$A$1:$K$50,'シート'!$M$1:$P$9"）の、最初の範囲。
_PRINT_AREA = re.compile(r"!(\$?[A-Z]{1,3}\$?\d+:\$?[A-Z]{1,3}\$?\d+)")

# 横の揃え。Excel の「標準」（general）は、数値なら右・文字なら左。
_HORIZONTAL = {
    "left": "left",
    "right": "right",
    "center": "center",
    "centerContinuous": "center",
    "distributed": "center",
}
# 縦の揃え。Excel の既定は下揃えなので、それ以外だけ返す。
_VERTICAL = {"top": "top", "center": "middle", "distributed": "middle"}


class PreviewError(ValueError):
    """xlsx として読めなかった。"""


def sheets(xlsx_bytes: bytes) -> list[dict]:
    """表示しているシート（隠したシートは除く）を、画面が表に組み立てられる形で返す。

    シートごとに:
      name      … シート名
      cols      … 列の幅（px）
      rows      … 行ごとの {h: 高さ(px), cells: [...]}。cells には結合で
                   隠れるセルを含めない（<table> の rowspan / colspan と同じ）
      truncated … 上限（MAX_ROWS × MAX_COLS）で切ったか

    セルは値 v のほか、必要なときだけ rs / cs（結合）・b（太字）・
    a / va（横・縦の揃え）・w（折り返す）・bd（罫線のある辺。"trbl" の部分）・
    bg（塗り。"#rrggbb"）・fs（文字の大きさ。px）を持つ。
    """
    try:
        wb = load_workbook(io.BytesIO(xlsx_bytes), data_only=True)
        raw = load_workbook(io.BytesIO(xlsx_bytes), read_only=True)
    except Exception as error:  # 壊れたファイルは zip・XML のどこで失敗するか決まらない
        raise PreviewError("雛形を Excel ファイルとして読み込めませんでした。") from error
    try:
        return [
            _sheet(ws, raw_ws)
            for ws, raw_ws in zip(wb.worksheets, raw.worksheets)
            if ws.sheet_state == "visible"
        ]
    finally:
        raw.close()


def _raw_borders(raw_ws, min_col, min_row, max_col, max_row) -> dict[tuple[int, int], str]:
    """見せる範囲のセル（行, 列）→ 罫線のある辺（"trbl" の部分）。罫線の無いセルは含めない。

    罫線だけは、ファイルに書かれたとおりに読み直す（read_only）。openpyxl の
    通常の読み込みは、結合した範囲の左上以外のセルの書式を捨て、左上の罫線を
    縁へ写し直す。Excel で結合したセルに外枠を引くと、右・下の線は右端・
    下端のセルに付くので、通常の読み込みでは枠の右と下が消えてしまう。

    read_only の iter_rows は範囲の中を空のセルで埋めて返すので、上限で
    切ったあとの範囲だけを読む（シートの端に書式の付いたセルが 1 つあっても、
    何十億ものセルを作らないように）。
    """
    borders = {}
    for row in raw_ws.iter_rows(
        min_row=min_row, max_row=max_row, min_col=min_col, max_col=max_col
    ):
        for cell in row:
            border = getattr(cell, "border", None)  # 空のセル（EmptyCell）は持たない
            drawn = border and _drawn((border.top, border.right, border.bottom, border.left))
            if drawn:
                borders[cell.row, cell.column] = drawn
    return borders


def _sheet(ws, raw_ws) -> dict:
    min_col, min_row, max_col, max_row = _area(ws)
    truncated = max_row - min_row + 1 > MAX_ROWS or max_col - min_col + 1 > MAX_COLS
    max_row = min(max_row, min_row + MAX_ROWS - 1)
    max_col = min(max_col, min_col + MAX_COLS - 1)
    borders = _raw_borders(raw_ws, min_col, min_row, max_col, max_row) if max_row else {}

    widths, hidden_cols = _columns(ws)
    cols = [c for c in range(min_col, max_col + 1) if c not in hidden_cols]
    rows = [r for r in range(min_row, max_row + 1) if not ws.row_dimensions[r].hidden]
    anchors, covered = _merges(ws, rows, cols)

    out_rows = []
    for r in rows:
        height = ws.row_dimensions[r].height or ws.sheet_format.defaultRowHeight
        cells = [
            _cell(ws, borders, r, c, anchors.get((r, c)))
            for c in cols
            if (r, c) not in covered
        ]
        out_rows.append({"h": round(height * 4 / 3), "cells": cells})

    return {
        "name": ws.title,
        "cols": [_width_to_px(widths(c)) for c in cols],
        "rows": out_rows,
        "truncated": truncated,
    }


def _area(ws) -> tuple[int, int, int, int]:
    """見せる範囲（min_col, min_row, max_col, max_row）。何も無ければ max が 0。

    印刷範囲があればそれ。無ければ、値・罫線・塗りのあるセルと結合を囲む範囲
    （書式だけが付いた空のセルは含めない。シートの端まで書式が付いていても、
    表が広がりすぎないように）。結合の左上以外のセルは罫線を失っているが、
    結合そのものを範囲に含めるので、範囲は変わらない。

    セルは「ファイルにあるもの」だけを見る。ws.iter_rows() は A1 から
    いちばん遠いセルまでの升目をすべて作るので、端に 1 つセルがあるだけで
    止まらなくなる。openpyxl にはあるセルだけを辿る公開の口が無いので、
    _cells を読む。
    """
    match = _PRINT_AREA.search(ws.print_area or "")
    if match:
        return range_boundaries(match.group(1))

    rows, cols = [], []
    for cell in ws._cells.values():
        if _has_content(cell):
            rows.append(cell.row)
            cols.append(cell.column)
    for merged in ws.merged_cells.ranges:
        rows += [merged.min_row, merged.max_row]
        cols += [merged.min_col, merged.max_col]
    if not rows:
        return 1, 1, 0, 0
    return min(cols), min(rows), max(cols), max(rows)


def _has_content(cell) -> bool:
    if cell.value is not None and cell.value != "":
        return True
    border = cell.border
    return bool(_fill(cell) or _drawn((border.top, border.right, border.bottom, border.left)))


def _columns(ws):
    """列番号 → 幅（文字数）を引く関数と、隠した列。

    openpyxl は同じ幅の列をまとめて 1 つ（min〜max）で持つので、ばらして引く。
    """
    widths, hidden = {}, set()
    for dim in ws.column_dimensions.values():
        for index in range(dim.min, dim.max + 1):
            if dim.hidden:
                hidden.add(index)
            widths[index] = dim.width
    default = ws.sheet_format.defaultColWidth or _DEFAULT_COL_WIDTH
    return (lambda c: widths.get(c, default)), hidden


def _merges(ws, rows, cols):
    """結合の左上 → (結合の範囲, 行数, 列数) と、結合で隠れるセル。

    行数・列数は見せる行・列だけで数える（隠した行・列や、見せる範囲の外に
    はみ出した分は数えない）。結合の左上が隠れているときは、見えている
    いちばん左上のセルに値を出す。
    """
    anchors, covered = {}, set()
    for merged in ws.merged_cells.ranges:
        in_rows = [r for r in rows if merged.min_row <= r <= merged.max_row]
        in_cols = [c for c in cols if merged.min_col <= c <= merged.max_col]
        if not in_rows or not in_cols:
            continue
        top_left = (in_rows[0], in_cols[0])
        anchors[top_left] = (merged, len(in_rows), len(in_cols))
        covered.update((r, c) for r in in_rows for c in in_cols)
        covered.discard(top_left)
    return anchors, covered


def _cell(ws, borders, row, col, merge) -> dict:
    if merge:
        merged, row_span, col_span = merge
        top, left = merged.min_row, merged.min_col
        bottom, right = merged.max_row, merged.max_col
    else:
        row_span = col_span = 1
        top = bottom = row
        left = right = col
    source = ws.cell(top, left)
    # 結合したセルの枠は、上・左を左上のセルが、右を右上の、下を左下のセルが持つ。
    drawn = "".join(
        side
        for side, corner in (
            ("t", (top, left)),
            ("r", (top, right)),
            ("b", (bottom, left)),
            ("l", (top, left)),
        )
        if side in borders.get(corner, "")
    )

    value = source.value
    out = {"v": _text(value)}
    if row_span > 1:
        out["rs"] = row_span
    if col_span > 1:
        out["cs"] = col_span

    font = source.font
    if font.b:
        out["b"] = True
    if font.sz and float(font.sz) != _DEFAULT_FONT_SIZE:
        out["fs"] = round(float(font.sz) * 4 / 3)

    alignment = source.alignment
    numeric = isinstance(value, (int, float)) and not isinstance(value, bool)
    horizontal = _HORIZONTAL.get(alignment.horizontal) or ("right" if numeric else None)
    if horizontal and horizontal != "left":
        out["a"] = horizontal
    vertical = _VERTICAL.get(alignment.vertical)
    if vertical:
        out["va"] = vertical
    if alignment.wrap_text:
        out["w"] = True

    if drawn:
        out["bd"] = drawn
    fill = _fill(source)
    if fill:
        out["bg"] = fill
    return out


def _drawn(sides) -> str:
    """罫線のある辺（上・右・下・左の順の sides から、"trbl" の部分）。"""
    return "".join(name for name, side in zip("trbl", sides) if side is not None and side.style)


def _fill(cell) -> str | None:
    """塗りつぶしの色（"#rrggbb"）。色を直に指定した単色の塗りだけを出す。

    テーマの色（「テーマの色」から選んだもの）は、テーマの定義を読んで
    明るさを掛け合わせないと決まらないので出さない。
    """
    fill = cell.fill
    if fill.fill_type != "solid" or fill.fgColor.type != "rgb":
        return None
    return "#" + fill.fgColor.rgb[-6:].lower()


def _text(value) -> str:
    """セルの値を、画面に出す文字にする（表示形式までは真似ない）。"""
    if value is None:
        return ""
    if isinstance(value, datetime.datetime):
        if value.time() == datetime.time():
            return value.strftime("%Y/%m/%d")
        return value.strftime("%Y/%m/%d %H:%M")
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() else format(value, ".10g")
    return str(value)


def _width_to_px(width: float) -> int:
    """列の幅（既定のフォントの数字の文字数）を px に（Excel の既定 8.43 → 64px）。"""
    return round(width * 7 + 5)
