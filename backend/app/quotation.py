"""見積書 作成ツールの PDF の組み立てと解析、共有設定の整え。

構造計算安全証明書のような「雛形のある帳票」ではなく、明細の数だけ行が伸びる
書面なので、Google ドキュメントの雛形は使わずバックエンドが直接組み立てる
（釘配列諸定数の計算書と同じ作法。app/pdf_write.py）。

**成果物の PDF そのものが保存形式**で、フォーム入力は PDF の文書情報へ
埋め込む。保存した見積書を開き直せば、そのまま続きを編集できる（枝番の
見積書を作るときも、元の PDF を開いて番号と金額を直すだけで済む）。

金額の計算・摘要の組み立て・既定のファイル名は、すべて唯一の計算実装
（core/src/quotation.rs → wasm）が決める。画面もこの同じバイト列を動かすので、
**入力のたびに画面へ出る金額と、PDF に刷られる金額が別々の実装から出てくる
ことがない**。保存時にはサーバでも計算し直し、画面の値と突き合わせる。

印字するのは、**フォームが持っている値だけ**。事務所の名称や定型文は共有設定
（Firestore）から初期値として配るが、生成のときに設定を読み直したりはしない
（docs/contract-formatter.md §7「印字する値はマスタを参照せず、入力された値を
使います」）。設定を後から変えても、過去の見積書の再現性は壊れない。
"""

import json
import math
import re

from . import nail_core, pdf_tools, pdf_write
from .errors import PortalError
from .nail_core import CoreError

# 文書情報に入れる独自キー（このツールが作った PDF の目印にもなる）。
METADATA_KEY = "/PortalQuotation"

DEFAULT_FILE_NAME = "見積書.pdf"

# ファイル名に使えない文字（Drive 上でも扱いづらいもの）。
_UNSAFE_FILE_NAME_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')

# 画面の計算結果とサーバの計算結果を「同じ」とみなす差（円）。
#
# 同じ .wasm を同じ引数で動かすので、本来は 1 円も違わない。0 にしてあるのは、
# 金額が整数で確定するため（丸め誤差という概念が無い）。
VERIFY_TOLERANCE_YEN = 0

# 突き合わせる金額の項目。
_VERIFIED_TOTALS = (("subtotal", "小計"), ("tax", "消費税"), ("total", "合計"))


class QuotationError(PortalError):
    """入力・生成・解析の失敗。message は利用者に表示できる日本語文。"""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message, status)


# --- 計算（唯一の実装である wasm へ委譲する） -------------------------------


def _core(operation: str, data: dict | None = None) -> dict:
    """計算実装を呼ぶ。失敗はそのまま利用者に見せられる 400 にする。"""
    request = {"op": operation}
    if data is not None:
        request["data"] = data
    try:
        return nail_core.call(request)
    except CoreError as error:
        raise QuotationError(str(error)) from error


def normalize_data(data) -> dict:
    """受け取った本文を、このツールが扱う形へ整える。

    知らないキーは捨て、明細は 1 行以上に整える。入力欄の文字列をどう読むか
    （「284,000」を 284000 と読む、など）も計算実装に任せる。
    """
    return _core("quotationNormalize", data if isinstance(data, dict) else {})["data"]


def compute(data: dict) -> dict:
    """明細の金額・消費税・合計と、既定のファイル名を求める。"""
    return _core("quotation", data)


def validate(data: dict) -> dict:
    """書面として成り立たない入力を弾く（欠けていれば PDF を作らせない）。"""
    _core("quotationValidate", data)
    return compute(data)


def suggest(data: dict, terms: str) -> list:
    """品名と摘要の候補を組み立てる（画面が入力のたびに呼ぶ）。"""
    request = dict(data)
    request["terms"] = terms
    return _core("quotationSuggest", request)["suggestions"]


def seismic_fee(data: dict) -> dict:
    """平成27年国土交通省告示第670号による、耐震診断・耐震補強設計の参考額。"""
    return _core("seismicFee", data)


