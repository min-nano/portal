"""構造計算によって建築物の安全性を確かめた旨の証明書（第四号書式）の生成と解析。

雛形は Google ドキュメント（記入欄は {{…}} のプレースホルダー）で、生成は
次の 3 段階に分かれる。Drive / Docs API を叩く部分は main.py 側にあり、
このモジュールは雛形と PDF のバイト列だけを扱う純粋なロジックにしてある。

  1. build_replacements() … フォーム入力から「プレースホルダー → 実データ」を作る
  2. （Docs API で置換し、PDF へ書き出す）
  3. finalize_pdf() ……… 書き出した PDF の該当する選択肢に ○ を描き、
                          再編集のためフォーム入力そのものを文書情報へ埋める

編集機能（PDF を読み込んでフォームへ戻す）は parse_pdf() が担当する。
本ツールが作った PDF なら文書情報から完全に復元でき、そうでない PDF でも
本文のレイアウトから可能な範囲を推定する（推定値は warnings で通知する）。

雛形のレイアウト（プレースホルダー名・選択肢の位置・解析ルール）は
structural_cert_mapping.json に切り出しており、フォーマットが改訂された
場合は原則 JSON を編集するだけで追従できる。
"""

import json
import os
import re

from . import pdf_tools
from .pdf_tools import Box

_MAPPING_PATH = os.path.join(os.path.dirname(__file__), "structural_cert_mapping.json")
_MAPPING = None

# ファイル名に使えない文字（Drive 上でも扱いづらいもの）。
_UNSAFE_FILE_NAME_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')

DEFAULT_FILE_NAME = "構造計算安全証明書.pdf"


class CertificateError(Exception):
    """証明書の生成・解析の失敗。message は利用者に表示できる日本語文。"""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def load_mapping() -> dict:
    """マッピング定義を読み込む（プロセス内でキャッシュ）。

    アンカーと解析ルールのラベルは、雛形の見た目どおりに書けるよう
    読み込み時に正規化しておく。
    """
    global _MAPPING
    if _MAPPING is None:
        with open(_MAPPING_PATH, encoding="utf-8") as f:
            mapping = json.load(f)
        for group in mapping["choice_groups"]:
            for option in group["options"]:
                option["anchor"] = pdf_tools.normalize_text(option["anchor"])
        for rule in mapping["parse_rules"]:
            if "label" in rule:
                rule["label"] = pdf_tools.normalize_text(rule["label"])
        _MAPPING = mapping
    return _MAPPING


def form_config() -> dict:
    """フロントエンドがフォームを組み立てるための定義を配信する。

    mapping.json を単一の情報源にし、画面側に項目定義を二重管理しない。
    """
    mapping = load_mapping()
    return {
        "text_fields": [
            {
                "key": f["key"],
                "label": f["label"],
                "hint": f.get("hint", ""),
                "unit": f.get("unit", ""),
                "required": bool(f.get("required")),
            }
            for f in mapping["text_fields"]
        ],
        "choice_groups": [
            {
                "key": g["key"],
                "label": g["label"],
                "required": bool(g.get("required")),
                "options": [
                    {
                        "value": o["value"],
                        "label": o["label"],
                        "requires_field": o.get("requires_field", ""),
                    }
                    for o in g["options"]
                ],
            }
            for g in mapping["choice_groups"]
        ],
        "sections": mapping["sections"],
        # 画面側でも同じ既定ファイル名を組み立てられるよう、雛形文字列を配信する
        # （{キー} をフォームの入力値で置き換える）。
        "file_name_template": mapping["output_file_name_template"],
        "default_file_name": DEFAULT_FILE_NAME,
    }


# --- フォームデータの正規化・検証 -------------------------------------------


def _field_definitions() -> dict:
    return {f["key"]: f for f in load_mapping()["text_fields"]}


def _choice_definitions() -> dict:
    return {g["key"]: g for g in load_mapping()["choice_groups"]}


