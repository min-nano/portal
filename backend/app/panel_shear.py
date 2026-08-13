"""面材張り大壁 計算ツールの保存・計算書 PDF の生成と解析。

GAS 版（gas-timber-panel-shear-calculator）はスプレッドシートへ「現在値 +
履歴」を書き出していたが、本ポータルでは構造計算安全証明書と同じ考え方に
そろえ、**成果物の PDF そのものを保存形式**にする。フォーム入力を PDF の
文書情報へ埋め込むので、保存した PDF を開き直せば入力内容を完全に復元して
続きを編集できる（スプレッドシートも履歴タブも持たない）。

計算・入力の解釈・表示する桁の丸めは nail_core（Rust 製の wasm）に委譲する。
画面もまったく同じ .wasm を動かすので、実装は 1 つしかない。このモジュールが
受け持つのは、その結果を PDF に組む仕事と、保存時の突き合わせ（verify）。

1 PDF = 1 物件。ページは壁 1 枚ごとに「その壁を構成する面材の釘配列諸定数
（グレー本 3.2）を 1 枚 1 ページ」並べ、続けて「壁の剛性と許容せん断耐力
（同 3.3）を 1 ページ」置く。釘配列諸定数は壁の計算の一部として扱う。
"""

import json
import re

from . import nail_core, pdf_tools, pdf_write
from .nail_core import CoreError

# 文書情報に入れる独自キー（このツールが作った PDF の目印にもなる）。
METADATA_KEY = "/PortalTimberPanelShear"

DEFAULT_FILE_NAME = "釘配列諸定数計算書.pdf"
FILE_NAME_TEMPLATE = "釘配列諸定数計算書_{projectName}.pdf"

# ファイル名に使えない文字（Drive 上でも扱いづらいもの）。
_UNSAFE_FILE_NAME_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')

# 画面の計算結果とサーバの計算結果を「同じ」とみなす相対差。
#
# 同じ .wasm を同じ引数で動かすので、本来は 1 ビットも違わない。ここに幅を
# 持たせてあるのは、JSON を経由する往復や端末差を疑わずに済ませるためで、
# これを超える差は「画面とサーバで違うものを計算している」ということ。
VERIFY_RELATIVE_TOLERANCE = 1e-9

# 突き合わせの結果に並べる差の上限（全項目が違うときに応答が膨れないように）。
MAX_REPORTED_DIFFERENCES = 20

# グレー本 解説の計算例（図 3.2.2）。テストと README の例で使う基準の配列。
#
# 面材は W 910 × H 610（横置き。長辺が横で、間柱は 455 ピッチ）。本は左下の
# 釘を (0, 0) として 890 × 590 の広がりで書いているが、ここではへりあき
# 10 mm を見込んで面材の左下を原点にする。平行移動なので Ixy・Zxy・Cxy は
# 本と同じで、弾性中立軸だけが x0 = 455、y0 = 305 になる。この配列は
# 表 3.2.1 の「910×610 横置・川型（@455 / 釘 @150）」そのものなので、画面では
# 標準的な釘配列の一覧から呼び出せる（計算例だけを読み込む操作は置いていない）。
EXAMPLE_PANEL = {
    "panelName": "グレー本の計算例",
    "width": 910,
    "height": 610,
    "mode": "layout",
    "arrangement": "kawa",
    "studPitch": 455,
    "nailPitch": 150,
    "edgeDistance": 10,
}

# グレー本 3.3(3)「面材張り大壁の許容せん断耐力の計算例」（図 3.3.10）。
#
# 階高 3000・幅 910 の準耐力壁形式の大壁で、下側に 1820 × 910、上側に
# 910 × 910 の構造用合板 12mm を @75 で四周打ちしたもの。面材の割り付けは
# 表 3.2.1 の配列（EXAMPLE_WALL_PRESETS）をそのまま使い、面材と釘の数値は
# 表 3.3.1 の組合せ（EXAMPLE_WALL_MATERIAL）から読み込む。
#
# 本文は釘を「CN65」としているが、印刷された表 3.3.1 は構造用合板 12mm の
# N-65 と CN65 が入れ替わっており（正誤表による訂正あり）、本文が計算に使って
# いる k = 0.483・δv = 2.3・δu = 17.0・ΔPv = 1.13 は訂正後の N-65 の値。
# よってこの計算例の釘は N-65 として扱う（core/src/wall.rs の TABLE 参照）。
# 表 3.2.1 の配列はへりあき 10mm を前提としているが、この計算例の釘 N-65 は
# 呼び径 φ3.05 なので、3.3(1)④ の「10mm 以上かつ接合具径 d ×5 以上」は
# 15.25mm を要求する。本の計算例をそのまま再現するとこの検定は NG になる
# （画面では、面材と釘を選んだ時点でへりあきが必要な値まで引き上げられる）。
EXAMPLE_WALL_PRESETS = ("910x1820-s455-n75-hi", "910x910-s455-n75-ro")
EXAMPLE_WALL_MATERIAL = "plywood12-n65"
EXAMPLE_WALL = {
    "wallName": "グレー本 3.3 の計算例",
    "height": 3000,
    "width": 910,
    # 間柱 30 × 105 を @455 で入れている（図 3.3.10）。
    "hasIntermediateStud": True,
}