def verify(computed: dict, claim) -> dict:
    """画面が出していた金額と、サーバの計算を突き合わせる。

    食い違っても保存は止めない（PDF に刷られるのはサーバの値）。画面に警告を
    出させるための材料を返す。
    """
    if not isinstance(claim, dict):
        return {"checked": False, "ok": True, "differences": []}

    server_totals = computed.get("totals", {})
    client_totals = claim.get("totals") if isinstance(claim.get("totals"), dict) else {}

    differences = []
    for key, label in _VERIFIED_TOTALS:
        server_value = _as_int(server_totals.get(key))
        client_value = _as_int(client_totals.get(key))
        if abs(server_value - client_value) > VERIFY_TOLERANCE_YEN:
            differences.append(
                {"key": key, "label": label, "client": client_value, "server": server_value}
            )

    client_version = claim.get("coreVersion") or ""
    server_version = nail_core.version()
    return {
        "checked": True,
        "ok": not differences and client_version == server_version,
        "coreVersion": {"client": client_version, "server": server_version},
        "differences": differences,
    }


def _as_int(value) -> int:
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return 0


# --- 共有設定 ----------------------------------------------------------------
#
# ここに置くのは「事務所が決めたもの」だけ。告示に定めのある値（別表・倍数）は
# リポジトリの計算実装が持っている。分ける線は「原文があるかどうか」で、
# 理由は docs/contract-formatter.md §6・§8 にある。
#
# **リポジトリ側の既定値は空**にしてある。事務所の名称も定型文も単価も、
# 公開リポジトリに置かないという決めごとのため（同 §8）。設定するまでは、
# 画面がその旨を出す。

# 消費税率は法定の税率であって事務所が決めた値ではないので、既定を置く。
DEFAULT_TAX_RATE = 10.0
DEFAULT_REDUCED_TAX_RATE = 8.0

# 直接経費 + 間接経費の倍数の既定（告示第670号 第四 ロ の標準値 1.0）。
DEFAULT_OVERHEAD_MULTIPLIER = 1.0

_OFFICE_KEYS = ("name", "postalCode", "address", "tel", "personName")
_TERMS_KEYS = ("design", "seismic")
_ROUNDINGS = ("floor", "round", "ceil")


def default_settings() -> dict:
    return {
        "office": {key: "" for key in _OFFICE_KEYS},
        "terms": {key: "" for key in _TERMS_KEYS},
        "remarks": "",
        "fee": {
            "taxRate": DEFAULT_TAX_RATE,
            "reducedTaxRate": DEFAULT_REDUCED_TAX_RATE,
            "taxRounding": "floor",
            "personnelUnitPrice": 0,
            "technicalFeeRate": 0.0,
            "overheadMultiplier": DEFAULT_OVERHEAD_MULTIPLIER,
        },
    }


def normalize_settings(values) -> dict:
    """画面から届いた設定を、保存できる形へ整える。

    知らないキーは捨てる。Firestore に入るものが、そのまま次に配られる。
    """
    values = values if isinstance(values, dict) else {}
    settings = default_settings()

    office = values.get("office")
    if isinstance(office, dict):
        for key in _OFFICE_KEYS:
            settings["office"][key] = _clean_text(office.get(key))

    terms = values.get("terms")
    if isinstance(terms, dict):
        for key in _TERMS_KEYS:
            settings["terms"][key] = _clean_multiline(terms.get(key))

    settings["remarks"] = _clean_multiline(values.get("remarks"))

    fee = values.get("fee")
    if isinstance(fee, dict):
        target = settings["fee"]
        target["taxRate"] = _clean_rate(fee.get("taxRate"), DEFAULT_TAX_RATE)
        target["reducedTaxRate"] = _clean_rate(
            fee.get("reducedTaxRate"), DEFAULT_REDUCED_TAX_RATE
        )
        rounding = _clean_text(fee.get("taxRounding"))
        target["taxRounding"] = rounding if rounding in _ROUNDINGS else "floor"
        target["personnelUnitPrice"] = max(0, _as_int(fee.get("personnelUnitPrice")))
        target["technicalFeeRate"] = _clean_rate(fee.get("technicalFeeRate"), 0.0)
        target["overheadMultiplier"] = _clean_rate(
            fee.get("overheadMultiplier"), DEFAULT_OVERHEAD_MULTIPLIER
        )
    return settings


