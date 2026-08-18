"""計算書 PDF の生成と読み戻し、保存時の突き合わせのテスト。

PDF はバックエンドが直接組み立てるため、雛形を用意せずにここで完結する。
「作った PDF から入力を復元できる」ことが保存形式としての要（スプレッド
シートの代わり）なので、往復を通して確かめる。

計算そのもの・入力の解釈・表示の桁揃えは唯一の実装（core/、wasm）が持つので、
式ごとの検証は core/src/*.rs の `cargo test` にある。ここでは「その結果が
そのまま PDF に載ること」を確かめる。

入力の単位は壁 1 枚で、釘配列諸定数はその壁を構成する面材ごとの計算として
中に入る。面材は「壁の中で占める領域」として入力し、面材の寸法も釘配列も
その領域と壁の軸組（間柱ピッチ）から決まる。
"""

import io
import json

import pytest
from pdfminer.high_level import extract_pages, extract_text
from pdfminer.layout import LTTextContainer

from app import nail_core, panel_shear

# 壁の左下に張った 910 × 610（間柱 @455・釘 @150）。面材は「壁の中で
# 占める領域」なので、寸法も釘配列もここと壁の間柱ピッチから決まる。
EXAMPLE_PANEL = {
    "panelId": "w1-p1",
    "panelName": "グレー本の計算例",
    "left": 0,
    "bottom": 0,
    "right": 910,
    "top": 610,
    "nailPitch": 150,
    "edgeDistance": 10,
}


# 面材と釘は面材ごとの入力（1 枚の壁でも張り分けられる）。
EXAMPLE_MATERIAL = panel_shear.material(panel_shear.EXAMPLE_WALL_MATERIAL)


def make_panel(**overrides):
    """グレー本 3.2 の計算例の面材 1 枚（面材と釘は 3.3 の計算例のもの）。"""
    return {**EXAMPLE_MATERIAL, **EXAMPLE_PANEL, **overrides}