class PanelShearError(Exception):
    """入力・生成・解析の失敗。message は利用者に表示できる日本語文。"""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# --- 計算（唯一の実装である wasm へ委譲する） -------------------------------


def _core(operation: str, data: dict) -> dict:
    """計算実装を呼ぶ。失敗はそのまま利用者に見せられる 400 にする。"""
    try:
        return nail_core.call({"op": operation, "data": data})
    except CoreError as error:
        raise PanelShearError(str(error)) from error


def normalize_data(data) -> dict:
    """API で受け取った本文を、このツールが扱う形へ整える。

    未知のキーは捨て、壁は 1 枚以上に整える（空のフォームでも「壁が 1 枚
    ある」状態から始められるようにする）。前の版で保存した PDF（釘配列
    パターンを別に登録し、壁が patternId で指す形）も、ここで今の形へ
    移し替える。入力欄の文字列をどう読むかは計算そのものと地続きなので、
    ここも計算実装に任せる。
    """
    return _core("normalize", data)["data"]


def compute_all(data: dict) -> dict:
    """壁をまとめて計算し、{"walls": [...]} を返す。

    面材ごとの釘配列諸定数（グレー本 3.2）は、壁の結果の中に
    `panelReports` として入る。計算できないものは ok: False で返る。
    1 枚の壁の不備で他の壁の結果まで失わせない（保存時は validate() で
    改めて全件を確かめる）。
    """
    return {"walls": _core("computeAll", data)["walls"]}


def validate(data: dict) -> dict:
    """保存できる状態か確かめ、壁ごとの計算結果を返す。"""
    return {"walls": _core("validate", data)["walls"]}


def preset_panel(preset_id: str) -> dict:
    """グレー本 表 3.2.1 の配列を、面材 1 枚分の割り付けにして返す。"""
    try:
        return nail_core.call({"op": "preset", "data": {"id": preset_id}})["panel"]
    except CoreError as error:
        raise PanelShearError(str(error)) from error


def material(material_id: str) -> dict:
    """グレー本 表 3.3.1 の組合せを、面材の入力欄へ入れる形で返す。

    表 3.3.2 の既定の規格（構造用合板なら JAS 1 級）も一緒に付いてくるので、
    これだけで面材のせん断破壊・せん断座屈の検定まで数値がそろう。
    """
    for entry in nail_core.call({"op": "materials"})["materials"]:
        if entry["id"] == material_id:
            return {
                "materialId": entry["id"],
                "thickness": entry["thickness"],
                "shearModulus": entry["shearModulus"],
                "k": entry["k"],
                "deltaV": entry["deltaV"],
                "deltaU": entry["deltaU"],
                "deltaPv": entry["deltaPv"],
                "gradeId": entry["gradeId"],
                "tauMax": entry["tauMax"],
                "e1": entry["e1"],
                "e2": entry["e2"],
            }
    raise PanelShearError(f"知らない面材と釘の組合せです: {material_id}")


def example_wall_data() -> dict:
    """グレー本 3.3(3) の計算例を、そのまま計算・作図できるフォーム入力にする。

    面材と釘は面材ごとの入力なので、2 枚とも同じ組合せを持たせる（計算例の
    壁は 1 種類の面材と釘で張られている）。
    """
    spec = material(EXAMPLE_WALL_MATERIAL)
    return normalize_data(
        {
            "projectName": "グレー本 3.3 の計算例",
            "walls": [
                {
                    **EXAMPLE_WALL,
                    "panels": [
                        {**spec, **preset_panel(preset_id)}
                        for preset_id in EXAMPLE_WALL_PRESETS
                    ],
                }
            ],
        }
    )


