"""小規模木造建築物 必要壁量 計算ツール（表計算ツールへの記入）。

公益財団法人日本住宅・木材技術センターが配布している「壁量等の基準
(令和7年施行)に対応した表計算ツール（多機能版）」は、値を入力したものを
そのまま提出するよう求められることがある。そこでこのツールは、

  1. 同梱した配布物（app/templates/wall-quantity/worksheet.xlsx）を複製し、
  2. フォーム入力を、配布物の入力欄（緑の枠）へそのまま書き込み、
  3. **Excel 形式のまま** 返す

という素直な作りにしている。提出物は「配布物に値を入れたもの」そのもので、
受け取る側が見慣れた表計算ツールのままになる。**配布物の数式は書き換えない**
ので、Excel で開いた時点の計算結果も配布物のものそのまま。

そのうえで、配布物の数式を Rust（core/src/wall_quantity.rs）へ写してあり、

  - 画面は入力のたびにその wasm で計算して「出力結果」を出す
    （xlsx をダウンロードして Excel で開くまで待たなくてよい）
  - 保存のときはサーバも同じ wasm で計算し、画面が出していた値と
    突き合わせる（verify）

という形にしている。この計算は今後、配布物どおりではない計算へ広げる予定
なので、面材張り大壁と同じく Rust → wasm に一本化してある。

書き込み位置・選択肢・条件は wall_quantity_mapping.json が単一の情報源で、
フォームの組み立てもそこから導く（excel_report.py と同じ考え方）。
配布物の複製に openpyxl を使わない理由は xlsx_fill.py の説明を参照。
"""

import json
import math
import os
import unicodedata

from . import nail_core, xlsx_fill
from .errors import PortalError
from .nail_core import CoreError
from .xlsx_fill import XlsxError, XlsxTemplate

_DIR = os.path.dirname(__file__)
_MAPPING_PATH = os.path.join(_DIR, "wall_quantity_mapping.json")

_MAPPING = None
_SOURCE = None
_TEMPLATE_BYTES = None

# 突き合わせの結果に並べる食い違いの上限（全部ずれていても応答が膨れないように）。
MAX_REPORTED_DIFFERENCES = 20


class WallQuantityError(PortalError):
    """入力起因の生成エラー。message は利用者に表示できる日本語文。"""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message, status)


def load_mapping() -> dict:
    global _MAPPING
    if _MAPPING is None:
        with open(_MAPPING_PATH, encoding="utf-8") as f:
            _MAPPING = json.load(f)
    return _MAPPING


def load_source() -> dict:
    """同梱している配布物の出所（版・取得元・sha256）。"""
    global _SOURCE
    if _SOURCE is None:
        path = os.path.join(_DIR, load_mapping()["template"]["source"])
        with open(path, encoding="utf-8") as f:
            _SOURCE = json.load(f)
    return _SOURCE


def template_bytes() -> bytes:
    """同梱している配布物そのもの。読むだけで、書き換えはしない。"""
    global _TEMPLATE_BYTES
    if _TEMPLATE_BYTES is None:
        path = os.path.join(_DIR, load_mapping()["template"]["path"])
        with open(path, "rb") as f:
            _TEMPLATE_BYTES = f.read()
    return _TEMPLATE_BYTES


def template_version() -> str:
    """配布物に印字されている版（例 ver1.2.1）を読む。

    出所ファイルに書いてある版ではなく **配布物そのもの** から読むので、
    ファイルを差し替えたのに版の記載を直し忘れる、が起こらない。
    """
    mapping = load_mapping()
    cell = mapping["template"]["version_cell"]
    building = _building(cell["building"])
    return XlsxTemplate(template_bytes()).cell_text(building["sheet"], cell["ref"]) or ""


# --- フォーム定義 -----------------------------------------------------------