def make_data(**overrides):
    """グレー本 3.2 の計算例の面材を 1 枚だけ張った壁。"""
    body = {
        "projectName": "○○邸 新築工事",
        "issuedOn": "2026-08-11",
        "walls": [
            {
                **panel_shear.EXAMPLE_WALL,
                "wallId": "w1",
                "panels": [make_panel()],
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
            "walls": [
                {"height": "2900", "junk": 2,
                 "panels": [{"right": "610", "top": "910"}]}
            ],
        }
    )

    assert data["projectName"] == "邸"
    assert "unknown" not in data
    assert data["walls"][0]["height"] == 2900.0
    assert "junk" not in data["walls"][0]
    assert data["walls"][0]["panels"][0]["right"] == 610.0


def test_normalize_gives_an_empty_form_one_wall():
    """壁が 1 枚も無い入力でも、画面が編集を始められる形にする。"""
    data = panel_shear.normalize_data({})

    assert len(data["walls"]) == 1
    assert data["walls"][0]["wallId"] == "w1"
    assert data["walls"][0]["panels"] == []


def test_normalize_defaults_a_panel_to_the_front_side():
    """面材の既定は表面・へりあき 10 mm、壁の既定は間柱 @455。"""
    data = panel_shear.normalize_data(
        {"walls": [{"panels": [{"right": 910, "top": 1820}]}]}
    )

    panel = data["walls"][0]["panels"][0]
    assert panel["side"] == "front"
    assert panel["edgeDistance"] == nail_core.config()["defaultEdgeDistance"]


def test_normalize_keeps_the_edge_distance_of_each_panel():
    """へりあきは面材ごとに決める（釘・面材の種類に合わせて調整するため）。"""
    data = panel_shear.normalize_data(
        {"walls": [{"panels": [{"edgeDistance": 15}, {"edgeDistance": 20}]}]}
    )

    assert [panel["edgeDistance"] for panel in data["walls"][0]["panels"]] == [15, 20]


def test_normalize_rejects_a_non_numeric_dimension():
    with pytest.raises(panel_shear.PanelShearError, match="面材の右端 X"):
        panel_shear.normalize_data({"walls": [{"panels": [{"right": "ろく"}]}]})


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
    # 面材ごとの寸法は、壁の中で占める領域へ移し替える（位置が無いので
    # 壁の左下から積む）。釘配列は壁の軸組から作り直す。
    assert (panel["left"], panel["bottom"]) == (0, 0)
    assert (panel["right"], panel["top"]) == (910, 610)


# --- 計算（画面と PDF が共有する表示用データ） ------------------------------


def test_compute_all_matches_the_reference_example():
    """釘配列諸定数（3.2）は、壁の結果の中に面材 1 枚ずつ入る。

    壁の左下に張った 910 × 610 は、間柱 @455 が内側に来るので、表 3.2.1 の
    「910×610 横置・日型（@455 / 釘 @150）」の欄（Ixy 1.56）と同じ配列になる。
    """
    wall = panel_shear.compute_all(make_data())["walls"][0]
    report = wall["panelReports"][0]

    assert report["ok"] is True
    assert abs(report["result"]["Ixy"] - 1.56) <= 0.02
    assert len(report["nails"]) == 23
    assert report["panelArea"] == 555100
    # 寸法も領域から決まる。
    assert (report["width"], report["height"]) == (910, 610)

    steps = {row["label"]: row["value"] for row in report["steps"]}
    assert steps["X方向 中立軸 x0"] == "455.000 mm"


def test_compute_all_keeps_the_layout_in_the_inputs():
    """釘配列が何から決まったのかを、そのまま控えに残す。"""
    wall = panel_shear.compute_all(make_data())["walls"][0]
    inputs = {row["label"]: row["value"] for row in wall["panelReports"][0]["inputs"]}

    assert "四周打ち" in inputs["釘配列"]
    assert "中間の縦材" in inputs["釘配列"]
    assert "釘 @150" in inputs["釘配列"]
    assert "へりあき 10 mm" in inputs["釘配列"]
    assert inputs["壁内の配置"] == "表面　左下 (0, 0) 〜 右上 (910, 610) mm"


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
    # 領域が矩形になっていない面材（配置が入っていない）。
    data["walls"][0]["panels"].append({"panelName": "空", "right": 0, "top": 0})

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
    # 本は上側の 910 × 910 を「ロ型」として計算しているが、釘配列を壁の
    # 軸組から導く本ツールでは間柱の釘列が入るぶん本より大きく出る。
    assert report["result"]["Pa"] > 8.37
    assert (report["result"]["Pa"] - 8.37) / 8.37 <= 0.02
    assert report["result"]["dPa"] > 9.20
    # 壁を構成する 2 枚の面材が、入力した名前で並ぶ。
    assert [panel["label"] for panel in report["panels"]] == ["下段", "上段"]
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

    # 面材と釘は面材ごとの入力なので、壁の控えは「全ての面材で同じ組合せ」の
    # ときだけその名前を出す（面材ごとの数値は面材ごとの表と各面材の計算に）。
    inputs = {row["label"]: row["value"] for row in report["inputs"]}
    assert inputs["面材と釘"] == "構造用合板 12mm + 鉄丸釘 N-65（釘の呼び径 φ3.05 mm）"

    panel_inputs = {
        row["label"]: row["value"] for row in report["panelReports"][0]["inputs"]
    }
    assert panel_inputs["面材と釘の組合せ"] == (
        "構造用合板 12mm + 鉄丸釘 N-65（釘の呼び径 φ3.05 mm）"
    )


def test_the_edge_distance_check_follows_the_nail_diameter():
    """適用範囲 3.3(1)④「面材のへりあきは 10mm 以上かつ接合具径 d ×5 以上」。

    計算例の釘 N-65 は呼び径 φ3.05 なので 15.25mm 必要。表 3.2.1 の配列が
    前提とする 10mm のままでは足りない。
    """
    data = panel_shear.example_wall_data()

    report = panel_shear.compute_all(data)["walls"][0]

    assert report["edgeDistanceOk"] is False
    check = next(c for c in report["checks"] if "へりあき" in c["label"])
    assert "最小 へりあき 10 mm < 15.25 mm" in check["value"]
    assert "φ3.05 mm × 5 以上" in check["value"]

    # 必要な値まで広げれば通る（画面は面材と釘を選んだ時点で引き上げる）。
    for panel in data["walls"][0]["panels"]:
        panel["edgeDistance"] = 15.25
    widened = panel_shear.compute_all(data)["walls"][0]
    assert widened["edgeDistanceOk"] is True


def test_the_frame_clearance_check_follows_the_member_width():
    """適用範囲 3.3(1)④「軸材の縁端距離は 20mm 以上かつ接合具径 d ×5 以上」。

    計算例の間柱は 30 × 105（図 3.3.10）。中間の間柱に打つ釘は材心に来るので
    縁端距離は 15mm しか取れず、20mm に届かない（上段の 910 × 910 には @455 の
    間柱がかかる）。間柱を 45 にすれば 22.5mm となって通る。
    """
    data = panel_shear.example_wall_data()

    report = panel_shear.compute_all(data)["walls"][0]

    assert report["frameClearanceOk"] is False
    check = next(c for c in report["checks"] if "縁端距離" in c["label"])
    assert "最小 縁端距離 15 mm < 20 mm" in check["value"]
    assert "中間の縦材（X = 455 mm） ／ 間柱（見付け 30 mm）" in check["value"]

    # 間柱を 45 mm に太らせれば 22.5 mm となって通る。
    for member in data["walls"][0]["frame"]:
        if member["label"] == "間柱":
            member["width"] = 45
    assert panel_shear.compute_all(data)["walls"][0]["frameClearanceOk"] is True

    # 面材の縁を受ける材（Y = 1820 の受け材）を外すと、そこには釘を打てない。
    data["walls"][0]["frame"] = [
        member for member in data["walls"][0]["frame"] if member["position"] != 1820
    ]
    without = panel_shear.compute_all(data)["walls"][0]
    assert without["frameClearanceOk"] is False
    assert "軸組材なし" in next(
        c for c in without["checks"] if "縁端距離" in c["label"]
    )["value"]


def test_the_frame_members_are_part_of_the_wall():
    """軸組材は壁の入力で、1 本ずつ位置と見付け幅を持つ。

    軸組材を持たない前の版の入力（間柱ピッチだけ）は、当時の前提のまま
    軸組材へ読み替える（壁の両端に柱・ピッチで間柱・上下に横架材、それに
    面材の継目の材）。
    """
    data = panel_shear.normalize_data(
        {
            "walls": [
                {
                    "width": 1820,
                    "height": 2900,
                    "studPitch": 910,
                    "panels": [{"left": 0, "bottom": 0, "right": 1820, "top": 910}],
                }
            ]
        }
    )

    frame = data["walls"][0]["frame"]
    vertical = [
        (m["label"], m["position"], m["width"])
        for m in frame
        if m["direction"] == "vertical"
    ]
    assert vertical == [("柱", 0, 105), ("間柱", 910, 45), ("柱", 1820, 105)]
    # 面材の継目（Y = 910）にも、当時の前提どおり材が立つ。
    assert ("継目の材", 910, 105) in [
        (m["label"], m["position"], m["width"]) for m in frame
    ]

    # 軸組材を等間隔で組み立てる入り口も、計算実装が持っている。
    even = nail_core.call({"op": "frame", "data": {"width": 910, "height": 2900}})
    assert [member["position"] for member in even["frame"]] == [0, 455, 910, 0, 2900]


def test_the_frame_clearance_is_reported_for_every_panel():
    """面材のページにも、その面材でいちばん厳しい釘列の縁端距離を残す。"""
    data = panel_shear.normalize_data(make_data())

    wall = panel_shear.compute_all(data)["walls"][0]

    inputs = {row["label"]: row["value"] for row in wall["panelReports"][0]["inputs"]}
    # 910 × 610 を壁の左下に張るので、左右の縁は柱・下の縁は横架材。上の縁
    # （Y = 610）を受ける材は入れていないので、そこには釘を打てない。
    assert inputs["軸材の縁端距離（釘から軸組材の縁まで）"] == (
        "最小 —（上の縁 ／ 軸組材なし）"
    )


def test_the_edge_distance_is_measured_from_the_nails():
    """へりあきは、実際に置かれた釘の座標から測る。"""
    data = make_data()
    data["walls"][0]["panels"] = [make_panel(edgeDistance=20)]
    data = panel_shear.normalize_data(data)

    wall = panel_shear.compute_all(data)["walls"][0]

    inputs = {row["label"]: row["value"] for row in wall["panelReports"][0]["inputs"]}
    assert inputs["へりあき（面材の縁から釘まで）"] == "20 mm"
    # N-65（φ3.05）に必要な 15.25mm を満たしている。
    assert wall["edgeDistanceOk"] is True


def test_a_thin_panel_fails_the_shear_check():
    """面材を薄くすれば τN が上がり、せん断破壊で NG になる。"""
    data = panel_shear.example_wall_data()
    for panel in data["walls"][0]["panels"]:
        panel["thickness"] = 3

    report = panel_shear.compute_all(data)["walls"][0]

    assert report["shearOk"] is False
    assert report["buckling"][0]["cells"][-1] == "NG"
    failure = next(check for check in report["checks"] if "せん断破壊" in check["label"])
    assert failure["ok"] is False


def test_a_wall_can_mix_the_specification_of_its_panels():
    """1 枚の壁でも、面材ごとに違う面材と釘を張り分けられる。"""
    data = panel_shear.example_wall_data()
    data["walls"][0]["panels"][1].update(panel_shear.material("plywood12-cn50"))

    report = panel_shear.compute_all(data)["walls"][0]

    assert report["ok"] is True
    # 面材ごとの表に、それぞれの釘の数値（ΔPv）が並ぶ。
    assert [spec["cells"][5] for spec in report["specs"]] == ["1.13", "0.94"]
    # 壁の控えは「面材ごとに異なる」とし、面材の名前で組合せを案内する。
    inputs = {row["label"]: row["value"] for row in report["inputs"]}
    assert "面材ごとに異なる" in inputs["面材と釘"]
    assert any("太め鉄丸釘(CN 釘)50" in value for value in inputs.values())


def test_the_specification_of_a_panel_travels_with_the_saved_pdf():
    """面材ごとの面材と釘は、保存した PDF から読み戻しても面材ごとのまま。"""
    data = panel_shear.example_wall_data()
    data["walls"][0]["panels"][1].update(panel_shear.material("plywood12-cn50"))
    pdf_bytes = panel_shear.build_pdf(data, panel_shear.validate(data))

    parsed = panel_shear.parse_pdf(pdf_bytes)

    panels = parsed["walls"][0]["panels"]
    assert panels[0]["materialId"] == "plywood12-n65"
    assert panels[1]["materialId"] == "plywood12-cn50"
    assert panels[1]["deltaPv"] == 0.94


def test_the_specification_of_an_older_pdf_moves_onto_every_panel():
    """面材と釘を壁が持っていた版の入力は、読み込みで全ての面材へ配る。"""
    parsed = panel_shear.normalize_data(
        {
            **panel_shear.EXAMPLE_WALL,
            "walls": [
                {
                    **EXAMPLE_MATERIAL,
                    **panel_shear.EXAMPLE_WALL,
                    "panels": [dict(EXAMPLE_PANEL), dict(EXAMPLE_PANEL, panelId="w1-p2")],
                }
            ],
        }
    )

    wall = parsed["walls"][0]
    assert all(panel["materialId"] == "plywood12-n65" for panel in wall["panels"])
    assert all(panel["deltaPv"] == 1.13 for panel in wall["panels"])
    # 壁の側には面材と釘の欄を残さない（今の形は面材ごとの入力だけ）。
    assert "materialId" not in wall
    assert "thickness" not in wall


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
        make_panel(panelId="w1-p2", panelName="南面 上")
    )
    pdf_bytes = panel_shear.build_pdf(data, panel_shear.validate(data))

    # ページ区切り（改ページ）で数える。配列図 1 ＋ 面材 2 ＋ 壁 2
    # （壁のページに載る量は面材の枚数で変わるので、入りきらない判定は
    # 「（続き）」のページへ送られる）。
    assert extract_text(io.BytesIO(pdf_bytes)).count("\x0c") == 5