def stored_settings(stored) -> dict:
    """Firestore に入っているものを、画面へ配る形にする（欠けは既定で埋める）。"""
    return normalize_settings(stored)


def _clean_text(value) -> str:
    return str(value).strip() if isinstance(value, (str, int, float)) else ""


def _clean_multiline(value) -> str:
    if not isinstance(value, str):
        return ""
    return "\n".join(line.rstrip() for line in value.splitlines()).strip("\n")


def _clean_rate(value, fallback: float) -> float:
    """率・倍数の欄を読む。読めない値・負の値は既定へ倒す。

    float() は "nan" や "inf" という文字列も受け付けてしまう（画面から届く
    のは文字列）。そのまま設定に入ると税額が NaN になるので、有限の値だけを
    通す。
    """
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(number) or number < 0:
        return fallback
    return number


# --- ファイル名 --------------------------------------------------------------


def default_file_name(computed: dict) -> str:
    """既定のファイル名。組み立てるのは計算実装（画面と同じ文字列になる）。"""
    return ensure_pdf_extension(computed.get("defaultFileName") or DEFAULT_FILE_NAME)


def ensure_pdf_extension(name: str) -> str:
    name = _UNSAFE_FILE_NAME_CHARS.sub("", (name or "").strip()).strip().strip(".")
    if not name:
        return DEFAULT_FILE_NAME
    return name if name.lower().endswith(".pdf") else name + ".pdf"


# --- 見積書 PDF の組み立て ---------------------------------------------------

_MARGIN = 42.5  # 15mm
_TITLE = "御見積書"

# 明細表の列。幅の合計が本文の幅（595.28 - 42.5 × 2 = 510.28）になる。
_COLUMN_ITEM = 285.28
_COLUMN_UNIT_PRICE = 80.0
_COLUMN_QUANTITY = 45.0
_COLUMN_AMOUNT = 100.0

_TITLE_SIZE = 20.0
_ITEM_TITLE_SIZE = 10.0
_BODY_SIZE = 8.0
_BODY_LEADING = 11.0
_ROW_PADDING = 6.0

# 行頭に置かない文字（最小限の禁則処理。あふれさせて前の行へぶら下げる）。
_NO_LINE_START = "、。，．）］｝」』〉》”’!?！？：；・ー%％"


def _wrap(font: pdf_write.Font, text: str, size: float, width: float) -> list[str]:
    """欄の幅に収まるように折り返す。

    日本語には単語の区切りが無いので、原則は 1 文字ずつ詰めて折り返す。
    行頭に置けない文字（句読点・閉じ括弧）は、あふれさせて前の行に残す。
    """
    lines: list[str] = []
    for paragraph in text.split("\n"):
        if not paragraph:
            lines.append("")
            continue
        current = ""
        for character in paragraph:
            if current and font.text_width(current + character, size) > width:
                if character in _NO_LINE_START:
                    lines.append(current + character)
                    current = ""
                    continue
                lines.append(current)
                current = character
            else:
                current += character
        if current:
            lines.append(current)
    return lines


