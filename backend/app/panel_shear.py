"""面材張り耐力要素 釘配列諸定数 計算ツールの保存・計算書 PDF の生成と解析。

GAS 版（gas-timber-panel-shear-calculator）はスプレッドシートへ「現在値 +
履歴」を書き出していたが、本ポータルでは構造計算安全証明書と同じ考え方に
そろえ、**成果物の PDF そのものを保存形式**にする。フォーム入力を PDF の
文書情報へ埋め込むので、保存した PDF を開き直せば入力内容を完全に復元して
続きを編集できる（スプレッドシートも履歴タブも持たない）。

計算・入力の解釈・表示する桁の丸めは nail_core（Rust 製の wasm）に委譲する。
画面もまったく同じ .wasm を動かすので、実装は 1 つしかない。このモジュールが
受け持つのは、その結果を PDF に組む仕事と、保存時の突き合わせ（verify）。

1 PDF = 1 物件、1 ページ = 1 パターン。
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


# --- 計算（唯一の実装である wasm へ委譲する） -------------------------------


def _core(operation: str, data: dict) -> dict:
    """計算実装を呼ぶ。失敗はそのまま利用者に見せられる 400 にする。"""
    try:
        return nail_core.call({"op": operation, "data": data})
    except CoreError as error:
        raise PanelShearError(str(error)) from error


def normalize_data(data) -> dict:
    """API で受け取った本文を、このツールが扱う形へ整える。

    未知のキーは捨て、パターンは 1 つ以上に整える（空のフォームでも
    「パターンが 1 つある」状態から始められるようにする）。入力欄の文字列を
    どう読むかは計算そのものと地続きなので、ここも計算実装に任せる。
    """
    return _core("normalize", data)["data"]


def compute_all(data: dict) -> list[dict]:
    """全パターンを計算する。計算できないパターンは ok: False で返す。

    1 つのパターンの不備で他のパターンの結果まで失わせない
    （保存時は validate() で改めて全件を確かめる）。
    """
    return _core("computeAll", data)["patterns"]


def validate(data: dict) -> list[dict]:
    """保存できる状態か確かめ、全パターンの計算結果を返す。"""
    return _core("validate", data)["patterns"]


# --- 保存時の突き合わせ ------------------------------------------------------


def _is_close(client, server) -> bool:
    """画面の値とサーバの値を「同じ」とみなせるか。"""
    if not isinstance(client, (int, float)) or isinstance(client, bool):
        return False
    difference = abs(float(client) - float(server))
    scale = max(1.0, abs(float(client)), abs(float(server)))
    return difference <= VERIFY_RELATIVE_TOLERANCE * scale


def verify(reports: list[dict], claim) -> dict:
    """画面が出した計算結果と、サーバの計算結果を突き合わせる。

    編集中の計算は画面（wasm）が行うので、保存する計算書と画面で見ていた値が
    同じであることを、保存のたびにサーバ側でも確かめる。同じ .wasm を動かして
    いる以上ふつうは一致するが、次のような食い違いはここで拾える:

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
    claimed = {
        str(entry.get("patternId")): entry.get("result")
        for entry in claim.get("patterns") or []
        if isinstance(entry, dict)
    }

    differences = []
    for report in reports:
        client_result = claimed.get(report["patternId"])
        if not isinstance(client_result, dict):
            differences.append(
                {
                    "patternId": report["patternId"],
                    "patternName": report["patternName"],
                    "key": "(計算結果なし)",
                    "client": "-",
                    "server": "計算済み",
                }
            )
            continue
        for key, server_value in report["result"].items():
            client_value = client_result.get(key)
            if not _is_close(client_value, server_value):
                differences.append(
                    {
                        "patternId": report["patternId"],
                        "patternName": report["patternName"],
                        "key": key,
                        "client": client_value,
                        "server": server_value,
                    }
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
    要らない。描く範囲と目盛の文字は計算実装が決めたもの（report["diagram"]）
    を使う。画面の SVG も同じものを読むので、縮尺だけが違う同じ図になる。
    """
    x, y, width, height = box
    nails = report["nails"]
    diagram = report["diagram"]
    panel_w = pattern["width"]
    panel_h = pattern["height"]
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


def form_config(core_path: str) -> dict:
    """画面が必要とする既定値を配信する（ファイル名の組み立てと計算例）。

    編集中の計算は画面が行うため、計算実装（wasm）の在り処もここで知らせる。
    URL に中身のハッシュを付けるので、実装が変われば画面は必ず新しいものを
    取りに行き、変わらないうちはブラウザのキャッシュから読む。
    """
    digest = nail_core.sha256()
    return {
        "default_file_name": DEFAULT_FILE_NAME,
        "file_name_template": FILE_NAME_TEMPLATE,
        "example": EXAMPLE_PATTERN,
        "max_patterns": nail_core.config()["maxPatterns"],
        "core": {
            "url": f"{core_path}?v={digest[:16]}",
            "version": nail_core.version(),
            "sha256": digest,
        },
    }
