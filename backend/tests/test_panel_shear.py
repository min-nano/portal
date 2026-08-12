"""計算書 PDF の生成と読み戻し、保存時の突き合わせのテスト。

PDF はバックエンドが直接組み立てるため、雛形を用意せずにここで完結する。
「作った PDF から入力を復元できる」ことが保存形式としての要（スプレッド
シートの代わり）なので、往復を通して確かめる。

計算そのもの・入力の解釈・表示の桁揃えは唯一の実装（core/、wasm）が持つので、
式ごとの検証は core/src/*.rs の `cargo test` にある。ここでは「その結果が
そのまま PDF に載ること」を確かめる。

入力の単位は壁 1 枚で、釘配列諸定数はその壁を構成する面材ごとの計算として
中に入る（面材の種類が先に決まり、面材の配置・釘の間隔・へりあきで調整する
という設計の順番に合わせてある）。
"""

import io
import json

import pytest
from pdfminer.high_level import extract_text

from app import nail_core, panel_shear

EXAMPLE_PANEL = dict(panel_shear.EXAMPLE_PANEL, panelId="w1-p1")


def make_data(**overrides):
    """グレー本 3.2 の計算例の面材を 1 枚だけ張った壁。"""
    body = {
        "projectName": "○○邸 新築工事",
        "issuedOn": "2026-08-11",
        "walls": [
            {
                **panel_shear.material(panel_shear.EXAMPLE_WALL_MATERIAL),
                **panel_shear.EXAMPLE_WALL,
                "wallId": "w1",
                "panels": [dict(EXAMPLE_PANEL)],
            }
        ],
    }
    body.update(overrides)
    return panel_shear.normalize_data(body)


# --- 入力の正規化 ------------------------------------------------------------


def test_normalize_keeps_only_known_keys():
    data = panel_shear.normalize_data(
        {
            "projectName": " 邸 ",
            "unknown": 1,
            "walls": [{"height": "2900", "junk": 2, "panels": [{"width": "610"}]}],
        }
    )

    assert data["projectName"] == "邸"
    assert "unknown" not in data
    assert data["walls"][0]["height"] == 2900.0
    assert "junk" not in data["walls"][0]
    assert data["walls"][0]["panels"][0]["width"] == 610.0


def test_normalize_gives_an_empty_form_one_wall():
    """壁が 1 枚も無い入力でも、画面が編集を始められる形にする。"""
    data = panel_shear.normalize_data({})

    assert len(data["walls"]) == 1
    assert data["walls"][0]["wallId"] == "w1"
    assert data["walls"][0]["panels"] == []


def test_normalize_defaults_a_panel_to_a_four_sided_layout():
    """面材の既定は割り付け・日型（四周打ち）・へりあき 10 mm。"""
    data = panel_shear.normalize_data({"walls": [{"panels": [{"width": 910}]}]})

    panel = data["walls"][0]["panels"][0]
    assert panel["mode"] == "layout"
    assert panel["arrangement"] == "hi"
    assert panel["edgeDistance"] == nail_core.config()["defaultEdgeDistance"]


def test_normalize_keeps_the_edge_distance_of_each_panel():
    """へりあきは面材ごとに決める（釘・面材の種類に合わせて調整するため）。"""
    data = panel_shear.normalize_data(
        {"walls": [{"panels": [{"edgeDistance": 15}, {"edgeDistance": 20}]}]}
    )

    assert [panel["edgeDistance"] for panel in data["walls"][0]["panels"]] == [15, 20]


def test_normalize_rejects_a_non_numeric_dimension():
    with pytest.raises(panel_shear.PanelShearError, match="面材の幅 W"):
        panel_shear.normalize_data({"walls": [{"panels": [{"width": "ろく"}]}]})


def test_normalize_rejects_too_many_walls():
    limit = nail_core.config()["maxWalls"]
    walls = [{"wallId": f"w{i}"} for i in range(limit + 1)]
    with pytest.raises(panel_shear.PanelShearError, match="壁は"):
        panel_shear.normalize_data({"walls": walls})


