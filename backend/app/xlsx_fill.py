"""配布物の xlsx を壊さずに、指定したセルだけ書き換える最小限のエディタ。

必要壁量の表計算ツール（日本住宅・木材技術センターの配布物）は、
チェックボックス（フォームコントロール）・EMF の図・VML・印刷設定を
含んだブックで、**提出物としてはその配布物そのもの**であることに意味がある。

openpyxl で読み書きすると、これらは復元されない（実測で ctrlProps・
vmlDrawing・drawing・media・printerSettings・sharedStrings が丸ごと落ち、
チェックボックスも図も消える）。そこで、このモジュールは zip の中の
XML を**触る場所だけ**書き換える:

  * 対象セルの <c> 要素だけを差し替える（スタイル属性 s は引き継ぐ）
  * チェックボックスは「リンクセルの値」「ctrlProps の checked」
    「VML の <x:Checked>」の 3 か所を揃える（Excel はこの 3 つを見る）
  * 数式の再計算は Excel に任せる（calcPr に fullCalcOnLoad を立てる）

それ以外のバイト列は一切変えないので、出来上がるファイルは
「配布物に値を書き込んだもの」そのものになる。

文字列は共有文字列表（sharedStrings.xml）を増やさずに済むよう
インライン文字列（t="inlineStr"）で書く。Excel・LibreOffice のどちらも
標準の記法として扱える。
"""

import datetime
import io
import math
import re
import zipfile

# Excel の既定（1900 年方式）のシリアル値の起点。1900 年をうるう年として
# 扱う Excel の癖に合わせるため 1899-12-30 を 0 とする。
_EPOCH = datetime.date(1899, 12, 30)


class XlsxError(Exception):
    """雛形の構造が想定と違うときのエラー（配布物の改訂で起こりうる）。"""


def column_index(column: str) -> int:
    """列名（A, B, ..., AA）を 1 始まりの列番号にする。"""
    index = 0
    for ch in column:
        index = index * 26 + (ord(ch) - ord("A") + 1)
    return index


def split_ref(ref: str) -> tuple[str, int]:
    """セル参照（"H15"）を (列名, 行番号) に分ける。"""
    m = re.fullmatch(r"([A-Z]+)([0-9]+)", ref)
    if not m:
        raise XlsxError(f"セル参照が不正です: {ref}")
    return m.group(1), int(m.group(2))


def _escape(text: str) -> str:
    # 改行は文字参照で書く。生の改行のままだと、XML の規則により読み手が
    # CR を落としたり CRLF を LF へ畳んだりして、セルの文字列が変わってしまう
    # （選択肢の文字列は数式の VLOOKUP の引き当てに使われるので、1 文字でも
    # 違うと計算が崩れる）。
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .replace("\n", "&#10;")
    )


def _unescape(text: str) -> str:
    # XML の規則どおり、改行は LF に揃えてから実体参照を戻す。
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"&#(\d+);", lambda m: chr(int(m.group(1))), text)
    text = re.sub(r"&#x([0-9A-Fa-f]+);", lambda m: chr(int(m.group(1), 16)), text)
    return (
        text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&apos;", "'")
        .replace("&amp;", "&")
    )


def to_serial(value: datetime.date) -> int:
    """日付を Excel のシリアル値にする。"""
    if isinstance(value, datetime.datetime):
        value = value.date()
    return (value - _EPOCH).days


def _number_text(value) -> str:
    """数値を XML に書く文字列にする（1.0 は 1 と書く）。"""
    if isinstance(value, bool):  # bool は int の一種なので先に弾く
        raise XlsxError("bool は _number_text で扱わない")
    if isinstance(value, int):
        return str(value)
    if value == int(value):
        return str(int(value))
    return repr(float(value))


