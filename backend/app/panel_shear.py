"""面材張り耐力要素 釘配列諸定数 計算ツールの入力整形・計算書 PDF の生成と解析。

GAS 版（gas-timber-panel-shear-calculator）はスプレッドシートへ「現在値 +
履歴」を書き出していたが、本ポータルでは構造計算安全証明書と同じ考え方に
そろえ、**成果物の PDF そのものを保存形式**にする。フォーム入力を PDF の
文書情報へ埋め込むので、保存した PDF を開き直せば入力内容を完全に復元して
続きを編集できる（スプレッドシートも履歴タブも持たない）。

計算そのものは nail_array に委譲する（唯一の計算実装）。画面に出す数値も
PDF に刷る数値も、このモジュールが組み立てた同じ文字列を使うため、
「画面と計算書で桁が違う」ということが起こらない。

1 PDF = 1 物件、1 ページ = 1 パターン。
"""

import json
import math
import re

from . import nail_array, pdf_tools, pdf_write
from .nail_array import Nail

# 文書情報に入れる独自キー（このツールが作った PDF の目印にもなる）。
METADATA_KEY = "/PortalTimberPanelShear"

DEFAULT_FILE_NAME = "釘配列諸定数計算書.pdf"
FILE_NAME_TEMPLATE = "釘配列諸定数計算書_{projectName}.pdf"

# ファイル名に使えない文字（Drive 上でも扱いづらいもの）。
_UNSAFE_FILE_NAME_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')

# 1 パターンあたりの釘の上限。実務の面材 1 枚では 100 本程度なので十分に
# 余裕がある。桁を間違えた入力（格子に 0〜1000 を 1mm 刻みで書くなど）で
# 計算とページ描画が止まらないようにするための歯止め。
MAX_NAILS = 2000
MAX_PATTERNS = 50

# 有効桁数。Zxy ≈ 0.0036 のように小さい値でも Cxy = Zpxy / Zxy を自分で
# 検算できるだけの桁を確保する（GAS 版の画面表示と同じ 6 桁）。
SIGNIFICANT_DIGITS = 6

# グレー本 解説の計算例（図 3.2.2）。画面の「計算例を読み込む」で使う。
EXAMPLE_PATTERN = {
    "patternName": "グレー本の計算例",
    "width": 610,
    "height": 910,
    "mode": "grid",
    "gridX": "0, 445, 890",
    "gridY": "0, 145, 295, 445, 590",
    "coords": "",
}


class PanelShearError(Exception):
    """入力・生成・解析の失敗。message は利用者に表示できる日本語文。"""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# --- 数値の整形 --------------------------------------------------------------


def significant(value: float | None, digits: int = SIGNIFICANT_DIGITS) -> str:
    """有効桁数で整形する（整数部には 3 桁区切りを付ける）。

    「小数点以下の桁数」を固定すると、Zxy ≈ 0.0036 や Zpxy ≈ 0.0045 のような
    小さい値で有効桁が 2 桁しか出ず、Cxy = Zpxy / Zxy の検算ができない。
    そのため丸めは有効桁で行い、末尾の 0 も有効桁として残す。
    """
    if value is None or not math.isfinite(value):
        return "-"
    if value == 0:
        return "0"
    # 先に有効桁で丸めてから桁数を数える（9.9999… が 10.000 へ繰り上がる
    # ときに有効桁が 1 桁増えてしまうのを防ぐ）。
    rounded = float(f"{value:.{digits}g}")
    exponent = math.floor(math.log10(abs(rounded)))
    fraction_digits = min(100, max(0, digits - 1 - exponent))
    text = f"{rounded:.{fraction_digits}f}"

    sign = "-" if text.startswith("-") else ""
    text = text.lstrip("-")
    integer, _, fraction = text.partition(".")
    integer = f"{int(integer):,}"
    return sign + integer + ("." + fraction if fraction else "")


def format_int(value: float | None) -> str:
    """整数として 3 桁区切りで整形する（釘本数・面積など）。"""
    if value is None or not math.isfinite(value):
        return "-"
    return f"{round(value):,}"


# --- 入力の正規化 ------------------------------------------------------------


