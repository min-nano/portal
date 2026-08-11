"""PDF ユーティリティ（文字座標の抽出・○ の描き込み）のテスト。"""

import pytest

from app import pdf_tools
from app.pdf_tools import Box
from tests.pdf_util import CHAR_WIDTH, make_pdf


# --- 正規化 -----------------------------------------------------------------

@pytest.mark.parametrize(
    "raw, expected",
    [
        # Google ドキュメントの PDF 書き出しは一部の漢字を康熙部首で埋め込む。
        ("⽉", "月"),
        ("⾯", "面"),
        ("１", "1"),
        ("（", "("),
        ("A", "A"),
        # 1 文字に収まらない分解は行わない（座標との対応が崩れるため）。
        ("㎡", "㎡"),
    ],
)
def test_normalize_char_is_length_preserving(raw, expected):
    assert pdf_tools.normalize_char(raw) == expected


def test_normalize_text_drops_whitespace():
    assert pdf_tools.normalize_text(" １ 建 築　基準法 ") == "1建築基準法"


# --- 文字座標の抽出 ---------------------------------------------------------

def test_read_layout_returns_text_and_char_boxes():
    pdf = make_pdf([("建築物の区分", 100.0, 700.0), ("１最高の高さ", 250.0, 680.0)])

    pages = pdf_tools.read_layout(pdf)

    assert len(pages) == 1
    page = pages[0]
    assert page.box.x1 == pytest.approx(595.0)
    texts = sorted(line.text for line in page.lines)
    # 全角数字は正規化され、マッピングに書いた文字列と比較できる形になる。
    assert texts == ["1最高の高さ", "建築物の区分"]

    line = page.line_equal("建築物の区分")
    assert len(line.char_boxes) == len("建築物の区分")
    assert line.box.x0 == pytest.approx(100.0, abs=0.1)
    assert line.box_for(0, 1).width == pytest.approx(CHAR_WIDTH, abs=0.1)
    # 3 文字ぶんの外接矩形は 1 文字の 3 倍の幅になる。
    assert line.box_for(0, 3).width == pytest.approx(CHAR_WIDTH * 3, abs=0.1)


def test_find_returns_every_occurrence():
    pdf = make_pdf([("認定□有□無", 100.0, 700.0), ("認定番号", 100.0, 680.0)])

    page = pdf_tools.read_layout(pdf)[0]

    assert len(page.find("認定")) == 2
    assert len(page.find("□有")) == 1
    assert page.find("存在しない") == []


def test_lines_in_container_is_ordered_top_down():
    # 同じセル内で折り返した 2 行（行間が狭いと 1 つの container にまとまる）。
    pdf = make_pdf([("上の行", 250.0, 700.0), ("下の行", 250.0, 692.0)])

    page = pdf_tools.read_layout(pdf)[0]
    container = page.line_equal("上の行").container

    assert [ln.text for ln in page.lines_in_container(container)] == ["上の行", "下の行"]


# --- 印（○ / レ点）の描き込み ------------------------------------------------

def test_square_around_makes_a_circle_not_an_ellipse():
    # 文字の外接矩形は縦横比が 1 ではない（ここでは横長）。
    box = Box(10.0, 100.0, 25.0, 110.0)

    square = pdf_tools.square_around(box, padding=2.0)

    # 長い辺に合わせた正方形になるので、内接させれば正円になる。
    assert square.width == pytest.approx(square.height)
    assert square.width == pytest.approx(15.0 + 2 * 2.0)
    # 中心は動かさない（文字の真ん中を囲む）。
    assert (square.x0 + square.x1) / 2 == pytest.approx((box.x0 + box.x1) / 2)
    assert (square.y0 + square.y1) / 2 == pytest.approx((box.y0 + box.y1) / 2)


def test_stamp_marks_draws_a_circle_at_the_requested_place():
    pdf = make_pdf([("１法第20条", 250.0, 700.0)])
    page = pdf_tools.read_layout(pdf)[0]
    target = pdf_tools.square_around(page.line_equal("1法第20条").box_for(0, 1), 1.4)

    stamped = pdf_tools.stamp_marks(pdf, {0: [(pdf_tools.CIRCLE, target)]})

    after = pdf_tools.read_layout(stamped)[0]
    assert len(after.curves) == 1
    curve = after.curves[0]
    assert curve.x0 == pytest.approx(target.x0, abs=0.5)
    assert curve.y1 == pytest.approx(target.y1, abs=0.5)
    # 正方形に内接させているので、描かれた円も縦横が等しい。
    assert curve.width == pytest.approx(curve.height, abs=0.5)
    # 元のテキストは失われない。
    assert after.line_equal("1法第20条") is not None


def test_stamp_marks_draws_a_check_inside_the_box():
    pdf = make_pdf([("□有", 250.0, 700.0)])
    page = pdf_tools.read_layout(pdf)[0]
    target = page.line_equal("□有").box_for(0, 1)

    stamped = pdf_tools.stamp_marks(pdf, {0: [(pdf_tools.CHECK, target)]})

    after = pdf_tools.read_layout(stamped)[0]
    assert len(after.curves) == 1
    check = after.curves[0]
    # レ点は □ の中に収まる（隣の「有」にはみ出さない）。
    assert target.contains(check, tolerance=0.5)
    # 小さすぎて見えない、ということがない程度の大きさはある。
    assert check.width > target.width * 0.5
    assert check.height > target.height * 0.5
    # 右上へ跳ね上げる形なので、右端のほうが上まで届く。
    assert check.y1 > (target.y0 + target.y1) / 2


def test_stamp_marks_without_targets_keeps_the_page_unchanged():
    pdf = make_pdf([("１法第20条", 250.0, 700.0)])

    stamped = pdf_tools.stamp_marks(pdf, {})

    after = pdf_tools.read_layout(stamped)[0]
    assert after.curves == []
    assert after.line_equal("1法第20条") is not None


def test_metadata_round_trip():
    pdf = make_pdf([("本文", 100.0, 700.0)])

    stamped = pdf_tools.stamp_marks(pdf, {}, metadata={"/Portal": '{"a": 1}'})

    assert pdf_tools.read_metadata_value(stamped, "/Portal") == '{"a": 1}'
    assert pdf_tools.read_metadata_value(stamped, "/Missing") is None


def test_read_metadata_value_on_broken_pdf_returns_none():
    assert pdf_tools.read_metadata_value(b"not a pdf", "/Portal") is None


# --- 矩形の補助 -------------------------------------------------------------

def test_box_helpers():
    inner = Box(10.0, 10.0, 20.0, 20.0)
    outer = Box(5.0, 5.0, 25.0, 25.0)

    assert outer.contains(inner)
    assert not inner.contains(outer)
    assert inner.contains(Box(9.5, 9.5, 20.5, 20.5), tolerance=1.0)
    assert inner.union(outer) == outer
    assert inner.vertical_overlap(Box(0.0, 15.0, 1.0, 30.0)) == pytest.approx(5.0)
    assert inner.vertical_overlap(Box(0.0, 30.0, 1.0, 40.0)) == 0.0