# --- 保存時の突き合わせ ------------------------------------------------------


def _is_close(client, server) -> bool:
    """画面の値とサーバの値を「同じ」とみなせるか。"""
    if not isinstance(client, (int, float)) or isinstance(client, bool):
        return False
    difference = abs(float(client) - float(server))
    scale = max(1.0, abs(float(client)), abs(float(server)))
    return difference <= VERIFY_RELATIVE_TOLERANCE * scale


def _claimed_results(claim: dict, section: str, id_key: str) -> dict:
    """画面が送ってきた「私はこう計算した」を id → 計算結果の辞書にする。"""
    return {
        str(entry.get(id_key)): entry.get("result")
        for entry in claim.get(section) or []
        if isinstance(entry, dict)
    }


def _differences(reports: list[dict], claimed: dict, id_key: str, name_key: str) -> list[dict]:
    """1 つの節（壁／面材）について、画面とサーバの食い違いを並べる。"""
    differences = []
    for report in reports:
        found = {id_key: report[id_key], name_key: report[name_key]}
        client_result = claimed.get(report[id_key])
        if not isinstance(client_result, dict):
            differences.append({**found, "key": "(計算結果なし)", "client": "-", "server": "計算済み"})
            continue
        for key, server_value in report["result"].items():
            client_value = client_result.get(key)
            if not _is_close(client_value, server_value):
                differences.append(
                    {**found, "key": key, "client": client_value, "server": server_value}
                )
    return differences


def panel_reports(reports: dict) -> list[dict]:
    """壁ごとの結果から、面材 1 枚ずつの釘配列諸定数を順番どおりに取り出す。

    釘配列諸定数は壁の計算の一部（`panelReports`）なので、突き合わせも
    計算書のページ組みも、この並びをそのまま使う。
    """
    return [
        panel
        for wall in reports["walls"]
        for panel in wall.get("panelReports") or []
        if panel.get("ok", True)
    ]


def verify(reports: dict, claim) -> dict:
    """画面が出した計算結果と、サーバの計算結果を突き合わせる。

    編集中の計算は画面（wasm）が行うので、保存する計算書と画面で見ていた値が
    同じであることを、保存のたびにサーバ側でも確かめる。壁の値（3.3）だけで
    なく、その根拠になる面材ごとの釘配列諸定数（3.2）も突き合わせる。同じ
    .wasm を動かしている以上ふつうは一致するが、次のような食い違いはここで
    拾える:

      - 画面を開いたまま新しい版がデプロイされ、古い計算実装が残っている
      - 端末や処理系の差で、末尾の桁が違う

    ずれていても保存は止めない（計算書に載るのはサーバの値なので、成果物が
    壊れることはない）。画面には警告として返し、利用者が気付けるようにする。
    """
    if not isinstance(claim, dict):
        # 画面が突き合わせの材料を送ってこない（＝この仕組みより前の版）。
        return {"checked": False, "ok": True, "differences": []}

    client_version = str(claim.get("coreVersion") or "")
    server_version = nail_core.version()

    differences = _differences(
        reports["walls"],
        _claimed_results(claim, "walls", "wallId"),
        "wallId",
        "wallName",
    ) + _differences(
        panel_reports(reports),
        _claimed_results(claim, "panels", "panelId"),
        "panelId",
        "panelName",
    )

    return {
        "checked": True,
        "ok": not differences and client_version == server_version,
        "coreVersion": {"client": client_version, "server": server_version},
        "differences": differences[:MAX_REPORTED_DIFFERENCES],
        "omittedDifferences": max(0, len(differences) - MAX_REPORTED_DIFFERENCES),
    }


# --- ファイル名 --------------------------------------------------------------


def default_file_name(data: dict) -> str:
    """物件名から既定のファイル名を組み立てる。"""
    project = data.get("projectName") or ""
    name = FILE_NAME_TEMPLATE.format(projectName=project) if project else DEFAULT_FILE_NAME
    return ensure_pdf_extension(name)


def ensure_pdf_extension(name: str) -> str:
    name = _UNSAFE_FILE_NAME_CHARS.sub("", (name or "").strip()).strip().strip(".")
    if not name:
        return DEFAULT_FILE_NAME
    return name if name.lower().endswith(".pdf") else name + ".pdf"