def normalize_data(data) -> dict:
    """API で受け取った本文を {"fields": {...}, "choices": {...}} に整える。

    未知のキーは捨て、値は文字列へ寄せる。選択肢は定義済みの値だけを通す。
    """
    if not isinstance(data, dict):
        raise CertificateError("入力データがありません。")

    raw_fields = data.get("fields")
    raw_choices = data.get("choices")
    raw_fields = raw_fields if isinstance(raw_fields, dict) else {}
    raw_choices = raw_choices if isinstance(raw_choices, dict) else {}

    fields = {}
    for key in _field_definitions():
        value = raw_fields.get(key)
        fields[key] = "" if value is None else str(value).strip()

    choices = {}
    for key, group in _choice_definitions().items():
        value = raw_choices.get(key)
        value = "" if value is None else str(value).strip()
        allowed = {o["value"] for o in group["options"]}
        choices[key] = value if value in allowed else ""

    # 「その他」のような、特定の選択肢を選んだときだけ意味を持つ入力欄は、
    # その選択肢が外れていれば空にする（前の入力が証明書に残らないように）。
    for key, group in _choice_definitions().items():
        for option in group["options"]:
            dependent = option.get("requires_field")
            if dependent and choices.get(key) != option["value"]:
                fields[dependent] = ""

    return {"fields": fields, "choices": choices}


def validate(data: dict):
    """必須項目が埋まっているか確認する。埋まっていなければ 400 で返す。"""
    missing = []
    for key, definition in _field_definitions().items():
        if definition.get("required") and not data["fields"].get(key):
            missing.append(definition["label"])
    for key, group in _choice_definitions().items():
        if group.get("required") and not data["choices"].get(key):
            missing.append(group["label"])

    # 選択肢に紐づく入力欄（「６ その他」の内容など）も、選ばれていれば必須。
    for key, group in _choice_definitions().items():
        for option in group["options"]:
            dependent = option.get("requires_field")
            if not dependent or data["choices"].get(key) != option["value"]:
                continue
            if not data["fields"].get(dependent):
                missing.append(_field_definitions()[dependent]["label"])

    if missing:
        raise CertificateError("次の項目を入力してください: " + "、".join(missing))


def build_replacements(data: dict) -> dict:
    """雛形のプレースホルダー → 実データの対応表を作る。

    値が空の欄も対象にする（置換しないとプレースホルダーがそのまま
    証明書に印字されてしまうため）。
    """
    replacements = {}
    for key, definition in _field_definitions().items():
        value = data["fields"].get(key, "")
        for placeholder in definition["placeholders"]:
            replacements[placeholder] = value
    return replacements


def missing_placeholder_warnings(counts: dict, data: dict) -> list[str]:
    """雛形の中に見つからなかったプレースホルダーを警告文にする。

    値を入力したのに置換が 1 件も起きなかった欄は、その内容が証明書に
    載っていない（雛形が改訂された）ということなので、黙って成功させない。
    """
    warnings = []
    for key, definition in _field_definitions().items():
        if not data["fields"].get(key):
            continue
        if any(counts.get(p, 0) > 0 for p in definition["placeholders"]):
            continue
        warnings.append(
            f"雛形に「{definition['label']}」の記入欄"
            f"（{definition['placeholders'][0]}）が見つからなかったため、"
            "入力内容が反映されていません。"
        )
    return warnings


def default_file_name(data: dict) -> str:
    """建築物の名称から既定のファイル名を組み立てる。"""
    mapping = load_mapping()
    try:
        name = mapping["output_file_name_template"].format(**data["fields"])
    except KeyError:
        name = DEFAULT_FILE_NAME
    name = _UNSAFE_FILE_NAME_CHARS.sub("", name).strip().strip(".")
    # 名称が未入力だと「構造計算安全証明書_.pdf」のようになるため整える。
    name = name.replace("_.pdf", ".pdf")
    return name or DEFAULT_FILE_NAME


def ensure_pdf_extension(name: str) -> str:
    name = _UNSAFE_FILE_NAME_CHARS.sub("", (name or "").strip()).strip().strip(".")
    if not name:
        return DEFAULT_FILE_NAME
    return name if name.lower().endswith(".pdf") else name + ".pdf"


# --- ○ の描き込み -----------------------------------------------------------


def _selected_options(data: dict) -> list[tuple[dict, dict]]:
    selected = []
    for key, group in _choice_definitions().items():
        value = data["choices"].get(key)
        if not value:
            continue
        for option in group["options"]:
            if option["value"] == value:
                selected.append((group, option))
    return selected


