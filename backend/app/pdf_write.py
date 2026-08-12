"""日本語まじりの PDF を組み立てる最小限のライター。

構造計算安全証明書は Google ドキュメントの雛形を PDF へ書き出す方式だが、
釘配列諸定数の計算書は雛形のある帳票ではなく「入力と計算過程をそのまま
並べた計算書」なので、雛形を用意させずにバックエンドで直接組み立てる。

外部の PDF 生成ライブラリを増やさずに済ませるため、pdf_tools が ○ 印の
オーバーレイでやっているのと同じ要領で、PDF のバイト列をその場で書き出す。
必要なのは「文字を置く」「線・円を引く」だけなので、これで足りる。

日本語のフォントについて
------------------------
本文のフォントは Noto Sans JP（SIL Open Font License 1.1）を app/fonts に
同梱し、**その PDF で実際に使った文字だけを取り出したサブセットを埋め込む**。
閲覧側の環境に日本語フォントがあるかどうかに関係なく、いつでも同じ字形で
表示されるようにするため（埋め込まずに標準 CJK フォントを参照する方法だと、
日本語フォントの無い環境で字形が置き換わり、表示が崩れる）。

同梱フォントは 5.8MB あるが、埋め込まれるのは使った文字だけなので、計算書
1 通ぶんのサブセットは数十 KB に収まる。切り出しは fontTools が行い、
グリフの番号（GID）で文字を書く Identity-H 方式にしたうえで、検索・コピー・
テキスト抽出のために ToUnicode を必ず付ける。
"""

import hashlib
import io
import os
from dataclasses import dataclass

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont

# A4 縦（PDF のユーザー空間 = 1/72 インチ）。
A4_PORTRAIT = (595.28, 841.89)

# 楕円を 4 本の 3 次ベジェ曲線で近似するときの制御点の比率。
_KAPPA = 0.5522847498

FONT_PATH = os.path.join(os.path.dirname(__file__), "fonts", "NotoSansJP-Regular.ttf")

# フォントに無い文字（.notdef）を置くときの送り幅 [em]。
_MISSING_ADVANCE = 0.5


@dataclass(frozen=True)
class Subset:
    """埋め込むサブセットフォントと、PDF が必要とするその情報。"""

    data: bytes  # サブセットした TrueType のバイト列
    gids: dict[str, int]  # 文字 → グリフ ID
    widths: dict[int, int]  # グリフ ID → 字幅（1000 単位）
    name: str  # サブセット接頭辞つきのフォント名
    bbox: tuple[int, int, int, int]
    ascent: int
    descent: int
    cap_height: int


class Font:
    """同梱フォント。字幅の問い合わせと、サブセットの切り出しを受け持つ。

    字幅は組版（右寄せ・中央寄せ）のために描画のたびに要るので、フォントは
    プロセス内で 1 度だけ読み込んで使い回す。サブセットの切り出しは
    fontTools がフォントを書き換えてしまうため、そのつど元のバイト列から
    読み直す（同梱フォントは壊さない）。
    """

    def __init__(self, path: str = FONT_PATH):
        self._path = path
        self._raw: bytes | None = None
        self._font: TTFont | None = None
        self._units_per_em = 1000
        self._advances: dict[str, float] = {}

    def _raw_bytes(self) -> bytes:
        if self._raw is None:
            with open(self._path, "rb") as f:
                self._raw = f.read()
        return self._raw

    def _loaded(self) -> TTFont:
        if self._font is None:
            self._font = TTFont(io.BytesIO(self._raw_bytes()), lazy=True)
            self._units_per_em = self._font["head"].unitsPerEm
        return self._font

    def advance(self, char: str) -> float:
        """1 文字の送り幅 [em]。フォントに無い文字は既定値を返す。"""
        cached = self._advances.get(char)
        if cached is not None:
            return cached

        font = self._loaded()
        glyph_name = font.getBestCmap().get(ord(char))
        if glyph_name is None:
            width = _MISSING_ADVANCE
        else:
            width = font["hmtx"][glyph_name][0] / self._units_per_em
        self._advances[char] = width
        return width

    def text_width(self, text: str, size: float) -> float:
        """文字列の送り幅 [pt]。右寄せ・中央寄せの位置決めに使う。"""
        return sum(self.advance(c) for c in text) * size

    def subset(self, chars: set[str]) -> Subset:
        """使った文字だけを取り出したサブセットを作る。"""
        font = TTFont(io.BytesIO(self._raw_bytes()))
        options = Options()
        # 計算書は本文を横組みで置くだけなので、組版機能・縦組み・ヒントは
        # すべて落として埋め込むバイト数を抑える。
        options.layout_features = []
        options.hinting = False
        options.glyph_names = False
        options.drop_tables += ["GSUB", "GPOS", "GDEF", "BASE", "vmtx", "vhea", "VORG"]
        # フォントに無い文字は、黙って消えるより四角が出たほうが気付ける。
        options.notdef_outline = True

        subsetter = Subsetter(options=options)
        subsetter.populate(unicodes={ord(c) for c in chars})
        subsetter.subset(font)

        output = io.BytesIO()
        font.save(output)

        units_per_em = font["head"].unitsPerEm
        scale = 1000 / units_per_em
        cmap = font.getBestCmap()
        glyph_order = font.getGlyphOrder()
        gid_of = {name: index for index, name in enumerate(glyph_order)}

        gids: dict[str, int] = {}
        widths: dict[int, int] = {}
        for char in chars:
            name = cmap.get(ord(char))
            gid = gid_of.get(name, 0) if name else 0
            gids[char] = gid
            widths[gid] = round(font["hmtx"][glyph_order[gid]][0] * scale)

        head = font["head"]
        hhea = font["hhea"]
        os2 = font["OS/2"] if "OS/2" in font else None
        return Subset(
            data=output.getvalue(),
            gids=gids,
            widths=widths,
            name=f"{_subset_tag(chars)}+NotoSansJP",
            bbox=(
                round(head.xMin * scale),
                round(head.yMin * scale),
                round(head.xMax * scale),
                round(head.yMax * scale),
            ),
            ascent=round(hhea.ascent * scale),
            descent=round(hhea.descent * scale),
            cap_height=round(getattr(os2, "sCapHeight", 700) * scale),
        )