def _to_float(value, label: str) -> float:
    if value is None or value == "":
        return 0.0
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise PanelShearError(f"{label}には数値を入力してください。") from None
    if not math.isfinite(number):
        raise PanelShearError(f"{label}には有限の数値を入力してください。")
    return number


def _text(value) -> str:
    return "" if value is None else str(value).strip()


def normalize_data(data) -> dict:
    """API で受け取った本文を、このツールが扱う形へ整える。

    未知のキーは捨て、パターンは 1 つ以上に整える（空のフォームでも
    「パターンが 1 つある」状態から始められるようにする）。
    """
    if not isinstance(data, dict):
        raise PanelShearError("入力データがありません。")

    raw_patterns = data.get("patterns")
    raw_patterns = raw_patterns if isinstance(raw_patterns, list) else []
    if len(raw_patterns) > MAX_PATTERNS:
        raise PanelShearError(f"パターンは {MAX_PATTERNS} 個までです。")

    patterns = [normalize_pattern(p, i) for i, p in enumerate(raw_patterns)]
    if not patterns:
        patterns = [normalize_pattern({}, 0)]

    return {
        "projectName": _text(data.get("projectName")),
        "issuedOn": _text(data.get("issuedOn")),
        "patterns": patterns,
    }


def normalize_pattern(pattern, index: int = 0) -> dict:
    if not isinstance(pattern, dict):
        pattern = {}
    mode = _text(pattern.get("mode")) or "grid"
    return {
        "patternId": _text(pattern.get("patternId")) or f"p{index + 1}",
        "patternName": _text(pattern.get("patternName")),
        "width": _to_float(pattern.get("width"), "面材の幅 W"),
        "height": _to_float(pattern.get("height"), "面材の高さ H"),
        "mode": mode if mode in ("grid", "coords") else "grid",
        "gridX": _text(pattern.get("gridX")),
        "gridY": _text(pattern.get("gridY")),
        "coords": _text(pattern.get("coords")),
    }


def parse_number_list(text: str) -> list[float]:
    """「0, 445, 890」のようなカンマ・空白区切りの数値列を読む。"""
    numbers = []
    for token in re.split(r"[,\s]+", text or ""):
        if not token:
            continue
        try:
            number = float(token)
        except ValueError:
            continue
        if math.isfinite(number):
            numbers.append(number)
    return numbers


def parse_coord_lines(text: str) -> list[Nail]:
    """「x, y」を 1 行に 1 本ずつ書いた釘座標を読む。"""
    nails = []
    for line in (text or "").splitlines():
        parts = parse_number_list(line)
        if len(parts) >= 2:
            nails.append(Nail(parts[0], parts[1]))
    return nails


def panel_area_of(pattern: dict) -> float:
    return pattern["width"] * pattern["height"]


def _unusable_reason(pattern: dict, nails: list[Nail]) -> str:
    """このパターンを計算できない理由を返す（計算できるなら空文字）。

    nail_array 側にも同じ状況を弾く guard があるが、あちらは計算式が壊れた
    入力を受け取らないための最終防衛線で、文言も式の言葉（「Ix + Iy が 0」）で
    書かれている。画面に出すのは、入力欄の言葉で書いたこちらの理由。

    ここで挙げる 3 つが、入力から到達しうる計算不能のすべて:
      - 釘が無い / 面積が 0     … nail_array.validate_input
      - 釘が 1 点に集中している … Ix + Iy = 0
      - 釘が 1 直線上に並ぶ     … Zx もしくは Zy が 0 → Zxy = 0
    """
    if not nails:
        return "釘座標が入力されていません。少なくとも 1 本の釘が必要です。"
    if panel_area_of(pattern) <= 0:
        return "面材の幅 W と高さ H に正の数値を入力してください。"

    xs = {nail.x for nail in nails}
    ys = {nail.y for nail in nails}
    if len(xs) == 1 and len(ys) == 1:
        return "釘が 1 点に集中しているため、釘配列諸定数を求められません。"
    if len(xs) == 1 or len(ys) == 1:
        return (
            "釘が 1 直線上に並んでいるため、釘配列諸定数を求められません。"
            "X 方向・Y 方向のどちらにも広がりが必要です。"
        )
    return ""