def _address_lines(font: pdf_write.Font, data: dict, width: float) -> list[tuple[str, float]]:
    """宛先のブロック（文字列と大きさの並び）。"""
    client = data.get("client", {})
    lines: list[tuple[str, float]] = []

    addressee = " ".join(
        part for part in (client.get("name", ""), client.get("honorific", "")) if part
    )
    if addressee:
        for line in _wrap(font, addressee, 12.5, width):
            lines.append((line, 12.5))
    if client.get("postalCode"):
        lines.append((f"〒{client['postalCode']}", 8.5))
    for line in _wrap(font, client.get("address", ""), 9.5, width):
        if line:
            lines.append((line, 9.5))
    if client.get("department"):
        for line in _wrap(font, client["department"], 9.5, width):
            lines.append((line, 9.5))
    contact = " ".join(
        part
        for part in (client.get("contactName", ""), client.get("contactHonorific", ""))
        if part
    )
    if contact:
        lines.append((contact, 10.5))
    return lines


def _issuer_lines(font: pdf_write.Font, data: dict, width: float) -> list[tuple[str, float]]:
    """発行元のブロック。"""
    issuer = data.get("issuer", {})
    lines: list[tuple[str, float]] = []
    for line in _wrap(font, issuer.get("name", ""), 10.5, width):
        if line:
            lines.append((line, 10.5))
    if issuer.get("postalCode"):
        lines.append((f"〒{issuer['postalCode']}", 8.0))
    for line in _wrap(font, issuer.get("address", ""), 8.5, width):
        if line:
            lines.append((line, 8.5))
    if issuer.get("tel"):
        lines.append((f"TEL: {issuer['tel']}", 8.5))
    if issuer.get("personName"):
        lines.append((issuer["personName"], 9.5))
    return lines


def _item_lines(
    font: pdf_write.Font, item: dict, width: float
) -> tuple[list[str], list[str]]:
    """明細 1 行の、品名と摘要の折り返し済みの行。"""
    title = _wrap(font, item.get("title", ""), _ITEM_TITLE_SIZE, width)
    body = [
        line
        for line in _wrap(font, item.get("body", ""), _BODY_SIZE, width - 8)
        if line != ""
    ]
    return title, body


def _item_height(item: dict, title: list[str], body: list[str]) -> float:
    height = (
        len(title) * (_ITEM_TITLE_SIZE + 3.5)
        + len(body) * _BODY_LEADING
        + _ROW_PADDING * 2
    )
    # 税の区分の但し書き（「（対象外）」など）は金額の下に出るので、その分だけ
    # 行の高さを確保する。確保しないと、罫線が但し書きの上に載る。
    if _tax_note(item):
        height = max(height, _ROW_PADDING * 2 + _ITEM_TITLE_SIZE + 15.0)
    return height


def _tax_note(item: dict) -> str:
    """金額の下に出す、税の区分の但し書き（標準税率なら出さない）。"""
    return {"exempt": "（対象外）", "reduced": "（軽減税率）"}.get(
        item.get("taxCategory", ""), ""
    )


def _totals_rows(computed: dict) -> list[tuple[str, str, bool]]:
    """合計欄に並べる行 (見出し, 金額, 強調するか)。"""
    totals = computed.get("totals", {})
    rows = [
        ("小計", totals.get("subtotalText", "0"), False),
        ("消費税", totals.get("taxText", "0"), False),
        ("合計", totals.get("totalText", "0"), True),
    ]
    for bucket in totals.get("buckets", []):
        rows.append((f"内訳 {bucket.get('label', '')}", bucket.get("baseText", "0"), False))
        if bucket.get("category") != "exempt":
            rows.append(("　消費税", bucket.get("taxText", "0"), False))
    return rows


def _remarks_height(font: pdf_write.Font, data: dict, width: float) -> float:
    remarks = data.get("remarks", "")
    if not remarks:
        return 0.0
    return 18.0 + len(_wrap(font, remarks, _BODY_SIZE, width)) * _BODY_LEADING + 8.0


