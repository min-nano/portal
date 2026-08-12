"""計算書 PDF の生成と読み戻し、保存時の突き合わせのテスト。

PDF はバックエンドが直接組み立てるため、雛形を用意せずにここで完結する。
「作った PDF から入力を復元できる」ことが保存形式としての要（スプレッド
シートの代わり）なので、往復を通して確かめる。

計算そのもの・入力の解釈・表示の桁揃えは唯一の実装（core/、wasm）が持つので、
式ごとの検証は core/src/*.rs の `cargo test` にある。ここでは「その結果が
そのまま PDF に載ること」を確かめる。
"""

import io
import json

import pytest
from pdfminer.high_level import extract_text

from app import nail_core, panel_shear

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
    limit = nail_core.config()["maxPatterns"]
    patterns = [{"patternId": f"p{i}"} for i in range(limit + 1)]
    with pytest.raises(panel_shear.PanelShearError, match="パターンは"):
        panel_shear.normalize_data({"patterns": patterns})


# --- 計算（画面と PDF が共有する表示用データ） ------------------------------


def test_compute_all_matches_the_reference_example():
    report = panel_shear.compute_all(make_data())[0]

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


# --- 保存時の突き合わせ ------------------------------------------------------


def claim_from(reports: list[dict], **overrides) -> dict:
    """画面が送ってくる「私はこう計算した」を、正しい値で組み立てる。"""
    claim = {
        "coreVersion": nail_core.version(),
        "patterns": [
            # サーバ側の結果とは別の辞書にする（画面から届いた値のつもり）。
            {"patternId": report["patternId"], "result": dict(report["result"])}
            for report in reports
        ],
    }
    claim.update(overrides)
    return claim


def test_verify_accepts_the_same_numbers():
    reports = panel_shear.validate(make_data())

    result = panel_shear.verify(reports, claim_from(reports))

    assert result == {
        "checked": True,
        "ok": True,
        "coreVersion": {"client": nail_core.version(), "server": nail_core.version()},
        "differences": [],
        "omittedDifferences": 0,
    }


def test_verify_points_at_the_value_that_differs():
    reports = panel_shear.validate(make_data())
    claim = claim_from(reports)
    claim["patterns"][0]["result"]["Cxy"] = 9.99

    result = panel_shear.verify(reports, claim)

    assert result["ok"] is False
    assert [(d["key"], d["client"]) for d in result["differences"]] == [("Cxy", 9.99)]
    assert result["differences"][0]["patternName"] == "グレー本の計算例"


def test_verify_tolerates_the_last_bit():
    """JSON を往復した程度の差は「同じ」とみなす（端末差を騒ぎ立てない）。"""
    reports = panel_shear.validate(make_data())
    claim = claim_from(reports)
    claim["patterns"][0]["result"]["Cxy"] *= 1 + 1e-12

    assert panel_shear.verify(reports, claim)["ok"] is True


def test_verify_flags_a_screen_running_an_older_implementation():
    """開きっぱなしのタブが古い計算実装のまま保存した場合。"""
    reports = panel_shear.validate(make_data())

    result = panel_shear.verify(reports, claim_from(reports, coreVersion="0.9.0"))

    assert result["ok"] is False
    assert result["coreVersion"] == {"client": "0.9.0", "server": nail_core.version()}
    # 数値そのものは合っているので、差の一覧は空（版だけが食い違っている）。
    assert result["differences"] == []


def test_verify_flags_a_pattern_the_screen_did_not_calculate():
    reports = panel_shear.validate(make_data())

    result = panel_shear.verify(reports, claim_from(reports, patterns=[]))

    assert result["ok"] is False
    assert result["differences"][0]["key"] == "(計算結果なし)"


def test_verify_is_skipped_when_the_screen_sends_nothing():
    """突き合わせの材料が無ければ、警告は出さない（保存も止めない）。"""
    reports = panel_shear.validate(make_data())

    assert panel_shear.verify(reports, None) == {
        "checked": False,
        "ok": True,
        "differences": [],
    }


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


def test_pdf_embeds_the_font_it_uses():
    """閲覧側に日本語フォントが無くても崩れないよう、字形を PDF が持つ。"""
    from pypdf import PdfReader

    _, pdf_bytes = build_example_pdf()

    page = PdfReader(io.BytesIO(pdf_bytes)).pages[0]
    descriptor = page["/Resources"]["/Font"]["/F1"]["/DescendantFonts"][0][
        "/FontDescriptor"
    ]
    assert "/FontFile2" in descriptor
    # 埋め込むのは使った文字だけなので、計算書 1 通は数十 KB に収まる。
    assert len(pdf_bytes) < 300 * 1024


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