# --- 計算書 PDF の組み立て ---------------------------------------------------

_MARGIN = 42.5  # 15mm
_TITLE = "面材張り耐力要素 釘配列諸定数 計算書"
_SUBTITLE = (
    "グレー本『木造軸組工法住宅の許容応力度設計』"
    "3.2 面材張り耐力要素の詳細計算法で用いる釘配列諸定数の計算（式 3.2.1〜3.2.7）に準拠"
)
_FOOTNOTE = (
    "面材・軸材は剛体、軸材どうしはピン接合、"
    "釘のせん断変形は中立軸に対して平面保持仮定が成立することを前提とする。"
)

_WALL_TITLE = "面材張り大壁 剛性・許容せん断耐力 計算書"
# PDF の文書情報に入れる題名（1 通の中に 3.2 と 3.3 の両方が入る）。
_DOCUMENT_TITLE = "面材張り大壁・釘配列諸定数 計算書"
_WALL_SUBTITLE = (
    "グレー本『木造軸組工法住宅の許容応力度設計』"
    "3.3 面材張り大壁の詳細計算法（式 3.3.1〜3.3.11）に準拠"
)
_WALL_FOOTNOTE = (
    "面材のせん断座屈は四周打ち（式 3.3.11）で検定している（適用範囲 3.3(1)⑤ により、"
    "面材張り大壁は面材の四周を釘打ちする）。適用範囲のうち機械的に判定できるのは"
    "①許容せん断耐力の上限と、④のうち面材の釘列に対するへりあき（10mm 以上かつ接合具径 d ×5 以上）まで。"
    "釘のピッチ・軸材の釘列に対する縁端距離・面材と釘の組合せ・端部および継目の材の断面・"
    "中間材（間柱等）の配置は、設計者が 3.3(1) の②〜⑧に照らして確認すること。"
)

# 面材ごとの値の表で、面材名の欄に取る幅 [pt]。残りを数値の列で等分する。
_PANEL_NAME_WIDTH = 150.0


def _format_issued_on(value: str) -> str:
    """日付ピッカーの値（YYYY-MM-DD）を「2026年8月11日」にする。"""
    match = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", value or "")
    if not match:
        return value or ""
    year, month, day = (int(part) for part in match.groups())
    return f"{year}年{month}月{day}日"


def _draw_diagram(page: pdf_write.Page, box: tuple[float, float, float, float],
                  report: dict):
    """釘配列図（面材の枠・釘・弾性中立軸）を box の中に描く。

    box は (x, y, width, height)。工学座標（x は右・y は上、原点は面材の
    左下）をそのまま PDF 座標へ写せるので、画面の SVG と違って上下の反転は
    要らない。描く範囲と目盛の文字は計算実装が決めたもの（report["diagram"]）
    を使う。画面の SVG も同じものを読むので、縮尺だけが違う同じ図になる。
    """
    x, y, width, height = box
    nails = report["nails"]
    diagram = report["diagram"]
    panel_w = diagram["panelWidth"]
    panel_h = diagram["panelHeight"]
    if not nails or panel_w <= 0 or panel_h <= 0:
        return

    min_x, max_x = diagram["minX"], diagram["maxX"]
    min_y, max_y = diagram["minY"], diagram["maxY"]
    domain_w = max_x - min_x
    domain_h = max_y - min_y
    if domain_w <= 0 or domain_h <= 0:
        return

    # 目盛の数字を置く余白を左と下に取る。
    pad_left, pad_bottom, pad_top, pad_right = 34.0, 22.0, 14.0, 34.0
    scale = min(
        (width - pad_left - pad_right) / domain_w,
        (height - pad_bottom - pad_top) / domain_h,
    )
    draw_w = domain_w * scale
    draw_h = domain_h * scale
    origin_x = x + pad_left + (width - pad_left - pad_right - draw_w) / 2
    origin_y = y + pad_bottom + (height - pad_bottom - pad_top - draw_h) / 2

    def to_x(value: float) -> float:
        return origin_x + (value - min_x) * scale

    def to_y(value: float) -> float:
        return origin_y + (value - min_y) * scale

    # 面材の枠。
    page.rect(
        to_x(0), to_y(0), panel_w * scale, panel_h * scale,
        line_width=0.8, gray=0.45, fill_gray=0.97,
    )

    # 弾性中立軸 x0 / y0（破線）。
    axis = diagram["axis"]
    axis_x, axis_y = to_x(axis["x0"]), to_y(axis["y0"])
    page.line(axis_x, to_y(min_y), axis_x, to_y(max_y), 0.6, 0.35, dash=(3, 2))
    page.line(to_x(min_x), axis_y, to_x(max_x), axis_y, 0.6, 0.35, dash=(3, 2))
    page.text(axis_x, to_y(max_y) + 4, axis["xLabel"], 6.5, align="center", gray=0.35)
    page.text(to_x(max_x) + 3, axis_y - 2, axis["yLabel"], 6.5, gray=0.35)

    # 座標の目盛（重複を除いた昇順）。
    for tick in diagram["xTicks"]:
        position = to_x(tick["value"])
        page.line(position, origin_y - 3, position, origin_y, 0.4, 0.6)
        page.text(position, origin_y - 11, tick["label"], 6, align="center", gray=0.45)
    for tick in diagram["yTicks"]:
        position = to_y(tick["value"])
        page.line(origin_x - 3, position, origin_x, position, 0.4, 0.6)
        page.text(origin_x - 5, position - 2, tick["label"], 6, align="right", gray=0.45)

    for nail in nails:
        page.circle(to_x(nail["x"]), to_y(nail["y"]), 1.8, 0.3, 0.2, fill_gray=0.2)


