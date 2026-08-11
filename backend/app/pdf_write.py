"""日本語まじりの PDF を組み立てる最小限のライター。

構造計算安全証明書は Google ドキュメントの雛形を PDF へ書き出す方式だが、
釘配列諸定数の計算書は雛形のある帳票ではなく「入力と計算過程をそのまま
並べた計算書」なので、雛形を用意させずにバックエンドで直接組み立てる。

外部の PDF 生成ライブラリを増やさずに済ませるため、pdf_tools が ○ 印の
オーバーレイでやっているのと同じ要領で、PDF のバイト列をその場で書き出す。
必要なのは「文字を置く」「線・円を引く」だけなので、これで足りる。

日本語のフォントについて
------------------------
本文の日本語は Adobe-Japan1 の **標準 CJK フォント**（HeiseiKakuGo-W5）を
埋め込まずに参照する。フォントファイルを同梱・サブセット化しなくて済む
一方、実際の字形は閲覧側のフォントで代替されるため、日本語フォントの無い
環境では字形が置き換わることがある。

ToUnicode は付けない。文字コードは既定 CMap（UniJIS-UCS2-H）と
CIDSystemInfo（Adobe-Japan1）から一意に定まるため、閲覧側は検索・コピー・
テキスト抽出を正しく行える（Distiller が埋め込みなしの CJK に対して作る
PDF と同じ構成）。

文字送りは、CID 1〜230（欧文プロポーショナル）を一律 500/1000 em として
宣言し、それ以外（漢字・かななど）は既定の 1000/1000 em とする。計算書は
数値の桁を揃えて読む書類なので、欧文が等幅になるのはむしろ都合がよく、
この 2 種類だけならレイアウトの計算も PDF の宣言と厳密に一致させられる。
"""

import io

# A4 縦（PDF のユーザー空間 = 1/72 インチ）。
A4_PORTRAIT = (595.28, 841.89)

# 楕円を 4 本の 3 次ベジェ曲線で近似するときの制御点の比率。
_KAPPA = 0.5522847498

# 埋め込まずに参照する標準 CJK フォント（Adobe-Japan1）。
_BASE_FONT = "HeiseiKakuGo-W5"
# UCS-2（UTF-16BE）のコードをそのまま CID へ写す既定 CMap。文字列は
# UTF-16BE のバイト列として書けばよく、ToUnicode も恒等写像で済む。
_ENCODING = "UniJIS-UCS2-H"


def char_width(char: str, size: float) -> float:
    """1 文字の送り幅 [pt]。フォント辞書の /W 宣言と一致させてある。"""
    return size * (0.5 if ord(char) < 0x100 else 1.0)


def text_width(text: str, size: float) -> float:
    """文字列の送り幅 [pt]。右寄せ・中央寄せの位置決めに使う。"""
    return sum(char_width(c, size) for c in text)


def _hex_string(text: str) -> str:
    """UTF-16BE の 16 進文字列にする（BMP 外の文字は落とす）。"""
    return "<" + "".join(f"{ord(c):04X}" for c in text if ord(c) <= 0xFFFF) + ">"


def _gray(value: float) -> str:
    return f"{value:.3f}"


class Page:
    """1 ページ分の描画内容。座標は PDF の慣習どおり左下原点。"""

    def __init__(self, width: float, height: float):
        self.width = width
        self.height = height
        self._ops: list[str] = []

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
        width = text_width(text, size)
        if align == "right":
            x -= width
        elif align == "center":
            x -= width / 2
        self._ops.append(
            f"q {_gray(gray)} g BT /F1 {size:.2f} Tf {x:.2f} {y:.2f} Td "
            f"{_hex_string(text)} Tj ET Q\n"
        )
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

    def content(self) -> bytes:
        return "".join(self._ops).encode("ascii")


def _pdf_string(value: str) -> bytes:
    """文書情報の値を PDF の文字列にする。

    ASCII で書ける値は読みやすいリテラル文字列（括弧や \\ はエスケープ）に、
    日本語を含む値は PDF の規約どおり BOM 付き UTF-16BE の 16 進文字列にする。
    """
    if value.isascii():
        escaped = value.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
        return ("(" + escaped + ")").encode("ascii")
    return b"<FEFF" + value.encode("utf-16-be").hex().upper().encode("ascii") + b">"


class Document:
    """複数ページの PDF を組み立てる。"""

    def __init__(self):
        self.pages: list[Page] = []

    def add_page(self, size: tuple[float, float] = A4_PORTRAIT) -> Page:
        page = Page(size[0], size[1])
        self.pages.append(page)
        return page

    def to_bytes(self, metadata: dict[str, str] | None = None) -> bytes:
        """PDF のバイト列を書き出す。

        metadata は文書情報（/Title など）に入れるキーと値。再編集のための
        フォーム入力もここへ入れる（構造計算安全証明書と同じ考え方）。
        """
        # オブジェクト番号は固定で先に決める（相互参照があるため）。
        catalog, pages_obj, font, cid_font, descriptor, info = range(1, 7)
        first_page_obj = 7

        objects: dict[int, bytes] = {}
        kids = " ".join(
            f"{first_page_obj + i * 2} 0 R" for i in range(len(self.pages))
        )
        objects[catalog] = f"<< /Type /Catalog /Pages {pages_obj} 0 R >>".encode("ascii")
        objects[pages_obj] = (
            f"<< /Type /Pages /Kids [{kids}] /Count {len(self.pages)} >>"
        ).encode("ascii")
        objects[font] = (
            f"<< /Type /Font /Subtype /Type0 /BaseFont /{_BASE_FONT} "
            f"/Encoding /{_ENCODING} /DescendantFonts [{cid_font} 0 R] >>"
        ).encode("ascii")
        objects[cid_font] = (
            f"<< /Type /Font /Subtype /CIDFontType0 /BaseFont /{_BASE_FONT} "
            "/CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> "
            f"/FontDescriptor {descriptor} 0 R /DW 1000 /W [1 230 500] >>"
        ).encode("ascii")
        objects[descriptor] = (
            f"<< /Type /FontDescriptor /FontName /{_BASE_FONT} /Flags 4 "
            "/FontBBox [-92 -250 1010 922] /ItalicAngle 0 /Ascent 880 "
            "/Descent -120 /CapHeight 718 /StemV 114 >>"
        ).encode("ascii")

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
                f"/Resources << /Font << /F1 {font} 0 R >> >> "
                f"/Contents {content_number} 0 R >>"
            ).encode("ascii")
            objects[content_number] = _stream(page.content())

        return _serialize(objects, catalog, info)


def _stream(content: bytes) -> bytes:
    return (
        b"<< /Length "
        + str(len(content)).encode("ascii")
        + b" >>\nstream\n"
        + content
        + b"\nendstream"
    )


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