def _nails_and_reason(pattern: dict) -> tuple[list[Nail], str]:
    """釘リストと、計算できない理由（計算できるなら空文字）を返す。

    理由を例外ではなく戻り値にしているのは、入力途中のパターンを画面へ
    そのまま出すため（例外の文字列を応答に混ぜない）。
    """
    if pattern["mode"] == "grid":
        xs = parse_number_list(pattern["gridX"])
        ys = parse_number_list(pattern["gridY"])
        # 格子は組み合わせの数で増えるので、作る前に本数を確かめる。
        if len(xs) * len(ys) > MAX_NAILS:
            return [], (
                f"釘の本数が多すぎます（{len(xs)} × {len(ys)} 本）。"
                f"1 パターンあたり {MAX_NAILS} 本までにしてください。"
            )
        nails = nail_array.build_rectangular_grid(xs, ys)
    else:
        nails = parse_coord_lines(pattern["coords"])
        if len(nails) > MAX_NAILS:
            return [], (
                f"釘の本数が多すぎます（{len(nails)} 本）。"
                f"1 パターンあたり {MAX_NAILS} 本までにしてください。"
            )
    return nails, _unusable_reason(pattern, nails)


def nails_of(pattern: dict) -> list[Nail]:
    """パターンの入力方式に応じて釘リストを組み立てる。"""
    nails, reason = _nails_and_reason(pattern)
    if reason:
        raise PanelShearError(reason)
    return nails


# --- 計算（画面と PDF が共有する表示用データ） ------------------------------


def _nail_arrangement_text(pattern: dict, nails: list[Nail]) -> str:
    if pattern["mode"] == "grid":
        return f"格子　X: {pattern['gridX']}　／　Y: {pattern['gridY']}"
    return f"座標を直接入力（{len(nails)} 点）"


def compute_pattern(pattern: dict) -> dict:
    """1 パターンを計算し、画面表示にも PDF にも使える形で返す。

    表示用の文字列（有効桁・単位）まで組み立てて返すことで、画面と計算書で
    桁の丸め方が食い違わないようにしている。
    """
    nails, reason = _nails_and_reason(pattern)
    if reason:
        raise PanelShearError(reason)
    return _build_report(pattern, nails)


def _build_report(pattern: dict, nails: list[Nail]) -> dict:
    """計算できると分かっているパターンの結果を組み立てる。

    ここへ来る入力は _unusable_reason を通っているので、nail_array 側の
    guard に掛かることはない（掛かるなら判定漏れという不具合）。
    """
    area = panel_area_of(pattern)
    result = nail_array.compute(nails, area)

    return {
        "patternId": pattern["patternId"],
        "patternName": pattern["patternName"],
        "nails": [{"x": nail.x, "y": nail.y} for nail in nails],
        "panelArea": area,
        "result": result.as_dict(),
        "inputs": [
            {
                "label": "面材寸法 W × H",
                "value": f"{format_int(pattern['width'])} × "
                f"{format_int(pattern['height'])} mm",
            },
            {"label": "面材面積 Aw", "value": f"{format_int(area)} mm²"},
            {"label": "釘配列", "value": _nail_arrangement_text(pattern, nails)},
            {"label": "釘本数 n", "value": f"{format_int(result.n)} 本"},
        ],
        "summary": [
            {"key": "Ixy", "unit": "mm²/mm²", "value": significant(result.Ixy)},
            {"key": "Zxy", "unit": "mm/mm²", "value": significant(result.Zxy)},
            {"key": "Cxy", "unit": "", "value": significant(result.Cxy)},
        ],
        "steps": [
            {"label": "釘本数 n", "eq": "", "value": format_int(result.n)},
            {
                "label": "X方向 中立軸 x0",
                "eq": "(3.2.2b)",
                "value": significant(result.x0) + " mm",
            },
            {
                "label": "Y方向 中立軸 y0",
                "eq": "(3.2.2a)",
                "value": significant(result.y0) + " mm",
            },
            {
                "label": "二次モーメント Ix",
                "eq": "(3.2.2a)",
                "value": format_int(result.Ix) + " mm²",
            },
            {
                "label": "二次モーメント Iy",
                "eq": "(3.2.2b)",
                "value": format_int(result.Iy) + " mm²",
            },
            {
                "label": "Ixy",
                "eq": "(3.2.1)",
                "value": significant(result.Ixy) + " mm²/mm²",
            },
            {
                "label": "端部距離 (y-y0)max",
                "eq": "",
                "value": significant(result.dy_max) + " mm",
            },
            {
                "label": "端部距離 (x-x0)max",
                "eq": "",
                "value": significant(result.dx_max) + " mm",
            },
            {
                "label": "釘配列係数 Zx",
                "eq": "(3.2.4a)",
                "value": significant(result.Zx) + " mm",
            },
            {
                "label": "釘配列係数 Zy",
                "eq": "(3.2.4b)",
                "value": significant(result.Zy) + " mm",
            },
            {
                "label": "Zxy",
                "eq": "(3.2.3)",
                "value": significant(result.Zxy) + " mm/mm²",
            },
            {"label": "変形割合 αx", "eq": "(3.2.7)", "value": significant(result.alpha_x)},
            {
                "label": "塑性釘配列係数 Zpxy",
                "eq": "(3.2.6)",
                "value": significant(result.Zpxy) + " mm/mm²",
            },
            {"label": "Cxy", "eq": "(3.2.5)", "value": significant(result.Cxy)},
        ],
    }