def _subset_tag(chars: set[str]) -> str:
    """サブセットの接頭辞（英大文字 6 文字）。

    PDF はサブセットしたフォントの名前に接頭辞を求める。同じ文字集合からは
    同じ接頭辞になるようにして、出力を再現可能にしておく。
    """
    digest = hashlib.sha1("".join(sorted(chars)).encode("utf-8")).digest()
    return "".join(chr(ord("A") + b % 26) for b in digest[:6])


# プロセス内で使い回す同梱フォント。
_FONT: Font | None = None


def default_font() -> Font:
    global _FONT
    if _FONT is None:
        _FONT = Font()
    return _FONT


@dataclass(frozen=True)
class _Text:
    """置く文字とその位置。グリフ番号はサブセットが決まってから割り当てる。"""

    x: float
    y: float
    text: str
    size: float
    gray: float


def _gray(value: float) -> str:
    return f"{value:.3f}"


class Page:
    """1 ページ分の描画内容。座標は PDF の慣習どおり左下原点。"""

    def __init__(self, width: float, height: float, font: Font):
        self.width = width
        self.height = height
        self.font = font
        self._ops: list[str | _Text] = []

    # --- 文字 ---------------------------------------------------------------

    def text(
        self,
        x: float,
        y: float,
        text: str,
        size: float = 9.0,
        align: str = "left",
        gray: float = 0.0,
    ) -> float:
        """文字列を置き、その幅を返す。y は文字のベースライン。

        align は left / right / center。右寄せ・中央寄せは自前で幅を測って
        原点をずらす（PDF に行揃えの概念は無い）。
        """
        if not text:
            return 0.0
        width = self.font.text_width(text, size)
        if align == "right":
            x -= width
        elif align == "center":
            x -= width / 2
        self._ops.append(_Text(x, y, text, size, gray))
        return width

    # --- 図形 ---------------------------------------------------------------

    def line(
        self,
        x0: float,
        y0: float,
        x1: float,
        y1: float,
        width: float = 0.5,
        gray: float = 0.0,
        dash: tuple[float, float] | None = None,
    ):
        pattern = f"[{dash[0]:.2f} {dash[1]:.2f}] 0 d " if dash else ""
        self._ops.append(
            f"q {_gray(gray)} G {width:.2f} w {pattern}"
            f"{x0:.2f} {y0:.2f} m {x1:.2f} {y1:.2f} l S Q\n"
        )

    def rect(
        self,
        x: float,
        y: float,
        width: float,
        height: float,
        line_width: float = 0.5,
        gray: float = 0.0,
        fill_gray: float | None = None,
    ):
        painter = "B" if fill_gray is not None else "S"
        fill = f"{_gray(fill_gray)} g " if fill_gray is not None else ""
        self._ops.append(
            f"q {_gray(gray)} G {fill}{line_width:.2f} w "
            f"{x:.2f} {y:.2f} {width:.2f} {height:.2f} re {painter} Q\n"
        )

    def circle(
        self,
        cx: float,
        cy: float,
        radius: float,
        line_width: float = 0.5,
        gray: float = 0.0,
        fill_gray: float | None = None,
    ):
        offset = radius * _KAPPA
        painter = "B" if fill_gray is not None else "S"
        fill = f"{_gray(fill_gray)} g " if fill_gray is not None else ""
        self._ops.append(
            f"q {_gray(gray)} G {fill}{line_width:.2f} w\n"
            f"{cx + radius:.2f} {cy:.2f} m\n"
            f"{cx + radius:.2f} {cy + offset:.2f} {cx + offset:.2f} {cy + radius:.2f} "
            f"{cx:.2f} {cy + radius:.2f} c\n"
            f"{cx - offset:.2f} {cy + radius:.2f} {cx - radius:.2f} {cy + offset:.2f} "
            f"{cx - radius:.2f} {cy:.2f} c\n"
            f"{cx - radius:.2f} {cy - offset:.2f} {cx - offset:.2f} {cy - radius:.2f} "
            f"{cx:.2f} {cy - radius:.2f} c\n"
            f"{cx + offset:.2f} {cy - radius:.2f} {cx + radius:.2f} {cy - offset:.2f} "
            f"{cx + radius:.2f} {cy:.2f} c\n"
            f"{painter} Q\n"
        )

    # --- 書き出し -----------------------------------------------------------

    def used_chars(self) -> set[str]:
        chars: set[str] = set()
        for op in self._ops:
            if isinstance(op, _Text):
                chars.update(op.text)
        return chars

    def content(self, subset: Subset) -> bytes:
        """内容ストリームを組み立てる（文字はグリフ番号で書く）。"""
        parts: list[str] = []
        for op in self._ops:
            if isinstance(op, str):
                parts.append(op)
                continue
            glyphs = "".join(f"{subset.gids.get(c, 0):04X}" for c in op.text)
            parts.append(
                f"q {_gray(op.gray)} g BT /F1 {op.size:.2f} Tf "
                f"{op.x:.2f} {op.y:.2f} Td <{glyphs}> Tj ET Q\n"
            )
        return "".join(parts).encode("ascii")


