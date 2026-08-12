"""テスト用の PDF 組み立てヘルパー。

証明書の雛形（Google ドキュメントから書き出した PDF）はリポジトリに
同梱しない（個人名・登録番号が入るため）ので、テストでは雛形と同じ
レイアウトを持つ最小限の PDF をその場で組み立てて使う。

日本語のフォントを同梱せずに日本語のテキストを「抽出できる」PDF を作る
ため、標準 14 フォント（Helvetica）に ToUnicode CMap を付けて、バイト
コード 1 つを日本語 1 文字へ対応させている。見た目は欧文になるが、
pdfminer が読み取るのは ToUnicode なので、文字とその座標を扱う
pdf_tools の検証にはこれで十分。文字幅は /Widths で 0.5em に固定し、
座標の期待値を計算できるようにしている。
"""

FONT_SIZE = 10.0
# /Widths で指定する 1 文字の幅（1000 分率）。
CHAR_WIDTH_1000 = 500
CHAR_WIDTH = FONT_SIZE * CHAR_WIDTH_1000 / 1000


def text_width(text: str, font_size: float = FONT_SIZE) -> float:
    return len(text) * font_size * CHAR_WIDTH_1000 / 1000


def _pdf_objects(objects: list[bytes]) -> bytes:
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


def _to_unicode_cmap(code_by_char: dict) -> bytes:
    entries = "".join(
        f"<{code:02X}> <{ord(char):04X}>\n" for char, code in code_by_char.items()
    )
    return (
        "/CIDInit /ProcSet findresource begin\n"
        "12 dict begin\nbegincmap\n"
        "/CMapName /Test def\n/CMapType 2 def\n"
        "1 begincodespacerange\n<00> <FF>\nendcodespacerange\n"
        f"{len(code_by_char)} beginbfchar\n{entries}endbfchar\n"
        "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n"
    ).encode("ascii")


def make_pdf(
    lines: list[tuple],
    page_width: float = 595.0,
    page_height: float = 842.0,
    font_size: float = FONT_SIZE,
) -> bytes:
    """(テキスト, x, y) の並びから 1 ページの PDF を作る。

    x, y はそのテキストの左下（ベースライン）の座標。
    """
    chars = []
    for text, _x, _y in lines:
        for char in text:
            if char not in chars:
                chars.append(char)
    code_by_char = {char: 33 + index for index, char in enumerate(chars)}
    if code_by_char and max(code_by_char.values()) > 255:
        raise ValueError("テスト用 PDF に含められる文字種は 223 種類までです。")

    content_parts = []
    for text, x, y in lines:
        hex_text = "".join(f"{code_by_char[c]:02X}" for c in text)
        content_parts.append(
            f"BT /F1 {font_size:.2f} Tf {x:.2f} {y:.2f} Td <{hex_text}> Tj ET\n"
        )
    content = "".join(content_parts).encode("ascii")

    first_code = min(code_by_char.values()) if code_by_char else 33
    last_code = max(code_by_char.values()) if code_by_char else 33
    widths = " ".join([str(CHAR_WIDTH_1000)] * (last_code - first_code + 1))
    cmap = _to_unicode_cmap(code_by_char)

    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            "<< /Type /Page /Parent 2 0 R /MediaBox "
            f"[0 0 {page_width:.2f} {page_height:.2f}]"
            " /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"
        ).encode("ascii"),
        b"<< /Length " + str(len(content)).encode("ascii") + b" >>\nstream\n"
        + content
        + b"endstream",
        (
            # BaseFont に標準 14 フォントの名前を使うと、pdfminer が組み込みの
            # フォントメトリクスを優先して /Widths を無視してしまう。文字幅を
            # こちらで決められるよう、独自の名前にしている。
            "<< /Type /Font /Subtype /Type1 /BaseFont /PortalTestFont"
            f" /FirstChar {first_code} /LastChar {last_code} /Widths [{widths}]"
            " /FontDescriptor 6 0 R /ToUnicode 7 0 R >>"
        ).encode("ascii"),
        (
            "<< /Type /FontDescriptor /FontName /PortalTestFont /Flags 32"
            " /FontBBox [-200 -200 1000 900] /ItalicAngle 0 /Ascent 800"
            " /Descent -200 /CapHeight 700 /StemV 80 >>"
        ).encode("ascii"),
        b"<< /Length " + str(len(cmap)).encode("ascii") + b" >>\nstream\n"
        + cmap
        + b"endstream",
    ]
    return _pdf_objects(objects)


# --- 証明書の雛形と同じレイアウトのページ -----------------------------------

# 実際の雛形（Google ドキュメントから書き出した PDF）の座標に合わせている。
LABEL_X = 103.8
VALUE_X = 253.8
SECOND_VALUE_X = 384.3
THIRD_VALUE_X = 454.4