def _locate_anchor(pages: list, group: dict, option: dict) -> tuple[int, Box]:
    """選択肢の印を付ける文字（番号や □）の位置を探す。"""
    hits = []
    for page in pages:
        for line, start in page.find(option["anchor"]):
            hits.append((page.index, line.box_for(start, option.get("mark_length", 1))))
    if not hits:
        raise CertificateError(
            f"雛形の中に「{group['label']}」の選択肢「{option['label']}」が"
            "見つかりませんでした。雛形のレイアウトが変わった可能性があります"
            "（backend/app/structural_cert_mapping.json の anchor を確認してください）。",
            409,
        )
    if len(hits) > 1:
        raise CertificateError(
            f"「{group['label']}」の選択肢「{option['label']}」が雛形の中で"
            "複数見つかったため、○ を付ける位置を決められませんでした"
            "（structural_cert_mapping.json の anchor をより長い文字列にしてください）。",
            409,
        )
    return hits[0]


def _mark_box(option: dict, anchor_box: Box) -> tuple[str, Box]:
    """選択肢の印の種類と、その外接矩形を決める。

    番号は正円で囲む（文字の外接矩形は縦横比が 1 ではないため、そのまま
    楕円にすると横長に見える）。□ はレ点を中に入れる。
    """
    mark = load_mapping()["mark"]
    kind = option.get("mark", pdf_tools.CIRCLE)
    if kind == pdf_tools.CHECK:
        padding = mark["check_padding"]
        return kind, Box(
            anchor_box.x0 - padding,
            anchor_box.y0 - padding,
            anchor_box.x1 + padding,
            anchor_box.y1 + padding,
        )
    return kind, pdf_tools.square_around(anchor_box, mark["circle_padding"])


def finalize_pdf(pdf_bytes: bytes, data: dict) -> bytes:
    """書き出した PDF に印を描き込み、フォーム入力を文書情報へ埋め込む。"""
    mapping = load_mapping()
    pages = pdf_tools.read_layout(pdf_bytes)

    marks: dict[int, list[tuple]] = {}
    for group, option in _selected_options(data):
        page_index, anchor_box = _locate_anchor(pages, group, option)
        marks.setdefault(page_index, []).append(_mark_box(option, anchor_box))

    # 再編集のためにフォーム入力そのものを残す。ensure_ascii=True のままにして
    # 文書情報が ASCII に収まるようにし、PDF の文字コードの差異を避ける。
    metadata = {mapping["metadata_key"]: json.dumps(data, sort_keys=True)}
    return pdf_tools.stamp_marks(
        pdf_bytes, marks, line_width=mapping["mark"]["line_width"], metadata=metadata
    )


# --- PDF の解析（編集機能） -------------------------------------------------


def _empty_data() -> dict:
    return {
        "fields": {key: "" for key in _field_definitions()},
        "choices": {key: "" for key in _choice_definitions()},
    }


def _parse_from_metadata(pdf_bytes: bytes) -> dict | None:
    mapping = load_mapping()
    raw = pdf_tools.read_metadata_value(pdf_bytes, mapping["metadata_key"])
    if not raw:
        return None
    try:
        stored = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(stored, dict):
        return None
    return normalize_data(stored)


def _clean_value(value: str, rule: dict) -> str:
    suffix = rule.get("strip_suffix")
    if suffix and value.endswith(suffix):
        value = value[: -len(suffix)]
    return value.strip()


def _apply_right_of(page, rule: dict) -> str | None:
    """ラベル行と同じ行の、右隣のセルの文字列を取り出す。

    証明書は 2 段組の表なので「ラベルの右にある最も近いセル」が記入欄になる。
    セル内で折り返している場合に備え、そのセルの行をすべて連結する。
    """
    label_line = page.line_equal(rule["label"])
    if label_line is None:
        return None
    candidates = [
        line
        for line in page.lines
        if line.box.x0 > label_line.box.x1 - 1
        and line.box.vertical_overlap(label_line.box) > 0
    ]
    if not candidates:
        return None
    target = min(candidates, key=lambda line: line.box.x0)
    drop = set(rule.get("drop_lines") or [])
    texts = [
        line.text
        for line in page.lines_in_container(target.container)
        if line.text and line.text not in drop
    ]
    return "".join(texts) if texts else None