def test_pdf_prints_the_inputs_and_the_results():
    _, pdf_bytes = build_example_pdf()

    text = extract_text(io.BytesIO(pdf_bytes))

    assert "面材張り耐力要素 釘配列諸定数 計算書" in text
    assert "○○邸 新築工事" in text
    assert "作成日: 2026年8月11日" in text
    # 入力（面材寸法・面積）と、画面に出るのと同じ桁の結果。
    assert "910 × 610 mm" in text
    assert "555,100 mm²" in text
    # 途中経過は式番号つきで白箱化する。
    assert "(3.2.1)" in text
    assert "(3.2.7)" in text
    # 画面に出るのと同じ桁の諸定数が、そのまま刷られる。
    report = panel_shear.compute_all(make_data())["walls"][0]["panelReports"][0]
    for item in report["summary"]:
        assert item["value"] in text


def test_pdf_puts_the_nail_arrangement_pages_before_their_wall():
    """壁の計算は、その根拠になる面材ごとの釘配列諸定数の後ろに続ける。"""
    data = panel_shear.example_wall_data()
    pdf_bytes = panel_shear.build_pdf(data, panel_shear.validate(data))

    pages = extract_text(io.BytesIO(pdf_bytes)).split("\x0c")[:-1]

    assert len(pages) == 5  # 配列図 1 ＋ 面材 2 枚 ＋ 壁 2（判定は続きのページ）
    assert panel_shear._LAYOUT_TITLE in pages[0]
    assert all(panel_shear._TITLE in page for page in pages[1:3])
    assert all(panel_shear._WALL_TITLE in page for page in pages[3:])
    # どの壁のどの面材かが、面材のページからも読める。
    assert "面材 1 / 2" in pages[1]
    assert "壁 1 / 1" in pages[1]
    # 通しのページ番号は、すべての節を続けて数える。
    assert "5 / 5" in pages[4]


