"""日本語 PDF ライターのテスト（フォントの埋め込みを中心に）。

閲覧側の環境に日本語フォントがあるかどうかで表示が崩れないよう、本文の
フォントは同梱フォントから「使った文字だけ」を切り出して埋め込む。ここでは
その埋め込みが実際に成立していること（字形が入っていること・使っていない
文字まで持ち込んでいないこと・文字コードが読めること）を確かめる。
"""

import io
import os

import pytest
from fontTools.ttLib import TTFont
from pdfminer.high_level import extract_text
from pypdf import PdfReader

from app import pdf_write

SAMPLE = "面材張り耐力要素 Ixy = 0.888868 mm²"


def build(text: str = SAMPLE, **metadata) -> bytes:
    document = pdf_write.Document()
    document.add_page().text(50, 700, text, 12)
    return document.to_bytes(metadata or None)


def descendant_font(pdf_bytes: bytes):
    page = PdfReader(io.BytesIO(pdf_bytes)).pages[0]
    return page["/Resources"]["/Font"]["/F1"]["/DescendantFonts"][0]


# --- フォントの埋め込み ------------------------------------------------------


def test_font_is_embedded_in_the_pdf():
    """字形そのものを PDF が持つ（閲覧側のフォントに依存しない）。"""
    descriptor = descendant_font(build())["/FontDescriptor"]

    embedded = descriptor["/FontFile2"].get_data()
    assert embedded[:4] in (b"\x00\x01\x00\x00", b"true")  # TrueType
    assert str(descriptor["/FontName"]).endswith("+NotoSansJP")


def test_only_the_used_characters_are_embedded():
    """同梱フォントは 5MB 超あるが、埋め込むのは使った文字だけ。"""
    embedded = descendant_font(build())["/FontDescriptor"]["/FontFile2"].get_data()

    assert len(embedded) < os.path.getsize(pdf_write.FONT_PATH) / 20

    # 使った文字ぶん（+ .notdef）しかグリフを持たない。
    subset = TTFont(io.BytesIO(embedded))
    assert subset["maxp"].numGlyphs <= len(set(SAMPLE)) + 1


def test_subset_name_has_a_stable_prefix():
    """同じ文字集合なら同じ接頭辞になる（出力が再現できる）。"""
    first = str(descendant_font(build())["/BaseFont"])
    second = str(descendant_font(build())["/BaseFont"])

    assert first == second
    prefix, _, _ = first.lstrip("/").partition("+")
    assert len(prefix) == 6 and prefix.isupper()


def test_a_different_character_set_gets_a_different_subset():
    small = descendant_font(build("あ"))["/FontDescriptor"]["/FontFile2"].get_data()
    large = descendant_font(build(SAMPLE))["/FontDescriptor"]["/FontFile2"].get_data()

    assert len(small) < len(large)


# --- 文字コード（検索・コピー・抽出） ---------------------------------------


def test_text_can_be_extracted():
    """グリフ番号で書いても、ToUnicode があるので文字として読める。"""
    assert SAMPLE in extract_text(io.BytesIO(build()))


def test_text_of_every_page_is_extracted():
    document = pdf_write.Document()
    document.add_page().text(50, 700, "1 ページ目", 12)
    document.add_page().text(50, 700, "2 ページ目", 12)

    text = extract_text(io.BytesIO(document.to_bytes()))

    assert "1 ページ目" in text
    assert "2 ページ目" in text


# --- 組版 --------------------------------------------------------------------


def test_widths_come_from_the_font():
    """字幅はフォントの実測値。全角は半角より広い。"""
    font = pdf_write.default_font()

    assert font.advance("あ") > font.advance("a")
    assert font.text_width("ああ", 10) == pytest.approx(font.text_width("あ", 10) * 2)


def test_alignment_shifts_the_origin_by_the_measured_width():
    document = pdf_write.Document()
    page = document.add_page()

    width = page.text(300, 700, "右寄せ", 10, align="right")

    assert width == pytest.approx(document.font.text_width("右寄せ", 10))


def test_declared_widths_match_the_embedded_font():
    """/W に書く字幅と、埋め込んだ字形の送り幅が食い違わないこと。"""
    font = pdf_write.default_font()
    subset = font.subset(set("面材 Ixy"))
    embedded = TTFont(io.BytesIO(subset.data))
    order = embedded.getGlyphOrder()

    for char, gid in subset.gids.items():
        assert subset.widths[gid] == embedded["hmtx"][order[gid]][0]
        assert subset.widths[gid] == pytest.approx(font.advance(char) * 1000, abs=1)


# --- 文書情報 ----------------------------------------------------------------


def test_metadata_values():
    document = pdf_write.Document()
    document.add_page().text(50, 700, "本文", 10)
    pdf_bytes = document.to_bytes({"Title": "計算書", "Custom": '{"a": "(x)"}'})

    info = PdfReader(io.BytesIO(pdf_bytes)).metadata
    # 日本語は UTF-16BE、ASCII は括弧のエスケープつきリテラルで書く。
    assert info.get("/Title") == "計算書"
    assert info.get("/Custom") == '{"a": "(x)"}'