# 記入例。フォームから入力される値に相当する。
SAMPLE_FIELDS = {
    "era_year": "令和7",
    "month": "8",
    "day": "10",
    "client_name": "株式会社サンプル",
    "building_address": "神奈川県相模原市緑区青山1766番地6",
    "building_name": "サンプル邸",
    "building_use": "一戸建ての住宅",
    "building_area": "62.10",
    "total_floor_area": "115.52",
    "max_height": "8.750",
    "eaves_height": "6.320",
    "floors_above": "2",
    "floors_below": "0",
    "structure": "木",
    "structure_part": "鉄筋コンクリート",
    "other_calc_type": "",
    "program_name": "サンプル構造計算",
    "program_cert_number": "TPRG-1234",
    "remarks": "特記事項なし",
}


def certificate_lines(fields: dict | None = None) -> list[tuple]:
    """記入済みの証明書と同じ並びのテキスト行を返す。"""
    f = dict(SAMPLE_FIELDS)
    if fields:
        f.update(fields)
    return [
        ("第四号書式（第十七条の十四の二関係）", 85.0, 750.2),
        ("構造計算によって建築物の安全性を確かめた旨の証明書", 186.9, 724.9),
        ("めたことを証明します。", 94.0, 690.4),
        (f"{f['era_year']}年{f['month']}月{f['day']}日", 395.3, 675.5),
        (f"委託者{f['client_name']}殿", 94.0, 583.1),
        ("建築物の所在地", LABEL_X, 563.6),
        (f["building_address"], VALUE_X, 563.6),
        ("建築物の名称及び用途", LABEL_X, 544.2),
        (f"{f['building_name']}{f['building_use']}", VALUE_X, 544.2),
        ("建築面積", LABEL_X, 524.8),
        (f"{f['building_area']}m", VALUE_X, 524.8),
        ("延べ面積", LABEL_X, 505.3),
        (f"{f['total_floor_area']}m", VALUE_X, 505.3),
        ("高さ", LABEL_X, 485.9),
        ("１最高の高さ", VALUE_X, 485.9),
        (f"{f['max_height']}m", SECOND_VALUE_X, 485.9),
        ("２最高の軒の高さ", VALUE_X, 467.2),
        (f"{f['eaves_height']}m", SECOND_VALUE_X, 467.2),
        ("階数", LABEL_X, 447.8),
        ("地上", VALUE_X, 447.8),
        (f"{f['floors_above']}階", 308.5, 447.8),
        ("地下", SECOND_VALUE_X, 447.8),
        (f"{f['floors_below']}階", 426.3, 447.8),
        ("構造", LABEL_X, 428.4),
        (f"{f['structure']}造", VALUE_X, 428.4),
        ("一部", SECOND_VALUE_X, 428.4),
        (f"{f['structure_part']}造", THIRD_VALUE_X, 428.4),
        ("建築物の区分", LABEL_X, 408.9),
        ("１建築基準法（以下「法」という。）第20条第1項第1号に", VALUE_X, 408.9),
        ("掲げる建築物", 274.8, 390.3),
        ("２法第20条第1項第2号に掲げる建築物", VALUE_X, 371.6),
        ("３法第20条第1項第3号に掲げる建築物", VALUE_X, 352.9),
        ("４法第20条第1項第4号に掲げる建築物", VALUE_X, 334.2),
        ("別添の構造計算書に係る構造", LABEL_X, 314.8),
        ("１建築基準法施行令（以下「令」という。）第81条第1項", VALUE_X, 314.8),
        ("計算の種類", LABEL_X, 296.1),
        ("２令第81条第2項第1号イに規定する構造計算", VALUE_X, 277.4),
        ("３令第81条第2項第1号ロに規定する構造計算", VALUE_X, 258.7),
        ("４令第81条第2項第2号イに規定する構造計算", VALUE_X, 240.1),
        ("５令第81条第3項に定める基準に従った構造計算", VALUE_X, 221.4),
        (f"６その他（{f['other_calc_type']}", VALUE_X, 202.7),
        ("別添の構造計算書に係る構造", LABEL_X, 183.3),
        ("１国土交通大臣が定めた方法によるもの", VALUE_X, 183.3),
        ("計算の方法", LABEL_X, 164.6),
        ("２国土交通大臣の認定を受けたプログラムによるもの", VALUE_X, 164.6),
        ("当該構造計算に用いたプログ", LABEL_X, 145.2),
        (f"１名称（{f['program_name']}", VALUE_X, 145.2),
        ("ラム", LABEL_X, 126.5),
        ("２国土交通大臣の認定□有□無", VALUE_X, 126.5),
        (f"３認定番号（{f['program_cert_number']}", VALUE_X, 107.8),
        ("備考", LABEL_X, 88.4),
        (f["remarks"], VALUE_X, 88.4),
    ]


def make_certificate_pdf(fields: dict | None = None) -> bytes:
    """記入済みの証明書と同じレイアウトの PDF を組み立てる（○ は未記入）。"""
    return make_pdf(certificate_lines(fields))


def make_template_pdf() -> bytes:
    """プレースホルダーが残ったままの雛形 PDF（未置換）を組み立てる。"""
    return make_pdf(
        certificate_lines(
            {key: "{{" + key + "}}" for key in SAMPLE_FIELDS if key != "other_calc_type"}
        )
    )