def compute_all(data: dict) -> list[dict]:
    """全パターンを計算する。計算できないパターンは ok: False で返す。

    入力途中でも画面に出せるよう、1 つのパターンの不備で他のパターンの
    結果まで失わせない（保存時は validate() で改めて全件を確かめる）。
    """
    reports = []
    for pattern in data["patterns"]:
        nails, reason = _nails_and_reason(pattern)
        if reason:
            reports.append(
                {
                    "ok": False,
                    "patternId": pattern["patternId"],
                    "patternName": pattern["patternName"],
                    "error": reason,
                }
            )
        else:
            reports.append({"ok": True, **_build_report(pattern, nails)})
    return reports


def validate(data: dict) -> list[dict]:
    """保存できる状態か確かめ、全パターンの計算結果を返す。"""
    reports = []
    for index, pattern in enumerate(data["patterns"], start=1):
        nails, reason = _nails_and_reason(pattern)
        if reason:
            name = pattern["patternName"] or f"パターン{index}"
            raise PanelShearError(f"「{name}」を計算できません: {reason}")
        reports.append(_build_report(pattern, nails))
    return reports


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


def _format_issued_on(value: str) -> str:
    """日付ピッカーの値（YYYY-MM-DD）を「2026年8月11日」にする。"""
    match = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", value or "")
    if not match:
        return value or ""
    year, month, day = (int(part) for part in match.groups())
    return f"{year}年{month}月{day}日"


def _draw_diagram(page: pdf_write.Page, box: tuple[float, float, float, float],
                  report: dict, pattern: dict):
    """釘配列図（面材の枠・釘・弾性中立軸）を box の中に描く。

    box は (x, y, width, height)。工学座標（x は右・y は上、原点は面材の
    左下）をそのまま PDF 座標へ写せるので、画面の SVG と違って上下の反転は
    要らない。釘が面材からはみ出す配列でも切り取らず、外接矩形に合わせて
    縮尺を決めて「はみ出していること」が見えるようにする。
    """
    x, y, width, height = box
    nails = report["nails"]
    panel_w = pattern["width"]
    panel_h = pattern["height"]
    if not nails or panel_w <= 0 or panel_h <= 0:
        return

    xs = [n["x"] for n in nails]
    ys = [n["y"] for n in nails]
    min_x, max_x = min(0.0, *xs), max(panel_w, *xs)
    min_y, max_y = min(0.0, *ys), max(panel_h, *ys)
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
    result = report["result"]
    axis_x, axis_y = to_x(result["x0"]), to_y(result["y0"])
    page.line(axis_x, to_y(min_y), axis_x, to_y(max_y), 0.6, 0.35, dash=(3, 2))
    page.line(to_x(min_x), axis_y, to_x(max_x), axis_y, 0.6, 0.35, dash=(3, 2))
    page.text(axis_x, to_y(max_y) + 4, f"x0={significant(result['x0'], 4)}", 6.5,
              align="center", gray=0.35)
    page.text(to_x(max_x) + 3, axis_y - 2, f"y0={significant(result['y0'], 4)}", 6.5,
              gray=0.35)

    # 座標の目盛（重複を除いた昇順）。
    for value in sorted(set(xs)):
        position = to_x(value)
        page.line(position, origin_y - 3, position, origin_y, 0.4, 0.6)
        page.text(position, origin_y - 11, format_int(value), 6, align="center",
                  gray=0.45)
    for value in sorted(set(ys)):
        position = to_y(value)
        page.line(origin_x - 3, position, origin_x, position, 0.4, 0.6)
        page.text(origin_x - 5, position - 2, format_int(value), 6, align="right",
                  gray=0.45)

    for nail in nails:
        page.circle(to_x(nail["x"]), to_y(nail["y"]), 1.8, 0.3, 0.2, fill_gray=0.2)