def _draw_panel_page(page: pdf_write.Page, data: dict, wall: dict, report: dict,
                     position: tuple[int, int, int, int],
                     page_number: int, page_total: int):
    """壁を構成する面材 1 枚分のページ（グレー本 3.2 の釘配列諸定数）。

    position は (壁の番号, 壁の総数, 面材の番号, 面材の総数)。どの壁の
    どの面材かが、次に続く壁のページと突き合わせられるように見出しへ出す。
    """
    left = _MARGIN
    right = page.width - _MARGIN
    cursor = page.height - _MARGIN
    wall_index, wall_total, panel_index, panel_total = position

    # --- 見出し ---
    page.text(left, cursor - 14, _TITLE, 14)
    cursor -= 20
    page.text(left, cursor - 8, _SUBTITLE, 6.5, gray=0.4)
    cursor -= 14
    page.line(left, cursor, right, cursor, 0.8, 0.3)
    cursor -= 16

    # --- 物件・壁・面材 ---
    page.text(left, cursor, "物件名", 8, gray=0.45)
    page.text(left + 52, cursor, data["projectName"] or "（未入力）", 9.5)
    issued = _format_issued_on(data["issuedOn"])
    if issued:
        page.text(right, cursor, f"作成日: {issued}", 8.5, align="right", gray=0.3)
    cursor -= 14
    page.text(left, cursor, "壁", 8, gray=0.45)
    page.text(left + 52, cursor, wall["wallName"], 9.5)
    page.text(right, cursor, f"壁 {wall_index} / {wall_total}", 8.5, align="right", gray=0.3)
    cursor -= 14
    page.text(left, cursor, "面材", 8, gray=0.45)
    page.text(left + 52, cursor, report["panelName"], 9.5)
    page.text(right, cursor, f"面材 {panel_index} / {panel_total}", 8.5,
              align="right", gray=0.3)
    cursor -= 20

    # --- 1. 入力 ---
    cursor = _draw_section(page, left, right, cursor, "1. 入力")
    for row in report["inputs"]:
        page.text(left + 8, cursor, row["label"], 8.5, gray=0.45)
        value = row["value"]
        size = _shrink_to_fit(page, value, 9, right - left - 138)
        page.text(left + 130, cursor, value, size)
        cursor -= 13
    cursor -= 8

    # --- 2. 計算結果 ---
    cursor = _draw_section(page, left, right, cursor, "2. 釘配列諸定数")
    box_width = (right - left - 16) / 3
    for position_index, item in enumerate(report["summary"]):
        box_x = left + position_index * (box_width + 8)
        page.rect(box_x, cursor - 34, box_width, 38, 0.5, 0.6, fill_gray=0.96)
        unit = f" [{item['unit']}]" if item["unit"] else ""
        page.text(box_x + box_width / 2, cursor - 8, item["key"] + unit, 7.5,
                  align="center", gray=0.4)
        page.text(box_x + box_width / 2, cursor - 26, item["value"], 13,
                  align="center")
    cursor -= 48

    # --- 3. 途中経過 ---
    cursor = _draw_section(page, left, right, cursor, "3. 計算の途中経過")
    for row in report["steps"]:
        page.text(left + 8, cursor, row["label"], 8.5, gray=0.35)
        page.text(left + 170, cursor, row["eq"], 7.5, gray=0.55)
        page.text(right - 8, cursor, row["value"], 9, align="right")
        page.line(left + 4, cursor - 4, right - 4, cursor - 4, 0.3, 0.85)
        cursor -= 13
    cursor -= 8

    # --- 4. 釘配列図 ---
    cursor = _draw_section(page, left, right, cursor, "4. 釘配列図")
    diagram_bottom = _MARGIN + 24
    _draw_diagram(page, (left, diagram_bottom, right - left, cursor - diagram_bottom + 6),
                  report)

    # --- 脚注 ---
    _draw_footnote(page, left, right, _FOOTNOTE, page_number, page_total)