def _pdf_string(value: str) -> bytes:
    """文書情報の値を PDF の文字列にする。

    ASCII で書ける値は読みやすいリテラル文字列（括弧や \\ はエスケープ）に、
    日本語を含む値は PDF の規約どおり BOM 付き UTF-16BE の 16 進文字列にする。
    """
    if value.isascii():
        escaped = value.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
        return ("(" + escaped + ")").encode("ascii")
    return b"<FEFF" + value.encode("utf-16-be").hex().upper().encode("ascii") + b">"


def _width_array(widths: dict[int, int]) -> str:
    """/W 配列。連続するグリフ番号はまとめて 1 つの並びにする。"""
    if not widths:
        return "[]"
    runs: list[tuple[int, list[int]]] = []
    for gid in sorted(widths):
        if runs and gid == runs[-1][0] + len(runs[-1][1]):
            runs[-1][1].append(widths[gid])
        else:
            runs.append((gid, [widths[gid]]))
    return "[" + " ".join(
        f"{start} [{' '.join(str(w) for w in values)}]" for start, values in runs
    ) + "]"


def _to_unicode_cmap(subset: Subset) -> bytes:
    """ToUnicode CMap（グリフ番号 → 文字）。

    Identity-H では文字列に入るのがグリフ番号なので、これが無いと検索も
    コピーもできない PDF になる。
    """
    entries = sorted((gid, char) for char, gid in subset.gids.items())
    body = [
        "/CIDInit /ProcSet findresource begin",
        "12 dict begin",
        "begincmap",
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
        "/CMapName /Adobe-Identity-UCS def",
        "/CMapType 2 def",
        "1 begincodespacerange",
        "<0000> <FFFF>",
        "endcodespacerange",
    ]
    # 1 ブロックあたり 100 件までという決まりに従って分ける。
    for start in range(0, len(entries), 100):
        chunk = entries[start : start + 100]
        body.append(f"{len(chunk)} beginbfchar")
        body += [
            f"<{gid:04X}> <{char.encode('utf-16-be').hex().upper()}>"
            for gid, char in chunk
        ]
        body.append("endbfchar")
    body += ["endcmap", "CMapName currentdict /CMap defineresource pop", "end", "end"]
    return "\n".join(body).encode("ascii")


