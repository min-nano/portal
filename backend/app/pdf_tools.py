"""PDF の読み取り（文字の座標）と、○ 印の描き込み。

構造計算安全証明書は Google ドキュメントの雛形から PDF へ書き出す。
プレースホルダー（{{…}}）の差し替えは Docs API で行えるが、「該当する
選択肢に ○ を付ける」「□ にレ点を入れる」は Docs API では表現できない
ため、書き出した PDF に後からベクターの図形を重ねる。

そのために必要なのは次の 2 つだけで、どちらも外部の描画ライブラリを
使わずに済ませている:

  * 文字の座標を得る … pdfminer.six。行単位で「空白を除いた正規化済み
    テキスト」と、その 1 文字ずつの矩形を持つ TextLine を組み立てる。
  * 図形を描く …… ○ とレ点だけを描いた 1 ページの PDF をバイト列として
    その場で組み立て、pypdf でページに重ねる（フォントを一切使わない
    ので、これで十分かつ環境に依存しない）。

Google ドキュメントの PDF 書き出しでは、一部の漢字が康熙部首
（U+2Fxx。例: ⽉ ⾯ ⾼）として埋め込まれることがある。そのため文字は
1 文字ずつ NFKC 正規化して比較する。1 文字が 2 文字以上に分解される
場合（㎡ → m2 など）は元の文字を残し、正規化後も「1 文字 = 1 矩形」の
対応が崩れないようにしている。
"""

import io
import unicodedata
from dataclasses import dataclass, field

from pdfminer.high_level import extract_pages
from pdfminer.layout import LTChar, LTCurve, LTLine, LTRect, LTTextLine
from pypdf import PdfReader, PdfWriter

# 楕円を 4 本の 3 次ベジェ曲線で近似するときの制御点の比率。
_KAPPA = 0.5522847498


def normalize_char(char: str) -> str:
    """1 文字を、長さを変えずに NFKC 正規化する。

    全角英数字・全角括弧・康熙部首を通常の文字へ寄せる。分解結果が
    1 文字にならない文字（㎡ など）は元のまま返す。
    """
    normalized = unicodedata.normalize("NFKC", char)
    return normalized if len(normalized) == 1 else char


def normalize_text(text: str) -> str:
    """比較用にテキストを正規化する（空白を除去し、1 文字ずつ NFKC）。

    PDF から取り出した行テキストと、マッピングに書かれたアンカー文字列の
    双方に同じ処理を掛けることで、雛形の見た目どおりの文字列をマッピングに
    書けるようにする。
    """
    return "".join(normalize_char(c) for c in text if not c.isspace())


@dataclass(frozen=True)
class Box:
    """PDF 座標系（左下原点）の矩形。"""

    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def width(self) -> float:
        return self.x1 - self.x0

    @property
    def height(self) -> float:
        return self.y1 - self.y0

    def union(self, other: "Box") -> "Box":
        return Box(
            min(self.x0, other.x0),
            min(self.y0, other.y0),
            max(self.x1, other.x1),
            max(self.y1, other.y1),
        )

    def contains(self, other: "Box", tolerance: float = 0.0) -> bool:
        return (
            self.x0 - tolerance <= other.x0
            and self.y0 - tolerance <= other.y0
            and self.x1 + tolerance >= other.x1
            and self.y1 + tolerance >= other.y1
        )

    def vertical_overlap(self, other: "Box") -> float:
        return max(0.0, min(self.y1, other.y1) - max(self.y0, other.y0))


@dataclass
class TextLine:
    """PDF 上の 1 行。text と char_boxes は同じ長さで添字が対応する。"""

    text: str
    char_boxes: list[Box]
    box: Box
    # 同じセル（pdfminer の text container）に属する行をまとめるための識別子。
    container: int

    def box_for(self, start: int, length: int) -> Box:
        boxes = self.char_boxes[start : start + length]
        result = boxes[0]
        for b in boxes[1:]:
            result = result.union(b)
        return result