class XlsxTemplate:
    """xlsx を「zip の部品の集まり」として持ち、必要な部品だけ書き換える。"""

    def __init__(self, data: bytes):
        self._names: list[str] = []
        self._parts: dict[str, bytes] = {}
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            for info in zf.infolist():
                self._names.append(info.filename)
                self._parts[info.filename] = zf.read(info.filename)
        self._shared_strings: list[str] | None = None
        self._sheet_paths: dict[str, str] | None = None

    # --- 部品の出し入れ -----------------------------------------------------

    def _text(self, path: str) -> str:
        if path not in self._parts:
            raise XlsxError(f"雛形に {path} がありません。")
        return self._parts[path].decode("utf-8")

    def _set_text(self, path: str, text: str) -> None:
        self._parts[path] = text.encode("utf-8")

    def to_bytes(self) -> bytes:
        """元と同じ並び・同じ圧縮方式で zip に戻す。"""
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as zf:
            for name in self._names:
                zf.writestr(name, self._parts[name])
        return output.getvalue()

    # --- シートの探索 -------------------------------------------------------

    def sheet_paths(self) -> dict[str, str]:
        """シート名 → zip 内のパス。"""
        if self._sheet_paths is None:
            rels = self._text("xl/_rels/workbook.xml.rels")
            targets = {}
            for m in re.finditer(r"<Relationship\b[^>]*/>", rels):
                tag = m.group(0)
                rid = re.search(r'Id="([^"]+)"', tag)
                target = re.search(r'Target="([^"]+)"', tag)
                if rid and target:
                    targets[rid.group(1)] = target.group(1)

            workbook = self._text("xl/workbook.xml")
            paths = {}
            for m in re.finditer(r"<sheet\b[^>]*/>", workbook):
                tag = m.group(0)
                name = re.search(r'name="([^"]*)"', tag)
                rid = re.search(r'r:id="([^"]+)"', tag)
                if not name or not rid:
                    continue
                target = targets.get(rid.group(1), "")
                if not target:
                    continue
                if not target.startswith("/"):
                    target = "xl/" + target.lstrip("./")
                paths[_unescape(name.group(1))] = target.lstrip("/")
            self._sheet_paths = paths
        return self._sheet_paths

    def _sheet_path(self, sheet_name: str) -> str:
        path = self.sheet_paths().get(sheet_name)
        if not path:
            raise XlsxError(
                f"雛形に「{sheet_name}」シートがありません。"
                "配布物が改訂された可能性があります。"
            )
        return path

    # --- 読み取り（雛形の確認に使う） ---------------------------------------

    def _strings(self) -> list[str]:
        if self._shared_strings is None:
            try:
                xml = self._text("xl/sharedStrings.xml")
            except XlsxError:
                self._shared_strings = []
                return self._shared_strings
            values = []
            for si in re.findall(r"<si>(.*?)</si>", xml, re.S):
                # ふりがな（<rPh>）はセルに表示されない添え物なので落とす。
                si = re.sub(r"<rPh\b.*?</rPh>", "", si, flags=re.S)
                # 書式付き文字列（<r><t>…</t></r> の連なり）は連結して 1 つの値にする。
                values.append(
                    "".join(_unescape(t) for t in re.findall(r"<t[^>]*>(.*?)</t>", si, re.S))
                )
            self._shared_strings = values
        return self._shared_strings

    def cell_text(self, sheet_name: str, ref: str) -> str | None:
        """セルの見た目の値（文字列・数値・キャッシュされた計算結果）を返す。

        雛形が想定どおりかを確かめる用途（マッピングの番人テスト・版の読み取り）
        のための最小限の読み取りで、書式は解釈しない。
        """
        xml = self._text(self._sheet_path(sheet_name))
        cell = _find_cell(xml, ref)
        if cell is None:
            return None
        tag = cell[0]
        body = cell[1]
        cell_type = re.search(r'\bt="([^"]+)"', tag)
        kind = cell_type.group(1) if cell_type else "n"
        if kind == "inlineStr":
            texts = re.findall(r"<t[^>]*>(.*?)</t>", body, re.S)
            return "".join(_unescape(t) for t in texts) if texts else None
        value = re.search(r"<v>(.*?)</v>", body, re.S)
        if value is None:
            return None
        raw = _unescape(value.group(1))
        if kind == "s":
            strings = self._strings()
            index = int(raw)
            return strings[index] if 0 <= index < len(strings) else None
        return raw

    # --- 書き込み -----------------------------------------------------------

    def set_values(self, sheet_name: str, values: dict) -> None:
        """シートのセルへまとめて書き込む。

        値の型で書き方を決める:
          None            … 空セル（スタイルは残す）
          bool            … 論理値
          int / float     … 数値
          datetime.date   … 日付（シリアル値。書式は雛形のものを使う）
          str             … 文字列（インライン文字列）
        """
        path = self._sheet_path(sheet_name)
        xml = self._text(path)
        for ref, value in values.items():
            xml = _write_cell(xml, ref, value)
        self._set_text(path, xml)

    def set_checkbox(self, sheet_name: str, linked_ref: str, checked: bool) -> None:
        """フォームコントロールのチェックボックスの入り／切りを揃える。

        Excel はチェックの状態を 3 か所に持っている。1 つでもずれると
        「見た目は ☑ なのに計算はされない」といった食い違いになるため、
        必ず 3 つとも書き換える。
        """
        self.set_values(sheet_name, {linked_ref: checked})

        # fmlaLink は常に絶対参照（$W$8）で書かれている。
        column, row_number = split_ref(linked_ref)
        link = f"${column}${row_number}"
        found = False
        for path in self.related_parts(sheet_name, "ctrlProp"):
            xml = self._text(path)
            if f'fmlaLink="{link}"' not in xml:
                continue
            found = True
            xml = re.sub(r'\s*checked="[^"]*"', "", xml, count=1)
            if checked:
                xml = xml.replace("<formControlPr ", '<formControlPr checked="Checked" ', 1)
            self._set_text(path, xml)

        for path in self.related_parts(sheet_name, "vmlDrawing"):
            xml = self._text(path)
            updated = _set_vml_checked(xml, link, checked)
            if updated is not None:
                found = True
                self._set_text(path, updated)

        if not found:
            raise XlsxError(
                f"「{sheet_name}」に {linked_ref} を参照するチェックボックスがありません。"
                "配布物が改訂された可能性があります。"
            )

    def related_parts(self, sheet_name: str, kind: str) -> list[str]:
        """シートの .rels から、指定した種類の関連部品のパスを集める。"""
        sheet_path = self._sheet_path(sheet_name)
        directory, _, file_name = sheet_path.rpartition("/")
        rels_path = f"{directory}/_rels/{file_name}.rels"
        if rels_path not in self._parts:
            return []
        rels = self._text(rels_path)
        paths = []
        for m in re.finditer(r"<Relationship\b[^>]*/>", rels):
            tag = m.group(0)
            if f"/{kind}" not in tag:
                continue
            target = re.search(r'Target="([^"]+)"', tag)
            if not target:
                continue
            paths.append(_normalize_target(directory, target.group(1)))
        return paths

    def recalculate_on_open(self) -> None:
        """開いたときに全再計算させる。

        書き込むのは入力欄だけで、結果欄は雛形の数式がそのまま残る。
        キャッシュされている値は入力前のものなので、Excel（および
        LibreOffice）に計算し直させる。
        """
        xml = self._text("xl/workbook.xml")
        if "<calcPr" not in xml:
            raise XlsxError("雛形に calcPr がありません。")
        xml = re.sub(r'\s*fullCalcOnLoad="[^"]*"', "", xml, count=1)
        xml = re.sub(r"<calcPr\b", '<calcPr fullCalcOnLoad="1"', xml, count=1)
        self._set_text("xl/workbook.xml", xml)