class Document:
    """複数ページの PDF を組み立てる。"""

    def __init__(self, font: Font | None = None):
        self.font = font or default_font()
        self.pages: list[Page] = []

    def add_page(self, size: tuple[float, float] = A4_PORTRAIT) -> Page:
        page = Page(size[0], size[1], self.font)
        self.pages.append(page)
        return page

    def to_bytes(self, metadata: dict[str, str] | None = None) -> bytes:
        """PDF のバイト列を書き出す。

        metadata は文書情報（/Title など）に入れるキーと値。再編集のための
        フォーム入力もここへ入れる（構造計算安全証明書と同じ考え方）。
        """
        used: set[str] = set()
        for page in self.pages:
            used |= page.used_chars()
        subset = self.font.subset(used)

        # オブジェクト番号は固定で先に決める（相互参照があるため）。
        (
            catalog,
            pages_obj,
            font_obj,
            cid_font,
            descriptor,
            font_file,
            to_unicode,
            info,
        ) = range(1, 9)
        first_page_obj = 9

        objects: dict[int, bytes] = {}
        kids = " ".join(
            f"{first_page_obj + i * 2} 0 R" for i in range(len(self.pages))
        )
        objects[catalog] = f"<< /Type /Catalog /Pages {pages_obj} 0 R >>".encode("ascii")
        objects[pages_obj] = (
            f"<< /Type /Pages /Kids [{kids}] /Count {len(self.pages)} >>"
        ).encode("ascii")
        objects[font_obj] = (
            f"<< /Type /Font /Subtype /Type0 /BaseFont /{subset.name} "
            f"/Encoding /Identity-H /DescendantFonts [{cid_font} 0 R] "
            f"/ToUnicode {to_unicode} 0 R >>"
        ).encode("ascii")
        objects[cid_font] = (
            f"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /{subset.name} "
            "/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> "
            f"/FontDescriptor {descriptor} 0 R /DW 1000 "
            f"/W {_width_array(subset.widths)} /CIDToGIDMap /Identity >>"
        ).encode("ascii")
        objects[descriptor] = (
            f"<< /Type /FontDescriptor /FontName /{subset.name} /Flags 4 "
            f"/FontBBox [{' '.join(str(v) for v in subset.bbox)}] /ItalicAngle 0 "
            f"/Ascent {subset.ascent} /Descent {subset.descent} "
            f"/CapHeight {subset.cap_height} /StemV 80 /FontFile2 {font_file} 0 R >>"
        ).encode("ascii")
        objects[font_file] = _stream(
            subset.data, extra=f"/Length1 {len(subset.data)}"
        )
        objects[to_unicode] = _stream(_to_unicode_cmap(subset))

        entries = [b"/Producer " + _pdf_string("portal-api")]
        for key, value in (metadata or {}).items():
            name = key[1:] if key.startswith("/") else key
            entries.append(f"/{name} ".encode("ascii") + _pdf_string(value))
        objects[info] = b"<< " + b" ".join(entries) + b" >>"

        for index, page in enumerate(self.pages):
            page_number = first_page_obj + index * 2
            content_number = page_number + 1
            objects[page_number] = (
                f"<< /Type /Page /Parent {pages_obj} 0 R "
                f"/MediaBox [0 0 {page.width:.2f} {page.height:.2f}] "
                f"/Resources << /Font << /F1 {font_obj} 0 R >> >> "
                f"/Contents {content_number} 0 R >>"
            ).encode("ascii")
            objects[content_number] = _stream(page.content(subset))

        return _serialize(objects, catalog, info)


def _stream(content: bytes, extra: str = "") -> bytes:
    header = f"<< /Length {len(content)}{' ' + extra if extra else ''} >>"
    return header.encode("ascii") + b"\nstream\n" + content + b"\nendstream"


def _serialize(objects: dict[int, bytes], root: int, info: int) -> bytes:
    """オブジェクト表と相互参照表を並べて PDF のバイト列にする。"""
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets: dict[int, int] = {}
    for number in sorted(objects):
        offsets[number] = out.tell()
        out.write(f"{number} 0 obj\n".encode("ascii"))
        out.write(objects[number])
        out.write(b"\nendobj\n")

    xref_offset = out.tell()
    count = max(objects) + 1
    out.write(f"xref\n0 {count}\n".encode("ascii"))
    out.write(b"0000000000 65535 f \n")
    for number in range(1, count):
        out.write(f"{offsets[number]:010d} 00000 n \n".encode("ascii"))
    out.write(
        (
            f"trailer\n<< /Size {count} /Root {root} 0 R /Info {info} 0 R >>\n"
            f"startxref\n{xref_offset}\n%%EOF\n"
        ).encode("ascii")
    )
    return out.getvalue()