def build_pdf(data: dict, computed: dict) -> bytes:
    """見積書 PDF を組み立てる。

    明細が多ければ頁を送る。合計欄と備考は最後の頁に置き、そこへ収まらなければ
    もう 1 頁足す（合計欄が途中で切れた見積書を作らないため）。

    再編集のため、フォーム入力そのものを文書情報へ埋め込む
    （構造計算安全証明書・釘配列諸定数の計算書と同じ仕組み）。
    """
    document = pdf_write.Document()
    font = document.font
    width = _COLUMN_ITEM - 8

    items = data.get("items", [])
    amounts = computed.get("items", [])
    measured = []
    for index, item in enumerate(items):
        title, body = _item_lines(font, item, width)
        amount = amounts[index] if index < len(amounts) else {}
        measured.append((item, amount, title, body, _item_height(item, title, body)))

    # --- 頁割り（描く前に決める。頁数が「1 / 2」の表示に要る） ---
    body_width = pdf_write.A4_PORTRAIT[0] - _MARGIN * 2
    first_top = _header_height(font, data, body_width)
    later_top = _compact_header_height()
    bottom = _MARGIN + 14.0  # 頁番号の分
    totals_block = 24.0 + len(_totals_rows(computed)) * 15.0
    totals_block += _remarks_height(font, data, body_width)

    available = pdf_write.A4_PORTRAIT[1] - first_top - bottom
    pages: list[list] = [[]]
    for entry in measured:
        if entry[4] > available and pages[-1]:
            pages.append([])
            available = pdf_write.A4_PORTRAIT[1] - later_top - bottom
        pages[-1].append(entry)
        available -= entry[4]
    if available < totals_block:
        pages.append([])

    # --- 描く ---
    for index, page_items in enumerate(pages):
        page = document.add_page()
        first = index == 0
        cursor = (
            _draw_header(page, data, computed, body_width)
            if first
            else _draw_compact_header(page, data)
        )
        cursor = _draw_table_header(page, cursor)
        for item, amount, title, body, height in page_items:
            cursor = _draw_item(page, cursor, item, amount, title, body, height)
        if index == len(pages) - 1:
            cursor = _draw_totals(page, cursor, computed)
            _draw_remarks(page, cursor, data, body_width)
        _draw_page_number(page, index + 1, len(pages))

    number = data.get("number", "")
    title = f"{_TITLE} {number}".strip()
    return document.to_bytes(
        {
            "Title": title,
            METADATA_KEY: json.dumps(data, sort_keys=True),
        }
    )


def _header_height(font: pdf_write.Font, data: dict, width: float) -> float:
    """1 頁目の頭（表題・宛先・発行元・件名・御見積金額）の高さ。"""
    column = width / 2 - 14
    blocks = max(
        sum(size + 4.0 for _, size in _address_lines(font, data, column)),
        sum(size + 3.0 for _, size in _issuer_lines(font, data, column)) + 48.0,
    )
    return _MARGIN + _TITLE_SIZE + 26.0 + blocks + 62.0


def _compact_header_height() -> float:
    return _MARGIN + 40.0