def form_config(core_path: str) -> dict:
    """画面がフォームを組み立てるための定義を、マッピングから丸ごと配る。

    節・表・入力欄の並びも、選択肢も、条件も、書き込み先のセルも
    マッピングにしかない。画面側に定数を持たせないことで、配布物の改訂に
    「マッピングを直すだけ」で追従できるようにする。

    編集中の計算は画面が行うため、計算実装（wasm）の在り処もここで知らせる
    （面材張り大壁の /config と同じ仕組み。URL に中身のハッシュが付く）。
    """
    mapping = load_mapping()
    source = load_source()
    digest = nail_core.sha256()
    return {
        "core": {
            "url": f"{core_path}?v={digest[:16]}",
            "version": nail_core.version(),
            "sha256": digest,
        },
        "usage": mapping["usage"],
        "options": mapping["options"],
        "species": mapping["species"],
        "grade": mapping["grade"],
        "buildings": [
            {
                "key": b["key"],
                "label": b["label"],
                "sections": b["sections"],
            }
            for b in mapping["buildings"]
        ],
        "file_name": mapping["file_name"],
        "worksheet": {
            "name": source["name"],
            "publisher": source["publisher"],
            "pageUrl": source["page_url"],
            "version": template_version(),
        },
    }


def _building(key: str) -> dict:
    for b in load_mapping()["buildings"]:
        if b["key"] == key:
            return b
    raise WallQuantityError("建物の種別（平屋建て / 2階建て）が不正です。")


def _iter_fields(building: dict):
    """建物の全入力欄を (節, かたまり, 行 or None, 入力欄) で順に返す。"""
    for section in building["sections"]:
        for block in section.get("blocks", []):
            if block["kind"] == "fields":
                for f in block["fields"]:
                    yield section, block, None, f
            else:
                for row in block["rows"]:
                    for f in row["fields"]:
                        yield section, block, row, f


# --- 入力の正規化 -----------------------------------------------------------


def _normalize_text(value) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _to_number(value, label: str):
    """数値欄の値を数値にする。

    モバイルの日本語入力では全角の数字・記号が混じりやすいので、
    excel_report.py と同じく NFKC で半角へ寄せてから解釈する。
    数値にならない文字列は、黙って文字列のまま書いて配布物の数式を
    壊すより、その場で理由を返した方がよいので拒否する。
    """
    text = unicodedata.normalize("NFKC", _normalize_text(value))
    if text == "":
        return None
    try:
        number = float(text)
    except ValueError:
        raise WallQuantityError(f"「{label}」には数値を入力してください。")
    if not math.isfinite(number):
        raise WallQuantityError(f"「{label}」には数値を入力してください。")
    return int(number) if number == int(number) else number


def _condition_met(condition, values: dict) -> bool:
    if not condition:
        return True
    actual = values.get(condition["field"])
    actual = "" if actual is None else actual
    if "in" in condition:
        return actual in condition["in"]
    if "not_in" in condition:
        return actual not in condition["not_in"]
    return True


def normalize_data(body: dict) -> dict:
    """リクエストの入力を、扱いやすい形（key → 値）へ整える。"""
    body = body if isinstance(body, dict) else {}
    building_key = _normalize_text(body.get("building"))
    building = _building(building_key)

    usage = _normalize_text(body.get("usage"))
    allowed = [o["value"] for o in load_mapping()["usage"]["options"]]
    if usage not in allowed:
        raise WallQuantityError(
            "「0. 設計の用途」を 1 つ選んでください。", 400
        )

    raw = body.get("values")
    raw = raw if isinstance(raw, dict) else {}

    values: dict = {"usage": usage}
    for _section, _block, _row, field in _iter_fields(building):
        key = field["key"]
        if field["type"] == "number":
            values[key] = _to_number(raw.get(key), field["label"])
        else:
            values[key] = _normalize_text(raw.get(key))

    # 算定方法のチェックボックスは、条件の判定（_condition_met）と同じ形で
    # 引けるよう values にも入れつつ、計算（wasm）が読む形でも持つ。
    raw_toggles = body.get("toggles")
    raw_toggles = raw_toggles if isinstance(raw_toggles, dict) else {}
    toggles: dict = {}
    for section in building["sections"]:
        toggle = section.get("toggle")
        if toggle:
            toggles[toggle["key"]] = bool(raw_toggles.get(toggle["key"]))
            values[toggle["key"]] = toggles[toggle["key"]]

    return {
        "toggles": toggles,
        "building": building_key,
        "usage": usage,
        "values": values,
        "property_name": _normalize_text(raw.get("property_name")),
    }