@dataclass
class PageLayout:
    """1 ページぶんのテキスト行と、テキスト以外の曲線。"""

    index: int
    box: Box
    lines: list[TextLine] = field(default_factory=list)
    # 罫線（直線・矩形）を除いた曲線の外接矩形。○ 印の検出に使う。
    curves: list[Box] = field(default_factory=list)

    def find(self, needle: str) -> list[tuple[TextLine, int]]:
        """正規化済みの needle を含む (行, 行内の開始位置) をすべて返す。"""
        hits = []
        for line in self.lines:
            start = line.text.find(needle)
            while start != -1:
                hits.append((line, start))
                start = line.text.find(needle, start + 1)
        return hits

    def line_equal(self, text: str) -> TextLine | None:
        """正規化済みテキストが完全一致する最初の行を返す。"""
        for line in self.lines:
            if line.text == text:
                return line
        return None

    def lines_in_container(self, container: int) -> list[TextLine]:
        """同じセル内の行を上から順に返す。"""
        return sorted(
            (ln for ln in self.lines if ln.container == container),
            key=lambda ln: -ln.box.y1,
        )


def _walk_text_lines(obj, container: int, sink: list):
    """レイアウトツリーを辿って LTTextLine を集める。"""
    if isinstance(obj, LTTextLine):
        sink.append((container, obj))
        return
    if hasattr(obj, "__iter__"):
        for child in obj:
            _walk_text_lines(child, container, sink)


def _walk_curves(obj, sink: list):
    """罫線以外の曲線（○ 印）を集める。"""
    if isinstance(obj, (LTLine, LTRect)):
        return
    if isinstance(obj, LTCurve):
        sink.append(Box(*obj.bbox))
        return
    if hasattr(obj, "__iter__"):
        for child in obj:
            _walk_curves(child, sink)


def _build_line(container: int, lt_line) -> TextLine | None:
    text_parts: list[str] = []
    boxes: list[Box] = []
    for char in lt_line:
        if not isinstance(char, LTChar):
            continue
        raw = char.get_text()
        box = Box(*char.bbox)
        for c in raw:
            if c.isspace():
                continue
            text_parts.append(normalize_char(c))
            boxes.append(box)
    if not text_parts:
        return None
    line_box = boxes[0]
    for b in boxes[1:]:
        line_box = line_box.union(b)
    return TextLine("".join(text_parts), boxes, line_box, container)


def read_layout(pdf_bytes: bytes) -> list[PageLayout]:
    """PDF を読み、ページごとのテキスト行と曲線を返す。"""
    pages: list[PageLayout] = []
    for index, lt_page in enumerate(extract_pages(io.BytesIO(pdf_bytes))):
        page = PageLayout(index=index, box=Box(*lt_page.bbox))
        collected: list = []
        for container, obj in enumerate(lt_page):
            _walk_text_lines(obj, container, collected)
            _walk_curves(obj, page.curves)
        for container, lt_line in collected:
            line = _build_line(container, lt_line)
            if line is not None:
                page.lines.append(line)
        pages.append(page)
    return pages


CIRCLE = "circle"
CHECK = "check"


def square_around(box: Box, padding: float) -> Box:
    """box を包む正方形を返す（中心はそのまま）。

    文字の外接矩形は縦横比が 1 ではないため、そのまま楕円にすると
    横長・縦長に見える。手書きの ○ と同じく正円にするため、長い方の辺に
    合わせた正方形を作ってからそこに内接する円を描く。
    """
    cx = (box.x0 + box.x1) / 2
    cy = (box.y0 + box.y1) / 2
    half = max(box.width, box.height) / 2 + padding
    return Box(cx - half, cy - half, cx + half, cy + half)