def test_a_wall_with_many_panels_continues_onto_another_page():
    """壁のページに載る量は、面材の枚数で変わる（面材ごとの表が 3 つある）。

    入りきらなければ「（続き）」のページへ送り、表や判定が脚注に重ならない
    ようにする。どのページだけを見てもどの壁の続きかが分かるよう、見出しと
    壁の名前は続きのページにも出す。
    """
    data = make_data()
    data["walls"][0]["panels"] = [
        make_panel(
            panelId=f"w1-p{index}",
            panelName=f"面材{index + 1}",
            bottom=610 * index,
            top=610 * (index + 1),
        )
        for index in range(6)
    ]
    reports = panel_shear.validate(data)
    pdf_bytes = panel_shear.build_pdf(data, reports)

    pages = extract_text(io.BytesIO(pdf_bytes)).split("\x0c")[:-1]
    wall_pages = [page for page in pages if panel_shear._WALL_TITLE in page]

    assert len(wall_pages) >= 2
    assert "（続き）" in wall_pages[1]
    assert all("○○邸 新築工事" in page for page in wall_pages)
    # 判定は 1 つも落ちない（節ごと続きのページへ送られる）。
    for check in reports["walls"][0]["checks"]:
        assert check["label"] in "".join(wall_pages)
    # 本文が脚注やページ番号の下（余白）へこぼれていない。
    for page in extract_pages(io.BytesIO(pdf_bytes)):
        for element in page:
            if isinstance(element, LTTextContainer):
                assert element.y0 >= panel_shear._MARGIN, element.get_text()