def _normalize_target(directory: str, target: str) -> str:
    """.rels の Target（../drawings/x.vml など）を zip 内のパスへ直す。"""
    if target.startswith("/"):
        return target.lstrip("/")
    parts = directory.split("/")
    for segment in target.split("/"):
        if segment == "..":
            if parts:
                parts.pop()
        elif segment not in ("", "."):
            parts.append(segment)
    return "/".join(parts)


def _set_vml_checked(xml: str, link: str, checked: bool) -> str | None:
    """VML の該当チェックボックスへ <x:Checked> を入れる／外す。

    見つからなければ None を返す（呼び出し側で他の部品を探す）。
    """
    marker = f"<x:FmlaLink>{link}</x:FmlaLink>"
    index = xml.find(marker)
    if index == -1:
        return None
    start = xml.rfind("<x:ClientData", 0, index)
    end = xml.find("</x:ClientData>", index)
    if start == -1 or end == -1:
        return None
    block = xml[start:end]
    block = re.sub(r"\s*<x:Checked>[^<]*</x:Checked>", "", block)
    if checked:
        # Excel が書く並びに合わせ、FmlaLink の直前へ入れる。
        block = block.replace(marker, f"<x:Checked>1</x:Checked>{marker}", 1)
    return xml[:start] + block + xml[end:]


# --- シート XML のセル操作 ---------------------------------------------------
#
# 行（<row>）とセル（<c>）は列・行の昇順に並んでいる必要がある。既にある
# 要素は中身だけ差し替え、無ければ並び順を保って差し込む。