def _is_mark_on(curve: Box, anchor_box: Box) -> bool:
    """曲線が、その文字に付けられた印（○ / レ点）かどうかを判定する。

    印は対象の文字を中心に描かれる小さな図形なので、「中心が文字の矩形の
    中にあり、かつ文字まわりに収まるサイズ」で見分けられる。○ は文字より
    ひと回り大きく、レ点は □ の中に収まるため、包含関係ではなく中心の
    位置で見るほうが両方を素直に拾える。表の罫線は直線・矩形として別に
    扱われるため、そもそもここには来ない。
    """
    center_x = (curve.x0 + curve.x1) / 2
    center_y = (curve.y0 + curve.y1) / 2
    inside = (
        anchor_box.x0 - 2 <= center_x <= anchor_box.x1 + 2
        and anchor_box.y0 - 2 <= center_y <= anchor_box.y1 + 2
    )
    small = (
        curve.width <= anchor_box.width + 14 and curve.height <= anchor_box.height + 14
    )
    return inside and small


def _detect_choices(pages: list, data: dict, warnings: list):
    """本文に描かれた印の位置から、選ばれている選択肢を復元する。

    ○ もレ点もベクター図形として残っているため、対象の文字の位置に印が
    あるかどうかで判定できる。
    """
    for group in load_mapping()["choice_groups"]:
        found = []
        for option in group["options"]:
            for page in pages:
                for line, start in page.find(option["anchor"]):
                    anchor_box = line.box_for(start, option.get("mark_length", 1))
                    for curve in page.curves:
                        if _is_mark_on(curve, anchor_box):
                            found.append(option["value"])
                            break
        unique = list(dict.fromkeys(found))
        if len(unique) == 1:
            data["choices"][group["key"]] = unique[0]
        elif len(unique) > 1:
            warnings.append(
                f"「{group['label']}」で複数の選択肢に ○ が見つかったため、"
                "選択を復元できませんでした。"
            )


def _parse_from_content(pdf_bytes: bytes) -> tuple[dict, list]:
    mapping = load_mapping()
    pages = pdf_tools.read_layout(pdf_bytes)
    data = _empty_data()
    warnings: list[str] = []
    ambiguous: list[str] = []
    definitions = _field_definitions()

    for rule in mapping["parse_rules"]:
        if rule["type"] == "line_regex":
            pattern = re.compile(rule["pattern"])
            for page in pages:
                match = next(
                    (m for m in (pattern.match(line.text) for line in page.lines) if m),
                    None,
                )
                if match:
                    for key, value in match.groupdict().items():
                        if key in data["fields"]:
                            data["fields"][key] = (value or "").strip()
                    break
        elif rule["type"] == "right_of":
            found = False
            for page in pages:
                value = _apply_right_of(page, rule)
                if value is not None:
                    data["fields"][rule["field"]] = _clean_value(value, rule)
                    found = True
                    break
            # 同じ欄に複数の項目が並んでいて分離できない場合は、読み込めた
            # ときだけ「まとめて入れた」旨を伝える。
            if found:
                for key in rule.get("ambiguous_with") or []:
                    ambiguous.append(definitions[key]["label"])

    _detect_choices(pages, data, warnings)

    if ambiguous:
        warnings.append(
            "PDF の本文からは "
            + "、".join(ambiguous)
            + " を分離できないため、隣の欄にまとめて読み込んでいます。内容を確認してください。"
        )
    return data, warnings


def parse_pdf(pdf_bytes: bytes) -> dict:
    """PDF を読み、フォームへ流し込めるデータを返す。

    本ツールが作った PDF なら文書情報から完全に復元する。それ以外の PDF は
    本文のレイアウトから推定するため、warnings を添えて返す。
    """
    if not pdf_bytes:
        raise CertificateError("PDF ファイルが空です。")
    if pdf_bytes.lstrip()[:5] != b"%PDF-":
        raise CertificateError("PDF ファイルではないようです。")

    from_metadata = _parse_from_metadata(pdf_bytes)
    if from_metadata is not None:
        return {"source": "metadata", "warnings": [], **from_metadata}

    try:
        data, warnings = _parse_from_content(pdf_bytes)
    except CertificateError:
        raise
    except Exception as e:
        raise CertificateError(f"PDF の解析に失敗しました: {e}") from e

    warnings.insert(
        0,
        "このツールで作成した PDF ではないため、本文から内容を推定しました。"
        "各項目が正しいか確認してください。",
    )
    return {"source": "content", "warnings": warnings, **data}
