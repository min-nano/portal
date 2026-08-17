"""生成物のファイル名の規則（portal_sdk）のテスト。

このモジュールの本題は、規則が **画面側と 1 文字も違わない** ことを縛ることに
ある。計算（wasm）と違い、ファイル名の整形はサーバと画面に 1 つずつ実装がある
ため、同じ入力に同じ答えを返すことを file_name_cases.json で突き合わせる
（同じ表を frontend/tests/file-name-rule.test.js も読む）。
"""

import json
import os

import pytest

from app import panel_shear, portal_sdk, structural_cert

CASES_PATH = os.path.join(os.path.dirname(__file__), "file_name_cases.json")

with open(CASES_PATH, encoding="utf-8") as f:
    SHARED = json.load(f)


# --- 画面との突き合わせ -----------------------------------------------------

@pytest.mark.parametrize("case", SHARED["cases"], ids=lambda c: repr(c["given"]))
def test_matches_the_rule_shared_with_the_screen(case):
    assert portal_sdk.sanitize_file_name(case["given"]) == case["sanitized"]
    assert (
        portal_sdk.ensure_file_name(case["given"], SHARED["default"])
        == case["withExtension"]
    )


@pytest.mark.parametrize("case", SHARED["templates"], ids=lambda c: c["template"])
def test_builds_the_same_name_as_the_screen(case):
    assert (
        portal_sdk.build_file_name(case["template"], case["values"], SHARED["default"])
        == case["expected"]
    )


# --- 拡張子 ------------------------------------------------------------------

def test_extension_is_not_doubled_regardless_of_case():
    assert portal_sdk.ensure_file_name("計算書.PDF", "既定.pdf") == "計算書.PDF"


def test_any_extension_can_be_required():
    assert (
        portal_sdk.ensure_file_name("必要壁量", "既定.xlsx", ".xlsx") == "必要壁量.xlsx"
    )


# --- 雛形からの組み立て -----------------------------------------------------

def test_build_fills_the_template():
    assert (
        portal_sdk.build_file_name("報告書_{name}.pdf", {"name": "サンプル邸"}, "既定.pdf")
        == "報告書_サンプル邸.pdf"
    )


def test_build_drops_the_separator_left_by_an_empty_value():
    # 差し込む値が無いときに「報告書_.pdf」を作らない。
    assert (
        portal_sdk.build_file_name("報告書_{name}.pdf", {"name": ""}, "既定.pdf")
        == "報告書.pdf"
    )


def test_build_falls_back_when_the_template_asks_for_an_unknown_value():
    assert (
        portal_sdk.build_file_name("報告書_{unknown}.pdf", {"name": "邸"}, "既定.pdf")
        == "既定.pdf"
    )


def test_build_drops_characters_that_cannot_be_used():
    assert (
        portal_sdk.build_file_name("報告書_{name}.pdf", {"name": "A/B:C"}, "既定.pdf")
        == "報告書_ABC.pdf"
    )


# --- ツールが同じ規則に乗っていること ---------------------------------------
#
# 3 つのツールがそれぞれ持っていた整形を土台へ寄せた（docs/shared-logic.md
# §2.2）。同じ入力には、ツールが違っても同じ答えが出る。

def test_the_tools_share_one_rule():
    given = "  ..計算/書..  "

    assert structural_cert.ensure_pdf_extension(given) == "計算書.pdf"
    assert panel_shear.ensure_pdf_extension(given) == "計算書.pdf"


def test_the_default_name_is_used_when_nothing_is_left():
    assert structural_cert.ensure_pdf_extension("///") == structural_cert.DEFAULT_FILE_NAME
    assert panel_shear.ensure_pdf_extension("///") == panel_shear.DEFAULT_FILE_NAME

# 必要壁量ツール（xlsx を返す）が同じ規則に乗っていることは、
# test_wall_quantity.py のファイル名のテストが確かめる。