def _find_row(xml: str, row_number: int) -> tuple[int, int, str] | None:
    """行要素を探し、(開始位置, 終了位置, 行の XML) を返す。"""
    for m in re.finditer(r'<row\b[^>]*\br="(\d+)"[^>]*?(/>|>)', xml):
        if int(m.group(1)) != row_number:
            continue
        if m.group(2) == "/>":
            return m.start(), m.end(), m.group(0)
        end = xml.find("</row>", m.end())
        if end == -1:
            raise XlsxError("シートの XML が壊れています（</row> がありません）。")
        end += len("</row>")
        return m.start(), end, xml[m.start() : end]
    return None


def _find_cell(xml: str, ref: str) -> tuple[str, str, int, int] | None:
    """セル要素を探し、(開始タグ, 中身, 開始位置, 終了位置) を返す。"""
    _, row_number = split_ref(ref)
    row = _find_row(xml, row_number)
    if row is None:
        return None
    row_start, _, row_xml = row
    for m in re.finditer(r'<c\b[^>]*\br="([A-Z]+\d+)"[^>]*?(/>|>)', row_xml):
        if m.group(1) != ref:
            continue
        if m.group(2) == "/>":
            return m.group(0), "", row_start + m.start(), row_start + m.end()
        end = row_xml.find("</c>", m.end())
        if end == -1:
            raise XlsxError("シートの XML が壊れています（</c> がありません）。")
        body = row_xml[m.end() : end]
        end += len("</c>")
        return m.group(0), body, row_start + m.start(), row_start + end
    return None


def _cell_xml(ref: str, style: str | None, value) -> str:
    """書き込む <c> 要素を組み立てる。"""
    attrs = f' r="{ref}"'
    if style is not None:
        attrs += f' s="{style}"'

    if value is None or (isinstance(value, str) and value == ""):
        return f"<c{attrs}/>"
    if isinstance(value, bool):
        return f'<c{attrs} t="b"><v>{1 if value else 0}</v></c>'
    if isinstance(value, datetime.date):
        return f"<c{attrs}><v>{to_serial(value)}</v></c>"
    if isinstance(value, (int, float)):
        return f"<c{attrs}><v>{_number_text(value)}</v></c>"
    text = _escape(str(value))
    return f'<c{attrs} t="inlineStr"><is><t xml:space="preserve">{text}</t></is></c>'


def _write_cell(xml: str, ref: str, value) -> str:
    """セルへ書き込んだ後のシート XML を返す。"""
    column, row_number = split_ref(ref)

    existing = _find_cell(xml, ref)
    if existing is not None:
        tag, _, start, end = existing
        style = re.search(r'\bs="([^"]*)"', tag)
        cell = _cell_xml(ref, style.group(1) if style else None, value)
        return xml[:start] + cell + xml[end:]

    cell = _cell_xml(ref, None, value)
    row = _find_row(xml, row_number)
    if row is None:
        return _insert_row(xml, row_number, cell)

    row_start, row_end, row_xml = row
    if row_xml.endswith("/>"):
        # 空の行（<row r="15"/>）にセルを 1 つ入れる。
        opened = row_xml[:-2] + ">"
        return xml[:row_start] + opened + cell + "</row>" + xml[row_end:]

    target = column_index(column)
    insert_at = None
    for m in re.finditer(r'<c\b[^>]*\br="([A-Z]+)\d+"', row_xml):
        if column_index(m.group(1)) > target:
            insert_at = m.start()
            break
    if insert_at is None:
        insert_at = row_xml.rfind("</row>")
    new_row = row_xml[:insert_at] + cell + row_xml[insert_at:]
    return xml[:row_start] + new_row + xml[row_end:]


def _insert_row(xml: str, row_number: int, cell: str) -> str:
    """行そのものが無いときに、行番号の順を保って差し込む。"""
    row_xml = f'<row r="{row_number}">{cell}</row>'
    for m in re.finditer(r'<row\b[^>]*\br="(\d+)"', xml):
        if int(m.group(1)) > row_number:
            return xml[: m.start()] + row_xml + xml[m.start() :]

    end = xml.find("</sheetData>")
    if end != -1:
        return xml[:end] + row_xml + xml[end:]
    # <sheetData/> の形（1 行も無いシート）。
    empty = xml.find("<sheetData/>")
    if empty == -1:
        raise XlsxError("シートの XML に sheetData がありません。")
    return (
        xml[:empty]
        + "<sheetData>"
        + row_xml
        + "</sheetData>"
        + xml[empty + len("<sheetData/>") :]
    )