def _draw_header(page: pdf_write.Page, data: dict, computed: dict, width: float) -> float:
    left = _MARGIN
    right = page.width - _MARGIN
    cursor = page.height - _MARGIN

    page.text(page.width / 2, cursor - _TITLE_SIZE, _TITLE, _TITLE_SIZE, align="center")
    cursor -= _TITLE_SIZE + 26.0

    column = width / 2 - 14
    right_x = left + width / 2 + 14

    # 左: 宛先。
    address_y = cursor
    for line, size in _address_lines(page.font, data, column):
        page.text(left, address_y - size, line, size)
        address_y -= size + 4.0

    # 右: 番号と日付、そのあとに発行元。
    meta_y = cursor
    for label, value in (
        ("見積書番号", data.get("number", "")),
        ("発行日", _date(data.get("issuedOn", ""))),
        ("有効期限", _date(data.get("expiresOn", ""))),
    ):
        if not value:
            continue
        page.text(right_x, meta_y - 9, f"{label}：", 8.5, gray=0.4)
        page.text(right, meta_y - 9, value, 9.5, align="right")
        meta_y -= 14.0
    meta_y -= 12.0
    for line, size in _issuer_lines(page.font, data, column):
        page.text(right_x, meta_y - size, line, size)
        meta_y -= size + 3.0

    cursor = min(address_y, meta_y) - 18.0

    # 件名と御見積金額。
    page.text(left, cursor - 11, "件名：", 9.5, gray=0.4)
    page.text(left + 36, cursor - 11, data.get("subject", ""), 11.0)
    cursor -= 30.0

    total = computed.get("totals", {}).get("totalText", "0")
    page.text(left, cursor - 16, "御見積金額", 10.0, gray=0.35)
    amount_width = page.text(left + 74, cursor - 17, total, 19.0)
    page.text(left + 78 + amount_width, cursor - 17, "円", 11.0)
    page.line(left, cursor - 24, left + 86 + amount_width, cursor - 24, 0.8, 0.2)
    cursor -= 40.0
    return cursor


def _draw_compact_header(page: pdf_write.Page, data: dict) -> float:
    """2 頁目以降の頭。どの見積書の続きかが分かるだけの最小限にする。"""
    left = _MARGIN
    right = page.width - _MARGIN
    cursor = page.height - _MARGIN

    page.text(left, cursor - 12, _TITLE, 12.0)
    number = data.get("number", "")
    if number:
        page.text(left + 52, cursor - 12, f"見積書番号：{number}", 8.5, gray=0.4)
    page.text(right, cursor - 12, data.get("subject", ""), 9.5, align="right")
    return cursor - 40.0


def _draw_table_header(page: pdf_write.Page, cursor: float) -> float:
    left = _MARGIN
    right = page.width - _MARGIN
    page.rect(left, cursor - 17, right - left, 17, 0.5, 0.55, fill_gray=0.94)
    page.text(left + 8, cursor - 12, "項目", 8.5, gray=0.25)
    edges = _column_edges(page)
    for label, edge in zip(("単価", "数量", "金額"), edges):
        page.text(edge - 6, cursor - 12, label, 8.5, align="right", gray=0.25)
    return cursor - 17


def _column_edges(page: pdf_write.Page) -> tuple[float, float, float]:
    """単価・数量・金額の各列の右端。"""
    left = _MARGIN
    unit_price = left + _COLUMN_ITEM + _COLUMN_UNIT_PRICE
    quantity = unit_price + _COLUMN_QUANTITY
    return unit_price, quantity, quantity + _COLUMN_AMOUNT


def _draw_item(
    page: pdf_write.Page,
    cursor: float,
    item: dict,
    amount: dict,
    title: list[str],
    body: list[str],
    height: float,
) -> float:
    left = _MARGIN
    right = page.width - _MARGIN
    top = cursor
    text_y = cursor - _ROW_PADDING

    for line in title:
        page.text(left + 8, text_y - _ITEM_TITLE_SIZE, line, _ITEM_TITLE_SIZE)
        text_y -= _ITEM_TITLE_SIZE + 3.5
    for line in body:
        page.text(left + 16, text_y - _BODY_SIZE, line, _BODY_SIZE, gray=0.3)
        text_y -= _BODY_LEADING

    unit_price_x, quantity_x, amount_x = _column_edges(page)
    value_y = cursor - _ROW_PADDING - _ITEM_TITLE_SIZE
    page.text(unit_price_x - 6, value_y, amount.get("unitPriceText", ""), 9.5, align="right")
    page.text(quantity_x - 6, value_y, amount.get("quantityText", ""), 9.5, align="right")
    page.text(amount_x - 6, value_y, amount.get("amountText", ""), 9.5, align="right")
    note = _tax_note(item)
    if note:
        page.text(amount_x - 6, value_y - 11, note, 7.0, align="right", gray=0.45)

    bottom = top - height
    page.line(left, bottom, right, bottom, 0.4, 0.75)
    # 金額の列を、表の縦罫として区切る。
    for edge in (left + _COLUMN_ITEM, unit_price_x, quantity_x):
        page.line(edge, top, edge, bottom, 0.4, 0.8)
    return bottom