def test_normalize_reads_the_old_pattern_form():
    """前の版で保存した PDF（釘配列パターンを別に登録した形）も開ける。"""
    data = panel_shear.normalize_data(
        {
            "patterns": [
                {
                    "patternId": "p1",
                    "patternName": "南面 下",
                    "width": 910,
                    "height": 610,
                    "mode": "grid",
                    "gridX": "10, 455, 900",
                    "gridY": "10, 155, 305, 455, 600",
                }
            ],
            "walls": [
                {"wallName": "南面", "height": 2900, "panels": [{"patternId": "p1"}]}
            ],
        }
    )

    assert "patterns" not in data
    panel = data["walls"][0]["panels"][0]
    assert panel["panelName"] == "南面 下"
    assert panel["mode"] == "grid"
    assert panel["gridX"] == "10, 455, 900"


# --- 計算（画面と PDF が共有する表示用データ） ------------------------------


def test_compute_all_matches_the_reference_example():
    """釘配列諸定数（3.2）は、壁の結果の中に面材 1 枚ずつ入る。"""
    wall = panel_shear.compute_all(make_data())["walls"][0]
    report = wall["panelReports"][0]

    assert report["ok"] is True
    values = {row["key"]: row["value"] for row in report["summary"]}
    assert values == {"Ixy": "0.888868", "Zxy": "0.00358851", "Cxy": "1.26155"}
    assert len(report["nails"]) == 15
    assert report["panelArea"] == 555100

    steps = {row["label"]: row["value"] for row in report["steps"]}
    # 本は左下の釘を原点にしているので x0 = 445.0。ここはへりあき 10 mm を
    # 見込んで面材の左下を原点にするため、その分だけ動く。
    assert steps["X方向 中立軸 x0"] == "455.000 mm"
    assert steps["二次モーメント Iy"] == "1,980,250 mm²"
    assert steps["変形割合 αx"] == "0.750834"


def test_compute_all_keeps_the_layout_in_the_inputs():
    """割り付けの入力（型・ピッチ・へりあき）は、そのまま控えに残す。"""
    wall = panel_shear.compute_all(make_data())["walls"][0]
    inputs = {row["label"]: row["value"] for row in wall["panelReports"][0]["inputs"]}

    assert "川型" in inputs["釘配列"]
    assert "釘 @150" in inputs["釘配列"]
    assert "へりあき 10 mm" in inputs["釘配列"]


def test_a_wider_edge_distance_changes_the_constants():
    """へりあきを広げると釘が内側へ寄り、諸定数が下がる。"""
    narrow = panel_shear.compute_all(make_data())["walls"][0]
    data = make_data()
    data["walls"][0]["panels"][0]["edgeDistance"] = 30
    wide = panel_shear.compute_all(data)["walls"][0]

    assert (
        wide["panelReports"][0]["result"]["Ixy"]
        < narrow["panelReports"][0]["result"]["Ixy"]
    )
    assert wide["result"]["Pa"] < narrow["result"]["Pa"]


def test_compute_all_reports_a_broken_panel_without_losing_the_others():
    data = make_data()
    data["walls"][0]["panels"].append({"panelName": "空", "width": 910, "height": 610,
                                       "mode": "coords", "coords": ""})

    wall = panel_shear.compute_all(data)["walls"][0]

    assert wall["ok"] is False
    assert "面材「空」" in wall["error"]
    assert wall["panelReports"][0]["ok"] is True
    assert wall["panelReports"][1]["ok"] is False