# --- 検証 -------------------------------------------------------------------


def validate(data: dict) -> None:
    """入力の不足・不正を、利用者に読める文で返す。

    ここは配布物が「入力が足りないと出力欄が空になる」形で示している注意を、
    出力の前に日本語で伝えるためのもの。配布物の計算そのものには踏み込まない。
    """
    building = _building(data["building"])
    values = data["values"]

    missing: list[str] = []
    for section, _block, row, field in _iter_fields(building):
        # 入力できない欄（用途で消える欄・使わない算定方法・条件を満たさない
        # 任意入力）は、配布物にも書かないので中身を見ない。画面に残っていた
        # 値がそのまま送られてきても、それを理由に断らない。
        if not _visible(section, field, values):
            continue

        value = values.get(field["key"])
        condition = field.get("required_when")
        required = bool(field.get("required")) or (
            condition is not None and _condition_met(condition, values)
        )
        if required and value in (None, ""):
            where = f"{row['label']} " if row else ""
            missing.append(f"{section['title']}の「{where}{field['label']}」")
            continue

        options = _options_for(field, values)
        if options is not None and value not in ("", None) and value not in options:
            raise WallQuantityError(
                f"「{field['label']}」に選べない値が指定されました。"
            )

    if missing:
        raise WallQuantityError(
            "次の入力が足りません: " + "、".join(missing)
        )


def _visible(section: dict, field: dict, values: dict) -> bool:
    toggle = section.get("toggle")
    if toggle and not values.get(toggle["key"]):
        return False
    return _condition_met(field.get("visible_when"), values)


def _options_for(field: dict, values: dict) -> list | None:
    """選択欄の候補。連動プルダウン（樹種等・等級等）はその行の JAS 規格で決まる。"""
    if field["type"] != "select":
        return None
    mapping = load_mapping()
    cascade = field.get("cascade")
    if cascade:
        jas = values.get(cascade["of"]) or ""
        table = mapping["species"] if cascade["role"] == "species" else mapping["grade"]
        return table.get(jas, [])
    return mapping["options"][field["options_ref"]]


# --- 書き込み ---------------------------------------------------------------


def _cell_value(field: dict, values: dict):
    """入力欄の値を、セルへ書く形にする。"""
    value = values.get(field["key"])
    if value in (None, ""):
        return None
    if field["type"] == "number":
        return value
    if field["type"] == "date":
        # 配布物の作成日欄は書式が「標準」なので、シリアル値を書くと数値に
        # 見えてしまう（配布物の入力例がまさにそうなっている）。読める形で
        # 残すため、YYYY/M/D の文字列として書く。
        return _format_date(str(value))
    if field.get("value_type") == "number":
        return _to_number(value, field["label"])
    return str(value)


def _format_date(text: str) -> str:
    parts = text.split("-")
    if len(parts) == 3 and all(p.isdigit() for p in parts):
        year, month, day = parts
        return f"{int(year)}/{int(month)}/{int(day)}"
    return text


def build_worksheet(data: dict) -> bytes:
    """配布物の複製へフォーム入力を書き込み、xlsx のバイト列を返す。"""
    building = _building(data["building"])
    values = data["values"]
    sheet = building["sheet"]

    try:
        template = XlsxTemplate(template_bytes())

        cells: dict = {}
        for section, _block, _row, field in _iter_fields(building):
            fixed = field.get("fixed_when")
            if fixed and _condition_met(fixed, values):
                cells[field["cell"]] = fixed["value"]
                continue
            if not _visible(section, field, values):
                # 見えない欄（用途で消える欄・使わない算定方法・条件を満たさない
                # 任意入力）は、配布物の注意書きどおり空のままにする。
                cells[field["cell"]] = None
                continue
            cells[field["cell"]] = _cell_value(field, values)
        template.set_values(sheet, cells)

        for key, cell in building["usage_cells"].items():
            template.set_checkbox(sheet, cell, key == data["usage"])
        for section in building["sections"]:
            toggle = section.get("toggle")
            if toggle:
                template.set_checkbox(sheet, toggle["cell"], bool(values.get(toggle["key"])))

        template.recalculate_on_open()
        return template.to_bytes()
    except XlsxError as error:
        raise WallQuantityError(
            f"同梱している表計算ツールを読めませんでした（{error}）。"
            "配布物の改訂に追従できていない可能性があります。",
            500,
        )