def test_pdf_prints_the_wall_calculation():
    data = panel_shear.example_wall_data()
    reports = panel_shear.validate(data)
    pdf_bytes = panel_shear.build_pdf(data, reports)

    # 壁の計算は 1 ページに収まるとは限らない（面材が増えるほど表が伸びる）。
    text = "".join(extract_text(io.BytesIO(pdf_bytes)).split("\x0c")[3:])
    wall = reports["walls"][0]

    assert "グレー本 3.3 の計算例" in text
    # 入力（階高・壁幅と、全ての面材で共通の面材と釘）。
    assert "3,000 mm" in text
    assert "910 mm" in text
    assert "構造用合板 12mm + 鉄丸釘 N-65" in text
    # 面材ごとの面材と釘の表（面材ごとに張り分けられるので壁のページにも残す）。
    assert "ΔPv [kN]" in text
    assert wall["specs"][0]["cells"][5] == "1.13"
    # 画面に出るのと同じ桁の結果と、式番号つきの途中経過。
    for item in wall["summary"]:
        assert item["value"] in text
    assert "(3.3.1)" in text
    assert "(3.3.7)" in text
    # 面材ごとの表（面材の名前と、その面材の Ixy）。
    assert "下段" in text
    assert wall["panels"][0]["cells"][1] in text
    # 面材のせん断破壊・せん断座屈の検定（式 3.3.8〜3.3.11）。
    assert "τcr [N/mm²]" in text
    assert wall["buckling"][0]["cells"][-2] in text  # τcr
    # 軸組材（釘がどの材のどこに刺さるか＝軸材の縁端距離の根拠）。
    assert "材心の位置 [mm]" in text
    assert "見付け幅 [mm]" in text
    assert "間柱" in text
    # 判定（適用範囲 3.3(1)① の上限と、④のへりあき・縁端距離、
    # 面材のせん断破壊・せん断座屈）。
    assert "13.7200" in text
    assert "軸材の縁端距離" in text
    assert text.count("OK") >= 3