def test_compute_all_calculates_the_walls_of_the_book_example():
    """グレー本 3.3(3) の計算例（図 3.3.10）。本の答えは Pa = 8.37 kN。

    式ごとの検証は core/src/wall.rs の `cargo test` にある。ここでは
    「その結果がそのまま画面と PDF へ渡ること」を確かめる。
    """
    report = panel_shear.compute_all(panel_shear.example_wall_data())["walls"][0]

    assert report["ok"] is True
    assert report["governing"] == "drift"
    assert report["withinLimit"] is True
    # 面材のせん断破壊・せん断座屈（式 3.3.8）も、どちらも余裕をもって通る。
    assert report["shearOk"] is True
    assert report["bucklingOk"] is True
    assert abs(report["result"]["Pa"] - 8.37) <= 0.03
    assert abs(report["result"]["dPa"] - 9.20) <= 0.03
    # 壁を構成する 2 枚の面材が、呼び出した配列の名前で並ぶ。
    assert [panel["label"] for panel in report["panels"]] == [
        "1820×910 縦置・日型（間柱・根太 @455 / 釘 @75）",
        "910×910 縦置・ロ型（間柱・根太 @455 / 釘 @75）",
    ]
    # その根拠になる釘配列諸定数も、同じ並びで付いてくる。
    assert [panel["panelName"] for panel in report["panelReports"]] == [
        panel["label"] for panel in report["panels"]
    ]


def test_compute_all_checks_the_shear_failure_and_buckling_of_each_panel():
    """式 3.3.8〜3.3.11。面材ごとに τN・τmax・τcr を出して判定する。"""
    report = panel_shear.compute_all(panel_shear.example_wall_data())["walls"][0]

    assert len(report["buckling"]) == 2
    assert report["bucklingColumns"][-1] == "判定"
    # 下側の面材 910 × 1820 は、繊維が長辺（高さ）方向なので a = 910、b = 1820。
    lower = report["buckling"][0]["cells"]
    assert (lower[0], lower[1], lower[2]) == ("高さ方向", "910", "1,820")
    assert lower[-1] == "OK"
    assert all(panel["ok"] for panel in report["buckling"])


def test_the_wall_inputs_name_the_nail_diameter():
    """へりあきを決める手がかりとして、選んだ釘の呼び径を控えに残す。"""
    report = panel_shear.compute_all(panel_shear.example_wall_data())["walls"][0]

    inputs = {row["label"]: row["value"] for row in report["inputs"]}
    assert inputs["面材と釘の組合せ"] == (
        "構造用合板 12mm + 鉄丸釘 N-65（釘の呼び径 φ3.05 mm）"
    )


def test_a_thin_panel_fails_the_shear_check():
    """面材を薄くすれば τN が上がり、せん断破壊で NG になる。"""
    data = panel_shear.example_wall_data()
    data["walls"][0]["thickness"] = 3

    report = panel_shear.compute_all(data)["walls"][0]

    assert report["shearOk"] is False
    assert report["buckling"][0]["cells"][-1] == "NG"
    failure = next(check for check in report["checks"] if "せん断破壊" in check["label"])
    assert failure["ok"] is False


def test_compute_all_reports_a_broken_wall_without_losing_the_others():
    data = panel_shear.example_wall_data()
    data["walls"].append({**panel_shear.EXAMPLE_WALL, "wallId": "w2", "panels": []})

    reports = panel_shear.compute_all(data)["walls"]

    assert reports[0]["ok"] is True
    assert reports[1]["ok"] is False
    assert "面材がありません" in reports[1]["error"]


def test_validate_names_the_wall_that_cannot_be_calculated():
    data = panel_shear.example_wall_data()
    data["walls"][0]["wallName"] = "南面"
    data["walls"][0]["height"] = 0

    with pytest.raises(panel_shear.PanelShearError, match="「南面」を計算できません"):
        panel_shear.validate(data)


def test_validate_names_the_panel_that_cannot_be_calculated():
    data = panel_shear.example_wall_data()
    data["walls"][0]["wallName"] = "南面"
    data["walls"][0]["panels"][0]["panelName"] = "下段"
    data["walls"][0]["panels"][0]["nailPitch"] = 0

    with pytest.raises(panel_shear.PanelShearError, match="面材「下段」"):
        panel_shear.validate(data)


