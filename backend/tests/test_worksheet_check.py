"""表計算ツールの更新を定期確認するスクリプトの検証。

スクリプト本体は .github/scripts/check_howtec_worksheet.py にあるが、
テストを走らせる場所がここしか無いのでここに置く（配布ページの読み取りは
「ページの作りが変わったら気付ける」ことが値打ちなので、判断の分かれ目
——リンクを絞る規則——だけは押さえておきたい）。

ネットワークは使わない。ページの HTML を文字列として渡し、リンクの
選び方だけを見る。
"""

import importlib.util
import os

import pytest

_SCRIPT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    ".github",
    "scripts",
    "check_howtec_worksheet.py",
)

PAGE = "https://www.howtec.or.jp/publics/index/441/"


@pytest.fixture(scope="module")
def check():
    spec = importlib.util.spec_from_file_location("check_howtec_worksheet", _SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def links(check, html):
    return check.find_links(html, PAGE)


def test_relative_links_become_absolute(check):
    found = links(check, '<a href="/files/tool.xlsx">表計算ツール</a>')
    assert found == [
        {"url": "https://www.howtec.or.jp/files/tool.xlsx", "text": "表計算ツール"}
    ]


def test_non_spreadsheet_links_are_ignored(check):
    html = '<a href="/a.pdf">解説</a><a href="/b.xlsx">表</a><a href="/c.zip">一式</a>'
    assert [link["url"] for link in links(check, html)] == [
        "https://www.howtec.or.jp/b.xlsx"
    ]


def test_query_strings_do_not_hide_the_extension(check):
    found = links(check, '<a href="/dl.xlsx?id=3">表計算ツール</a>')
    assert found and found[0]["url"].endswith("/dl.xlsx?id=3")


def test_the_same_link_is_not_listed_twice(check):
    html = '<a href="/t.xlsx">1</a><a href="/t.xlsx">2</a>'
    assert len(links(check, html)) == 1


def test_markup_inside_the_link_text_is_stripped(check):
    found = links(check, '<a href="/t.xlsx"><span>表計算</span> ツール</a>')
    assert found[0]["text"] == "表計算 ツール"


def test_a_single_link_is_chosen_without_hesitation(check):
    found = links(check, '<a href="/whatever.xlsx">名前で分からない</a>')
    chosen, problem = check.choose(found, "")
    assert problem == ""
    assert chosen["url"].endswith("/whatever.xlsx")


def test_the_recorded_url_wins_when_it_is_still_on_the_page(check):
    html = '<a href="/old.xlsx">表計算ツール（多機能版）</a><a href="/new.xlsx">別物</a>'
    chosen, problem = check.choose(links(check, html), "https://www.howtec.or.jp/new.xlsx")
    assert problem == ""
    assert chosen["url"].endswith("/new.xlsx")


def test_keywords_pick_the_worksheet_out_of_several_files(check):
    html = (
        '<a href="/a.xlsx">スパン表</a>'
        '<a href="/b.xlsx">壁量等の基準に対応した表計算ツール（多機能版）</a>'
        '<a href="/c.xlsx">参考資料</a>'
    )
    chosen, problem = check.choose(links(check, html), "")
    assert problem == ""
    assert chosen["url"].endswith("/b.xlsx")


def test_an_ambiguous_page_is_reported_with_every_candidate(check):
    html = (
        '<a href="/a.xlsx">表計算ツール（平屋建て）</a>'
        '<a href="/b.xlsx">表計算ツール（2階建て）</a>'
    )
    chosen, problem = check.choose(links(check, html), "")
    assert chosen is None
    assert "/a.xlsx" in problem and "/b.xlsx" in problem


def test_a_page_without_any_spreadsheet_is_reported(check):
    chosen, problem = check.choose(links(check, "<a href='/x.pdf'>解説</a>"), "")
    assert chosen is None
    assert "見つかりませんでした" in problem


def test_a_downloaded_file_must_look_like_a_workbook(check):
    from app import wall_quantity

    assert check.looks_like_xlsx(wall_quantity.template_bytes())
    assert not check.looks_like_xlsx(b"%PDF-1.7\n")
    assert not check.looks_like_xlsx(b"")


def test_the_version_is_read_from_the_downloaded_file(check):
    from app import wall_quantity

    assert check.read_version(wall_quantity.template_bytes()) == (
        wall_quantity.template_version()
    )


def test_an_unreadable_file_does_not_stop_the_check(check):
    # 版が読めないことは差し替えを止める理由にならない（番人テストが PR で
    # 中身のずれを教える）。空文字を返して先へ進む。
    assert check.read_version(b"not a workbook") == ""


def test_the_page_is_decoded_even_when_it_is_not_utf8(check):
    assert "表計算" in check.decode_html("表計算ツール".encode("cp932"))
    assert "表計算" in check.decode_html("表計算ツール".encode("utf-8"))