def _draw_section(page: pdf_write.Page, left: float, right: float, cursor: float,
                  title: str) -> float:
    """節の見出しを描き、次に書き始める y を返す。"""
    page.text(left, cursor, title, 9.5)
    page.line(left, cursor - 5, right, cursor - 5, 0.5, 0.55)
    return cursor - 20


def _shrink_to_fit(page: pdf_write.Page, text: str, size: float, width: float) -> float:
    """width に収まる文字サイズを返す（収まらなければ 0.7 倍まで小さくする）。

    面材の名前は「1820×910 縦置・日型（間柱・根太 @455 / 釘 @75）」のように
    長くなりうるので、欄からはみ出すより字を詰める。
    """
    smallest = size * 0.7
    while size > smallest and page.font.text_width(text, size) > width:
        size -= 0.25
    return size


def _wrap_to_fit(page: pdf_write.Page, text: str, size: float,
                 width: float) -> list[str]:
    """width に収まるように折り返した行を返す。

    日本語には単語の区切りが無いので文字単位で折る（欄からはみ出させない
    ことが目的で、行末の禁則処理までは見ない）。
    """
    lines: list[str] = []
    line = ""
    for character in text:
        if line and page.font.text_width(line + character, size) > width:
            lines.append(line)
            line = ""
        line += character
    lines.append(line)
    return lines


def _draw_panel_table(page: pdf_write.Page, left: float, right: float, cursor: float,
                      report: dict, columns_key: str = "panelColumns",
                      rows_key: str = "panels") -> float:
    """面材ごとの値を表に組む（1 列目が面材名、残りは右寄せの数値）。"""
    columns = report[columns_key]
    value_width = (right - left - _PANEL_NAME_WIDTH) / (len(columns) - 1)

    def value_x(position: int) -> float:
        """position 番目の数値列の右端（数値は右寄せ）。"""
        return left + _PANEL_NAME_WIDTH + value_width * (position + 1) - 3

    page.text(left + 3, cursor, columns[0], 6.5, gray=0.45)
    for position, header in enumerate(columns[1:]):
        # 見出しは単位まで入れると欄をはみ出すことがあるので、幅に合わせて詰める。
        size = _shrink_to_fit(page, header, 6.5, value_width - 4)
        page.text(value_x(position), cursor, header, size, align="right", gray=0.45)
    cursor -= 4
    page.line(left, cursor, right, cursor, 0.5, 0.55)
    cursor -= 11

    for panel in report[rows_key]:
        size = _shrink_to_fit(page, panel["label"], 7.5, _PANEL_NAME_WIDTH - 6)
        page.text(left + 3, cursor, panel["label"], size)
        for position, cell in enumerate(panel["cells"]):
            size = _shrink_to_fit(page, cell, 7.5, value_width - 4)
            page.text(value_x(position), cursor, cell, size, align="right")
        page.line(left, cursor - 4, right, cursor - 4, 0.3, 0.85)
        cursor -= 13
    return cursor - 8