# --- 保存時の突き合わせ ------------------------------------------------------


def claim_from(reports: dict, **overrides) -> dict:
    """画面が送ってくる「私はこう計算した」を、正しい値で組み立てる。"""
    claim = {
        "coreVersion": nail_core.version(),
        # サーバ側の結果とは別の辞書にする（画面から届いた値のつもり）。
        "walls": [
            {"wallId": report["wallId"], "result": dict(report["result"])}
            for report in reports["walls"]
        ],
        "panels": [
            {"panelId": report["panelId"], "result": dict(report["result"])}
            for report in panel_shear.panel_reports(reports)
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


def test_verify_points_at_the_panel_value_that_differs():
    reports = panel_shear.validate(make_data())
    claim = claim_from(reports)
    claim["panels"][0]["result"]["Cxy"] = 9.99

    result = panel_shear.verify(reports, claim)

    assert result["ok"] is False
    assert [(d["key"], d["client"]) for d in result["differences"]] == [("Cxy", 9.99)]
    assert result["differences"][0]["panelName"] == "グレー本の計算例"


def test_verify_tolerates_the_last_bit():
    """JSON を往復した程度の差は「同じ」とみなす（端末差を騒ぎ立てない）。"""
    reports = panel_shear.validate(make_data())
    claim = claim_from(reports)
    claim["panels"][0]["result"]["Cxy"] *= 1 + 1e-12

    assert panel_shear.verify(reports, claim)["ok"] is True


def test_verify_flags_a_screen_running_an_older_implementation():
    """開きっぱなしのタブが古い計算実装のまま保存した場合。"""
    reports = panel_shear.validate(make_data())

    result = panel_shear.verify(reports, claim_from(reports, coreVersion="0.9.0"))

    assert result["ok"] is False
    assert result["coreVersion"] == {"client": "0.9.0", "server": nail_core.version()}
    # 数値そのものは合っているので、差の一覧は空（版だけが食い違っている）。
    assert result["differences"] == []


def test_verify_flags_a_panel_the_screen_did_not_calculate():
    reports = panel_shear.validate(make_data())

    result = panel_shear.verify(reports, claim_from(reports, panels=[]))

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


def test_verify_points_at_a_wall_value_that_differs():
    data = panel_shear.example_wall_data()
    reports = panel_shear.validate(data)
    claim = claim_from(reports)
    claim["walls"][0]["result"]["Pa"] = 9.99

    result = panel_shear.verify(reports, claim)

    assert result["ok"] is False
    assert [(d["key"], d["client"]) for d in result["differences"]] == [("Pa", 9.99)]
    assert result["differences"][0]["wallName"] == "グレー本 3.3 の計算例"


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


def test_pdf_has_one_page_per_panel_and_one_per_wall():
    data = make_data()
    data["walls"][0]["panels"].append(
        dict(EXAMPLE_PANEL, panelId="w1-p2", panelName="南面 上")
    )
    pdf_bytes = panel_shear.build_pdf(data, panel_shear.validate(data))

    # ページ区切り（改ページ）で数える。面材 2 枚 ＋ 壁 1 枚。
    assert extract_text(io.BytesIO(pdf_bytes)).count("\x0c") == 3


def test_pdf_prints_the_inputs_and_the_results():
    _, pdf_bytes = build_example_pdf()

    text = extract_text(io.BytesIO(pdf_bytes))

    assert "面材張り耐力要素 釘配列諸定数 計算書" in text
    assert "○○邸 新築工事" in text
    assert "作成日: 2026年8月11日" in text
    # 入力（面材寸法・面積）と、画面に出るのと同じ桁の結果。
    assert "910 × 610 mm" in text
    assert "555,100 mm²" in text
    assert "0.888868" in text
    assert "0.00358851" in text
    assert "1.26155" in text
    # 途中経過は式番号つきで白箱化する。
    assert "(3.2.7)" in text
    assert "0.750834" in text


def test_pdf_puts_the_nail_arrangement_pages_before_their_wall():
    """壁の計算は、その根拠になる面材ごとの釘配列諸定数の後ろに続ける。"""
    data = panel_shear.example_wall_data()
    pdf_bytes = panel_shear.build_pdf(data, panel_shear.validate(data))

    pages = extract_text(io.BytesIO(pdf_bytes)).split("\x0c")[:-1]

    assert len(pages) == 3  # 面材 2 枚 ＋ 壁 1 枚
    assert all(panel_shear._TITLE in page for page in pages[:2])
    assert panel_shear._WALL_TITLE in pages[2]
    # どの壁のどの面材かが、面材のページからも読める。
    assert "面材 1 / 2" in pages[0]
    assert "壁 1 / 1" in pages[0]
    # 通しのページ番号は、両方の節を続けて数える。
    assert "3 / 3" in pages[2]


def test_pdf_prints_the_wall_calculation():
    data = panel_shear.example_wall_data()
    reports = panel_shear.validate(data)
    pdf_bytes = panel_shear.build_pdf(data, reports)

    text = extract_text(io.BytesIO(pdf_bytes)).split("\x0c")[2]
    wall = reports["walls"][0]

    assert "グレー本 3.3 の計算例" in text
    # 入力（階高・壁幅・釘 1 本あたりの数値）。
    assert "3,000 mm" in text
    assert "910 mm" in text
    assert "ΔPv = 1.13000 kN" in text
    # 画面に出るのと同じ桁の結果と、式番号つきの途中経過。
    for item in wall["summary"]:
        assert item["value"] in text
    assert "(3.3.1)" in text
    assert "(3.3.7)" in text
    # 面材ごとの表（面材の名前と、その面材の Ixy）。
    assert "1820×910 縦置・日型（間柱・根太 @455 / 釘 @75）" in text
    assert wall["panels"][0]["cells"][1] in text
    # 面材のせん断破壊・せん断座屈の検定（式 3.3.8〜3.3.11）。
    assert "τcr [N/mm²]" in text
    assert wall["buckling"][0]["cells"][-2] in text  # τcr
    # 判定（適用範囲 3.3(1)① の上限と、せん断破壊・せん断座屈）。
    assert "13.7200" in text
    assert text.count("OK") >= 3


def test_pdf_marks_a_wall_over_the_upper_limit_as_ng():
    data = panel_shear.example_wall_data()
    data["walls"][0]["width"] = 300
    reports = panel_shear.validate(data)

    text = extract_text(io.BytesIO(panel_shear.build_pdf(data, reports))).split("\x0c")[2]

    assert reports["walls"][0]["withinLimit"] is False
    assert "NG" in text


def test_pdf_round_trips_a_form_with_walls():
    """壁を含む入力も、保存した PDF から完全に復元できる。"""
    data = panel_shear.example_wall_data()
    pdf_bytes = panel_shear.build_pdf(data, panel_shear.validate(data))

    parsed = panel_shear.parse_pdf(pdf_bytes)

    assert parsed == data
    # 面材は壁の一部として保存される（別に登録した配列を指す形ではない）。
    panel = parsed["walls"][0]["panels"][0]
    assert panel["mode"] == "layout"
    assert panel["arrangement"] == "hi"
    assert panel["edgeDistance"] == 10


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
    data = make_data()
    data["walls"][0]["panels"] = [
        {
            "panelId": "w1-p9",
            "panelName": "座標入力",
            "width": 910,
            "height": 2730,
            "mode": "coords",
            "coords": "0, 0\n0, 455\n455, 910",
        }
    ]
    data = panel_shear.normalize_data(data)
    pdf_bytes = panel_shear.build_pdf(data, panel_shear.validate(data))

    parsed = panel_shear.parse_pdf(pdf_bytes)

    assert parsed["walls"][0]["panels"][0]["mode"] == "coords"
    assert parsed["walls"][0]["panels"][0]["coords"] == "0, 0\n0, 455\n455, 910"


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