# --- 計算（唯一の実装である wasm へ委譲する） -------------------------------


def compute(data: dict) -> dict:
    """配布物の「出力結果」と同じ値を計算する。

    計算そのものは Rust（core/src/wall_quantity.rs）が持っていて、画面が
    編集中に動かすのと**同じ .wasm** をここでも動かす。入力が足りない
    ところは、配布物と同じく空欄で返る（エラーにはしない）。
    """
    try:
        return nail_core.call({"op": "wallQuantity", "data": data})["result"]
    except CoreError as error:
        raise WallQuantityError(str(error)) from error


def calculation_inputs(building: str) -> dict:
    """計算が読む入力欄の key と、柱の圧縮基準強度の表。

    マッピング（書き込み先のセル）と計算（wasm）がずれていないかを
    確かめるためのもので、テストが使う。
    """
    try:
        return nail_core.call(
            {"op": "wallQuantityInputs", "data": {"building": building}}
        )
    except CoreError as error:
        raise WallQuantityError(str(error)) from error


def result_cells(result: dict) -> dict:
    """計算結果を「key → 表示文字列」の平らな辞書にする（突き合わせ用）。"""
    cells = {}
    for section in result.get("sections") or []:
        for table in section.get("tables") or []:
            for row in table.get("rows") or []:
                for cell in row.get("cells") or []:
                    cells[str(cell.get("key"))] = str(cell.get("text", ""))
    return cells


def verify(result: dict, claim) -> dict:
    """画面が出した計算結果と、サーバの計算結果を突き合わせる。

    編集中の計算は画面（wasm）が行うので、利用者が見ていた「出力結果」と、
    サーバが同じ入力から出す値が同じであることを保存のたびに確かめる。
    同じ .wasm を動かしている以上ふつうは一致するが、

      - 画面を開いたまま新しい版がデプロイされ、古い計算実装が残っている
      - 送信の途中で入力が入れ替わった

    といった食い違いはここで拾える。ずれていても保存は止めない（xlsx に
    入るのは入力値だけで、計算するのは Excel の数式なので、成果物が壊れる
    ことはない）。画面には警告として返し、利用者が気付けるようにする。

    突き合わせるのは表示文字列。利用者が画面で見たものそのものなので、
    「値は同じだが桁の丸めが違う」も食い違いとして拾える。
    """
    if not isinstance(claim, dict):
        # 画面が突き合わせの材料を送ってこない（＝この仕組みより前の版）。
        return {"checked": False, "ok": True, "differences": []}

    client_version = str(claim.get("coreVersion") or "")
    server_version = nail_core.version()
    claimed = claim.get("cells")
    claimed = claimed if isinstance(claimed, dict) else {}

    differences = []
    for key, server_text in result_cells(result).items():
        client_text = claimed.get(key)
        if client_text is None or str(client_text) != server_text:
            differences.append(
                {
                    "key": key,
                    "client": "-" if client_text is None else str(client_text),
                    "server": server_text,
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


def file_name(data: dict) -> str:
    """ダウンロードするファイル名。物件名があれば添える。"""
    naming = load_mapping()["file_name"]
    building = _building(data["building"])
    name = f"{naming['prefix']}（{building['label']}）"
    property_name = _sanitize(data.get("property_name", ""))
    if property_name:
        name = f"{name}_{property_name}"
    return name + naming["extension"]


def _sanitize(text: str) -> str:
    """ファイル名に使えない文字を落とす。"""
    return "".join(ch for ch in text if ch not in '\\/:*?"<>|').strip()


__all__ = [
    "WallQuantityError",
    "build_worksheet",
    "calculation_inputs",
    "compute",
    "file_name",
    "form_config",
    "load_mapping",
    "load_source",
    "normalize_data",
    "result_cells",
    "template_bytes",
    "template_version",
    "validate",
    "verify",
    "xlsx_fill",
]