# --- 壁の面材配列図（壁内での面材の配置） -----------------------------------


def placed_example() -> dict:
    """グレー本 3.3(3) の計算例（幅 910・階高 3000 の準耐力壁形式の大壁）。

    下から 910×1820、その上に 910×910 を張る（上に 270 mm の張り残しが出る）。
    """
    return panel_shear.example_wall_data()


def test_pdf_puts_the_arrangement_drawing_in_front_of_the_wall():
    """配置を入れた壁は、面材のページの前に壁の面材配列図が 1 ページ入る。"""
    data = placed_example()
    pdf_bytes = panel_shear.build_pdf(data, panel_shear.validate(data))

    pages = extract_text(io.BytesIO(pdf_bytes)).split("\x0c")[:-1]

    # 配列図 1 ＋ 面材 2 ＋ 壁 2（入りきらない判定は続きのページへ）。
    assert len(pages) == 5
    assert panel_shear._LAYOUT_TITLE in pages[0]
    assert all(panel_shear._TITLE in page for page in pages[1:3])
    assert panel_shear._WALL_TITLE in pages[3]
    assert panel_shear._WALL_TITLE + "（続き）" in pages[4]
    # 通しのページ番号も、配列図を含めて数える。
    assert "5 / 5" in pages[4]


def test_the_arrangement_page_shows_where_every_panel_goes():
    data = placed_example()
    reports = panel_shear.validate(data)

    text = extract_text(io.BytesIO(panel_shear.build_pdf(data, reports))).split("\x0c")[0]

    assert "表面（2 枚）" in text
    assert "W = 910 mm" in text
    assert "H = 3,000 mm" in text
    # 面材の一覧（張る面・寸法・左下の位置・面積）。
    assert "左下 (X, Y) [mm]" in text
    assert "(0, 1,820)" in text
    assert "910 × 1,820 mm" in text
    # 配置の確認。張り残し（準耐力壁形式なので上に 270 mm 残る）は NG にしない。
    assert "はみ出し・重なりなし" in text
    assert "2,484,300 mm²" in text
    assert panel_shear._layout_check(reports["walls"][0])["ok"] is True