def _circle_ops(box: Box, line_width: float) -> str:
    """box に内接する楕円（box が正方形なら正円）を描く内容ストリーム片。"""
    cx = (box.x0 + box.x1) / 2
    cy = (box.y0 + box.y1) / 2
    rx = box.width / 2
    ry = box.height / 2
    ox = rx * _KAPPA
    oy = ry * _KAPPA
    return (
        f"q 0 0 0 RG {line_width:.2f} w 1 J 1 j\n"
        f"{cx + rx:.2f} {cy:.2f} m\n"
        f"{cx + rx:.2f} {cy + oy:.2f} {cx + ox:.2f} {cy + ry:.2f} {cx:.2f} {cy + ry:.2f} c\n"
        f"{cx - ox:.2f} {cy + ry:.2f} {cx - rx:.2f} {cy + oy:.2f} {cx - rx:.2f} {cy:.2f} c\n"
        f"{cx - rx:.2f} {cy - oy:.2f} {cx - ox:.2f} {cy - ry:.2f} {cx:.2f} {cy - ry:.2f} c\n"
        f"{cx + ox:.2f} {cy - ry:.2f} {cx + rx:.2f} {cy - oy:.2f} {cx + rx:.2f} {cy:.2f} c\n"
        "S Q\n"
    )


def _check_ops(box: Box, line_width: float) -> str:
    """box の中にレ点（チェックマーク）を描く内容ストリーム片。

    短く下ろしてから右上へ長く跳ね上げる 2 画。□ の中に収まりつつ、
    右上だけわずかに飛び出すと手書きのレ点に近い見た目になる。
    """
    x, y = box.x0, box.y0
    w, h = box.width, box.height
    return (
        f"q 0 0 0 RG {line_width * 1.15:.2f} w 1 J 1 j\n"
        f"{x + w * 0.20:.2f} {y + h * 0.52:.2f} m\n"
        f"{x + w * 0.42:.2f} {y + h * 0.22:.2f} l\n"
        f"{x + w * 0.86:.2f} {y + h * 0.88:.2f} l\n"
        "S Q\n"
    )


def _mark_ops(kind: str, box: Box, line_width: float) -> str:
    return (
        _check_ops(box, line_width)
        if kind == CHECK
        else _circle_ops(box, line_width)
    )


def build_overlay_pdf(page_box: Box, marks: list[tuple], line_width: float) -> bytes:
    """印（○ とレ点）だけを描いた 1 ページの PDF をその場で組み立てる。

    marks は ("circle" | "check", 外接矩形) の並び。フォントも画像も使わない
    ため、外部の PDF 生成ライブラリを増やさずに済ませられる。MediaBox は
    重ねる先のページと同じにし、座標はページのユーザー空間そのままで受け取る。
    """
    content = "".join(
        _mark_ops(kind, box, line_width) for kind, box in marks
    ).encode("ascii")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            "<< /Type /Page /Parent 2 0 R /MediaBox "
            f"[{page_box.x0:.2f} {page_box.y0:.2f} {page_box.x1:.2f} {page_box.y1:.2f}]"
            " /Contents 4 0 R /Resources << >> >>"
        ).encode("ascii"),
        b"<< /Length " + str(len(content)).encode("ascii") + b" >>\nstream\n"
        + content
        + b"endstream",
    ]

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode("ascii") + body + b"\nendobj\n"

    xref_offset = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode("ascii")
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode("ascii")
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_offset}\n%%EOF\n"
    ).encode("ascii")
    return bytes(out)


def stamp_marks(
    pdf_bytes: bytes,
    marks_by_page: dict[int, list[tuple]],
    line_width: float = 0.9,
    metadata: dict[str, str] | None = None,
) -> bytes:
    """ページごとの印を重ね、必要なら文書情報を差し替えて書き出す。"""
    writer = PdfWriter(clone_from=io.BytesIO(pdf_bytes))
    for index, page in enumerate(writer.pages):
        marks = marks_by_page.get(index) or []
        if not marks:
            continue
        media = page.mediabox
        page_box = Box(
            float(media.left),
            float(media.bottom),
            float(media.right),
            float(media.top),
        )
        overlay = PdfReader(io.BytesIO(build_overlay_pdf(page_box, marks, line_width)))
        page.merge_page(overlay.pages[0])

    if metadata:
        # add_metadata は既存の文書情報へ追記する（元の情報は失われない）。
        writer.add_metadata(metadata)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def read_metadata_value(pdf_bytes: bytes, key: str) -> str | None:
    """文書情報から独自キーの値を読む。無ければ None。"""
    try:
        info = PdfReader(io.BytesIO(pdf_bytes)).metadata
    except Exception:
        return None
    if not info:
        return None
    value = info.get(key)
    return str(value) if value is not None else None