def _draw_page(page: pdf_write.Page, data: dict, pattern: dict, report: dict,
               index: int, total: int):
    left = _MARGIN
    right = page.width - _MARGIN
    cursor = page.height - _MARGIN

    # --- 見出し ---
    page.text(left, cursor - 14, _TITLE, 14)
    cursor -= 20
    page.text(left, cursor - 8, _SUBTITLE, 6.5, gray=0.4)
    cursor -= 14
    page.line(left, cursor, right, cursor, 0.8, 0.3)
    cursor -= 16

    # --- 物件・パターン ---
    page.text(left, cursor, "物件名", 8, gray=0.45)
    page.text(left + 52, cursor, data["projectName"] or "（未入力）", 9.5)
    issued = _format_issued_on(data["issuedOn"])
    if issued:
        page.text(right, cursor, f"作成日: {issued}", 8.5, align="right", gray=0.3)
    cursor -= 14
    page.text(left, cursor, "パターン", 8, gray=0.45)
    page.text(left + 52, cursor, pattern["patternName"] or f"パターン{index}", 9.5)
    page.text(right, cursor, f"{index} / {total}", 8.5, align="right", gray=0.3)
    cursor -= 20

    # --- 1. 入力 ---
    cursor = _draw_section(page, left, right, cursor, "1. 入力")
    for row in report["inputs"]:
        page.text(left + 8, cursor, row["label"], 8.5, gray=0.45)
        page.text(left + 130, cursor, row["value"], 9)
        cursor -= 13
    cursor -= 8

    # --- 2. 計算結果 ---
    cursor = _draw_section(page, left, right, cursor, "2. 釘配列諸定数")
    box_width = (right - left - 16) / 3
    for position, item in enumerate(report["summary"]):
        box_x = left + position * (box_width + 8)
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
    _draw_diagram(
        page, (left, diagram_bottom, right - left, cursor - diagram_bottom + 6),
        report, pattern,
    )

    # --- 脚注 ---
    page.line(left, _MARGIN + 16, right, _MARGIN + 16, 0.3, 0.7)
    page.text(left, _MARGIN + 6, _FOOTNOTE, 6.5, gray=0.45)
    page.text(right, _MARGIN + 6, f"{index} / {total}", 6.5, align="right", gray=0.45)


def _draw_section(page: pdf_write.Page, left: float, right: float, cursor: float,
                  title: str) -> float:
    """節の見出しを描き、次に書き始める y を返す。"""
    page.text(left, cursor, title, 9.5)
    page.line(left, cursor - 5, right, cursor - 5, 0.5, 0.55)
    return cursor - 20


def build_pdf(data: dict, reports: list[dict]) -> bytes:
    """計算書 PDF を組み立てる（1 ページ = 1 パターン）。

    再編集のため、フォーム入力そのものを文書情報へ埋め込む
    （構造計算安全証明書と同じ仕組み）。ensure_ascii のままにして
    PDF の文字コードの差異を避ける。
    """
    document = pdf_write.Document()
    total = len(reports)
    for index, (pattern, report) in enumerate(zip(data["patterns"], reports), start=1):
        page = document.add_page()
        _draw_page(page, data, pattern, report, index, total)

    title = _TITLE + (f"（{data['projectName']}）" if data["projectName"] else "")
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


def form_config() -> dict:
    """画面が必要とする既定値を配信する（ファイル名の組み立てと計算例）。"""
    return {
        "default_file_name": DEFAULT_FILE_NAME,
        "file_name_template": FILE_NAME_TEMPLATE,
        "example": EXAMPLE_PATTERN,
        "max_patterns": MAX_PATTERNS,
    }