def test_the_arrangement_page_marks_a_panel_that_does_not_fit():
    """壁からはみ出す配置は、計算に入れた枚数と張り方の食い違い。"""
    data = placed_example()
    # 上段を 2500 まで持ち上げる（2500 + 910 > 3000）。
    data["walls"][0]["panels"][1]["bottom"] = 2500
    data["walls"][0]["panels"][1]["top"] = 3410
    reports = panel_shear.validate(data)

    text = extract_text(
        io.BytesIO(panel_shear.build_pdf(data, reports))
    ).split("\x0c")[0]

    assert "※ 上段（はみ出し）" in text
    assert "面材「上段」が壁（910 × 3,000 mm）からはみ出しています" in text
    assert "NG" in text


def test_the_arrangement_page_draws_both_sides_of_a_wall():
    """両面張りは、表と裏を並べて描く（同じ場所に来ても重なりではない）。"""
    data = placed_example()
    panels = data["walls"][0]["panels"]
    data["walls"][0]["panels"] = panels + [
        {**panel, "panelId": f"w1-b{index}", "panelName": f"裏 {panel['panelName']}",
         "side": "back"}
        for index, panel in enumerate(panels)
    ]
    data = panel_shear.normalize_data(data)
    reports = panel_shear.validate(data)

    text = extract_text(
        io.BytesIO(panel_shear.build_pdf(data, reports))
    ).split("\x0c")[0]

    assert "表面（2 枚）" in text
    assert "裏面（2 枚）" in text
    assert "はみ出し・重なりなし" in text


def test_the_position_of_a_panel_travels_with_the_saved_pdf():
    data = placed_example()
    pdf_bytes = panel_shear.build_pdf(data, panel_shear.validate(data))

    parsed = panel_shear.parse_pdf(pdf_bytes)

    assert parsed == data
    panel = parsed["walls"][0]["panels"][1]
    assert (panel["left"], panel["bottom"]) == (0, 1820)
    assert (panel["right"], panel["top"]) == (910, 2730)
    assert panel["side"] == "front"
    # 壁の軸組（間柱ピッチ）も、そのまま戻る。
    # 軸組材も、位置と見付け幅のまま保存されて戻る。
    assert parsed["walls"][0]["frame"][1] == {
        "direction": "vertical",
        "label": "間柱",
        "position": 455,
        "width": 30,
    }


def test_pdf_marks_a_wall_over_the_upper_limit_as_ng():
    data = panel_shear.example_wall_data()
    data["walls"][0]["width"] = 300
    reports = panel_shear.validate(data)

    # 判定は壁のページの最後（入りきらなければ「（続き）」のページ）に出る。
    text = extract_text(io.BytesIO(panel_shear.build_pdf(data, reports))).split("\x0c")[-2]

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
    assert (panel["left"], panel["bottom"]) == (0, 0)
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


def test_pdf_round_trips_a_two_sided_wall():
    """両面張りの壁も、面ごとそのまま復元できる。"""
    data = placed_example()
    panels = data["walls"][0]["panels"]
    data["walls"][0]["panels"] = panels + [
        {**panel, "panelId": f"w1-b{index}", "panelName": f"裏 {panel['panelName']}",
         "side": "back"}
        for index, panel in enumerate(panels)
    ]
    data = panel_shear.normalize_data(data)
    pdf_bytes = panel_shear.build_pdf(data, panel_shear.validate(data))

    parsed = panel_shear.parse_pdf(pdf_bytes)

    assert parsed == data
    assert [panel["side"] for panel in parsed["walls"][0]["panels"]] == [
        "front", "front", "back", "back",
    ]


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