def _draw_totals(page: pdf_write.Page, cursor: float, computed: dict) -> float:
    right = page.width - _MARGIN
    label_x = right - 190
    cursor -= 18.0
    for label, value, emphasised in _totals_rows(computed):
        size = 11.0 if emphasised else 9.0
        page.text(label_x, cursor - size, label, 9.0, gray=0.35)
        page.text(right - 18, cursor - size, value, size, align="right")
        page.text(right, cursor - size, "円", 8.5, align="right", gray=0.4)
        if emphasised:
            page.line(label_x, cursor + 2, right, cursor + 2, 0.6, 0.3)
        cursor -= 15.0
    return cursor - 10.0


def _draw_remarks(page: pdf_write.Page, cursor: float, data: dict, width: float) -> None:
    remarks = data.get("remarks", "")
    if not remarks:
        return
    left = _MARGIN
    page.text(left, cursor - 9, "備考", 8.5, gray=0.35)
    cursor -= 18.0
    for line in _wrap(page.font, remarks, _BODY_SIZE, width):
        page.text(left, cursor - _BODY_SIZE, line, _BODY_SIZE, gray=0.25)
        cursor -= _BODY_LEADING


def _draw_page_number(page: pdf_write.Page, number: int, total: int) -> None:
    page.text(
        page.width - _MARGIN,
        _MARGIN - 4,
        f"{number} / {total}",
        8.0,
        align="right",
        gray=0.45,
    )


def _date(value: str) -> str:
    """YYYY-MM-DD を書面の表記（YYYY/MM/DD）にする。"""
    parts = (value or "").split("-")
    if len(parts) == 3 and all(part.isdigit() for part in parts):
        return f"{parts[0]}/{parts[1]}/{parts[2]}"
    return value or ""


# --- PDF の解析（読み込み） --------------------------------------------------


def parse_pdf(pdf_bytes: bytes) -> dict:
    """保存済みの見積書 PDF を読み、フォームへ流し込めるデータを返す。

    本文のレイアウトはいつでも変えてよいものとして扱うため、復元は文書情報へ
    埋め込んだフォーム入力だけから行う（本文からの推定はしない）。このツールが
    作った PDF でなければ、その旨をはっきり伝えて止める。
    """
    if not pdf_bytes:
        raise QuotationError("PDF ファイルが空です。")
    if pdf_bytes.lstrip()[:5] != b"%PDF-":
        raise QuotationError("PDF ファイルではないようです。")

    raw = pdf_tools.read_metadata_value(pdf_bytes, METADATA_KEY)
    if not raw:
        raise QuotationError(
            "このツールで作成した見積書 PDF ではないため、読み込めません"
            "（入力内容は作成時に PDF へ埋め込まれます）。"
        )
    try:
        stored = json.loads(raw)
    except ValueError as error:
        raise QuotationError(
            "見積書 PDF に埋め込まれた入力内容を読み取れませんでした。"
        ) from error
    return normalize_data(stored)


# --- フォーム定義 ------------------------------------------------------------


def form_config(core_path: str) -> dict:
    """画面が入力欄を組み立てるのに要るものを配る。

    業務のテンプレートも選択肢も、単一の情報源である計算実装が持っている。
    編集中の計算は画面が行うため、その wasm の在り処もここで知らせる。
    """
    digest = nail_core.sha256()
    definition = _core("quotationForm")
    definition.pop("ok", None)
    return {
        **definition,
        "default_file_name": DEFAULT_FILE_NAME,
        "core": {
            "url": f"{core_path}?v={digest[:16]}",
            "version": nail_core.version(),
            "sha256": digest,
        },
    }