def _draw_wall_page(page: pdf_write.Page, data: dict, report: dict,
                    index: int, total: int, page_number: int, page_total: int):
    """壁 1 枚分のページ（グレー本 3.3 の計算）。"""
    left = _MARGIN
    right = page.width - _MARGIN
    cursor = page.height - _MARGIN

    # --- 見出し ---
    page.text(left, cursor - 14, _WALL_TITLE, 14)
    cursor -= 20
    page.text(left, cursor - 8, _WALL_SUBTITLE, 6.5, gray=0.4)
    cursor -= 14
    page.line(left, cursor, right, cursor, 0.8, 0.3)
    cursor -= 16

    # --- 物件・壁 ---
    page.text(left, cursor, "物件名", 8, gray=0.45)
    page.text(left + 52, cursor, data["projectName"] or "（未入力）", 9.5)
    issued = _format_issued_on(data["issuedOn"])
    if issued:
        page.text(right, cursor, f"作成日: {issued}", 8.5, align="right", gray=0.3)
    cursor -= 14
    page.text(left, cursor, "壁", 8, gray=0.45)
    page.text(left + 52, cursor, report["wallName"], 9.5)
    page.text(right, cursor, f"壁 {index} / {total}", 8.5, align="right", gray=0.3)
    cursor -= 20

    # --- 1. 入力 ---
    cursor = _draw_section(page, left, right, cursor, "1. 入力")
    for row in report["inputs"]:
        page.text(left + 8, cursor, row["label"], 8.5, gray=0.45)
        value = row["value"]
        # 面材と釘が面材ごとに違う壁では、面材の名前と組合せが並ぶので長くなる。
        size = _shrink_to_fit(page, value, 9, right - left - 168)
        page.text(left + 160, cursor, value, size)
        cursor -= 13
    cursor -= 8

    # --- 2. 計算結果 ---
    cursor = _draw_section(page, left, right, cursor, "2. 剛性とせん断耐力")
    box_width = (right - left - 16) / 3
    for position, item in enumerate(report["summary"]):
        box_x = left + position * (box_width + 8)
        page.rect(box_x, cursor - 34, box_width, 38, 0.5, 0.6, fill_gray=0.96)
        unit = f" [{item['unit']}]" if item["unit"] else ""
        page.text(box_x + box_width / 2, cursor - 8, item["key"] + unit, 7.5,
                  align="center", gray=0.4)
        page.text(box_x + box_width / 2, cursor - 26, item["value"], 13, align="center")
    cursor -= 48

    # --- 3. 面材ごとの面材と釘 ---
    # 面材と釘は面材ごとの入力（1 枚の壁でも張り分けられる）ので、どの面材が
    # どの数値で計算されたのかをここに残す。
    cursor = _draw_section(page, left, right, cursor, "3. 面材ごとの面材と釘")
    cursor = _draw_panel_table(
        page, left, right, cursor, report, "specColumns", "specs"
    )

    # --- 4. 面材ごとの値 ---
    cursor = _draw_section(page, left, right, cursor, "4. 面材ごとの値")
    cursor = _draw_panel_table(page, left, right, cursor, report)

    # --- 5. 途中経過 ---
    cursor = _draw_section(page, left, right, cursor, "5. 壁全体の計算")
    for row in report["steps"]:
        page.text(left + 8, cursor, row["label"], 8.5, gray=0.35)
        page.text(right - 8, cursor, row["value"], 9, align="right")
        if row["eq"]:
            page.text(right - 118, cursor, row["eq"], 7.5, align="right", gray=0.55)
        page.line(left + 4, cursor - 4, right - 4, cursor - 4, 0.3, 0.85)
        cursor -= 13
    cursor -= 8

    # --- 6. 面材のせん断破壊・せん断座屈（式 3.3.8〜3.3.11） ---
    cursor = _draw_section(
        page, left, right, cursor, "6. 面材のせん断破壊・せん断座屈の検定"
    )
    cursor = _draw_panel_table(
        page, left, right, cursor, report, "bucklingColumns", "buckling"
    )

    # --- 7. 判定 ---
    _draw_section(page, left, right, cursor, "7. 判定")
    cursor -= 20
    for check in report["checks"]:
        page.text(left + 8, cursor, check["label"], 8.5, gray=0.45)
        page.text(right - 8, cursor, "OK" if check["ok"] else "NG", 9, align="right")
        # 判定の根拠には、いちばん厳しい面材の名前まで入る。欄に収まらなければ
        # 字を詰めるのではなく折り返す（OK / NG の欄と重ねない）。
        for line in _wrap_to_fit(page, check["value"], 8.5, right - left - 260):
            page.text(left + 230, cursor, line, 8.5)
            cursor -= 11
        cursor -= 2

    # --- 脚注 ---
    _draw_footnote(page, left, right, _WALL_FOOTNOTE, page_number, page_total)


def _draw_footnote(page: pdf_write.Page, left: float, right: float, note: str,
                   page_number: int, page_total: int):
    """区切り線・脚注・ページ番号を、ページ下端に置く。

    脚注は 1 行に入らないことがあるので幅で折り返し、区切り線はその行数に
    合わせて上げる（本文と重ならないよう、行数は呼ぶ側が気にしなくてよい）。
    """
    lines = _wrap_to_fit(page, note, 6.5, right - left - 40)

    baseline = _MARGIN + 6 + 8 * (len(lines) - 1)
    page.line(left, baseline + 10, right, baseline + 10, 0.3, 0.7)
    for text in lines:
        page.text(left, baseline, text, 6.5, gray=0.45)
        baseline -= 8
    page.text(right, _MARGIN + 6, f"{page_number} / {page_total}", 6.5,
              align="right", gray=0.45)


def build_pdf(data: dict, reports: dict) -> bytes:
    """計算書 PDF を組み立てる。

    ページは壁 1 枚につき「その壁を構成する面材 1 枚ごとの釘配列諸定数」
    （グレー本 3.2）を並べ、そのあとに「壁の剛性と許容せん断耐力」
    （同 3.3）を置く。壁の計算の根拠になる釘配列諸定数が、必ずその壁の
    ページの直前にそろう。

    再編集のため、フォーム入力そのものを文書情報へ埋め込む
    （構造計算安全証明書と同じ仕組み）。ensure_ascii のままにして
    PDF の文字コードの差異を避ける。
    """
    document = pdf_write.Document()
    walls = reports["walls"]
    page_total = sum(len(wall["panelReports"]) + 1 for wall in walls)

    page_number = 0
    for index, wall in enumerate(walls, start=1):
        panels = wall["panelReports"]
        for panel_index, panel in enumerate(panels, start=1):
            page_number += 1
            _draw_panel_page(
                document.add_page(), data, wall, panel,
                (index, len(walls), panel_index, len(panels)),
                page_number, page_total,
            )
        page_number += 1
        _draw_wall_page(document.add_page(), data, wall, index, len(walls),
                        page_number, page_total)

    title = _DOCUMENT_TITLE + (f"（{data['projectName']}）" if data["projectName"] else "")
    return document.to_bytes(
        {
            "Title": title,
            METADATA_KEY: json.dumps(data, sort_keys=True),
        }
    )


# --- PDF の解析（読み込み） --------------------------------------------------


def parse_pdf(pdf_bytes: bytes) -> dict:
    """保存済みの計算書 PDF を読み、フォームへ流し込めるデータを返す。

    証明書と違って雛形のある帳票ではなく、本文のレイアウトはいつでも変えて
    よいものとして扱うため、復元は文書情報に埋め込んだフォーム入力だけから
    行う（本文からの推定はしない）。このツールが作った PDF でなければ、
    その旨をはっきり伝えて止める。
    """
    if not pdf_bytes:
        raise PanelShearError("PDF ファイルが空です。")
    if pdf_bytes.lstrip()[:5] != b"%PDF-":
        raise PanelShearError("PDF ファイルではないようです。")

    raw = pdf_tools.read_metadata_value(pdf_bytes, METADATA_KEY)
    if not raw:
        raise PanelShearError(
            "このツールで作成した計算書 PDF ではないため、読み込めません"
            "（入力内容は作成時に PDF へ埋め込まれます）。"
        )
    try:
        stored = json.loads(raw)
    except ValueError as error:
        raise PanelShearError(
            "計算書 PDF に埋め込まれた入力内容を読み取れませんでした。"
        ) from error
    return normalize_data(stored)


def form_config(core_path: str) -> dict:
    """画面が必要とする既定値を配信する（ファイル名の組み立て）。

    編集中の計算は画面が行うため、計算実装（wasm）の在り処もここで知らせる。
    URL に中身のハッシュを付けるので、実装が変われば画面は必ず新しいものを
    取りに行き、変わらないうちはブラウザのキャッシュから読む。
    """
    digest = nail_core.sha256()
    return {
        "default_file_name": DEFAULT_FILE_NAME,
        "file_name_template": FILE_NAME_TEMPLATE,
        "max_walls": nail_core.config()["maxWalls"],
        "max_wall_panels": nail_core.config()["maxWallPanels"],
        "default_edge_distance": nail_core.config()["defaultEdgeDistance"],
        "core": {
            "url": f"{core_path}?v={digest[:16]}",
            "version": nail_core.version(),
            "sha256": digest,
        },
    }
