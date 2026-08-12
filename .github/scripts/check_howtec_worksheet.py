#!/usr/bin/env python3
"""同梱している表計算ツールが最新かどうかを、配布ページを見て確かめる。

必要壁量の表計算ツールは配布元（日本住宅・木材技術センター）で改訂される。
提出物は配布物そのものなので、古い版のまま配り続けるとまずい。そこで
このスクリプトを定期的に走らせ、

  * 配布ページから xlsx の在り処を探す
  * 落としてきて、同梱しているものと中身（sha256）を比べる
  * 違っていれば **Excel 形式のまま** 差し替え、出所（source.json）を書き直す

ところまでを行う。実際に PR を出すか issue を立てるかは、この結果
（--report に書く JSON）を見てワークフローが決める。

判断の材料を残すため、結果は必ず JSON に書き出す（黙って終わらない）。
"""

import argparse
import datetime
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
from html import unescape
from urllib.parse import parse_qsl, unquote, urljoin, urlsplit

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_TEMPLATE_DIR = os.path.join(_ROOT, "backend", "app", "templates", "wall-quantity")
_SOURCE_PATH = os.path.join(_TEMPLATE_DIR, "source.json")
_WORKSHEET_PATH = os.path.join(_TEMPLATE_DIR, "worksheet.xlsx")

# 配布ページは日本語のサイトで、User-Agent を見て弾く構成のこともある。
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (compatible; portal-worksheet-check/1.0; "
        "+https://github.com/min-nano/portal)"
    ),
    "Accept-Language": "ja,en;q=0.8",
}

# 目当てのファイルを見分ける手がかり。配布ページには解説 PDF など別の
# 添付も並ぶため、リンクの文字列と URL の両方から探す。
_KEYWORDS = ["表計算", "壁量", "多機能"]

_SPREADSHEET_SUFFIXES = (".xlsx", ".xlsm", ".xls")


def fetch(url: str, timeout: int = 60) -> tuple[bytes, str]:
    request = urllib.request.Request(url, headers=_HEADERS)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read(), response.geturl()


def decode_html(raw: bytes) -> str:
    for encoding in ("utf-8", "cp932", "euc-jp"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def spreadsheet_name(url: str) -> str:
    """URL が表計算ファイルを指しているならその名前を返す（違えば空文字）。

    配布ページのリンクは経路に拡張子が出ない形もある。実際、多機能版は

      /relays/download/441/1511/1312/6351/?file=/files/libs/6351/….xlsx

    と、拡張子が問い合わせ文字列の側にしか無い。経路だけを見ると
    「表計算ファイルが 1 つも無いページ」に見えてしまうので、両方を見る。
    """
    parts = urlsplit(url)
    for candidate in [unquote(parts.path), *(v for _, v in parse_qsl(parts.query))]:
        name = unquote(candidate).rsplit("/", 1)[-1]
        if name.lower().endswith(_SPREADSHEET_SUFFIXES):
            return name
    return ""


def find_links(html: str, page_url: str) -> list[dict]:
    """ページの中の表計算ファイルへのリンクを、表示文字列つきで集める。"""
    links = []
    found = {}
    for m in re.finditer(
        r"<a\b[^>]*href=[\"']([^\"']+)[\"'][^>]*>(.*?)</a>", html, re.S | re.I
    ):
        href = unescape(m.group(1)).strip()
        url = urljoin(page_url, href)
        if not spreadsheet_name(url):
            continue
        text = re.sub(r"<[^>]+>", "", m.group(2))
        text = unescape(text).strip()
        if url in found:
            # 配布ページは 1 つのファイルにアイコンと名前で 2 つのリンクを
            # 置いている。先に来るアイコン側は表示文字列が空なので、それを
            # 残すと名前で見分けられなくなる。空でない方を採る。
            if text and not found[url]["text"]:
                found[url]["text"] = text
            continue
        found[url] = {"url": url, "text": text}
        links.append(found[url])
    return links


def score(link: dict) -> int:
    haystack = f"{link['text']} {unquote(link['url'])}"
    return sum(1 for keyword in _KEYWORDS if keyword in haystack)


def choose(links: list[dict], recorded_url: str) -> tuple[dict | None, str]:
    """配布ページのリンクから、同梱しているファイルに当たるものを 1 つ選ぶ。

    一度うまくいった URL を source.json に控えてあるので、次からは
    まずそれを探す。無ければ手がかり（表計算・壁量・多機能）で絞り、
    それでも 1 つに決まらなければ選ばない（人に判断してもらう）。
    """
    if not links:
        return None, "配布ページに表計算ファイル（.xlsx）へのリンクが見つかりませんでした。"

    if recorded_url:
        for link in links:
            if link["url"] == recorded_url:
                return link, ""

    if len(links) == 1:
        return links[0], ""

    best = max(score(link) for link in links)
    if best > 0:
        narrowed = [link for link in links if score(link) == best]
        if len(narrowed) == 1:
            return narrowed[0], ""

    listing = "\n".join(f"  - {link['text'] or '(表示文字列なし)'}: {link['url']}" for link in links)
    return None, (
        "配布ページから対象のファイルを 1 つに絞れませんでした。"
        "ページの構成が変わった可能性があります。候補:\n" + listing
    )


def read_version(data: bytes) -> str:
    """落としてきたファイルに印字されている版を読む（読めなくても止めない）。"""
    sys.path.insert(0, os.path.join(_ROOT, "backend"))
    try:
        from app.wall_quantity import load_mapping
        from app.xlsx_fill import XlsxTemplate

        mapping = load_mapping()
        cell = mapping["template"]["version_cell"]
        sheet = next(
            b["sheet"] for b in mapping["buildings"] if b["key"] == cell["building"]
        )
        return XlsxTemplate(data).cell_text(sheet, cell["ref"]) or ""
    except Exception:
        # 版が読めないこと自体は差し替えを止める理由にならない（配布物の
        # 作りが変わっただけかもしれない）。雛形の番人テストが PR で
        # 中身のずれを教えてくれる。
        return ""


def looks_like_xlsx(data: bytes) -> bool:
    return data[:2] == b"PK" and b"xl/workbook.xml" in data[:65536] + data[-65536:]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", required=True, help="結果を書き出す JSON のパス")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="新しい版が見つかったとき、同梱ファイルと source.json を書き換える",
    )
    parser.add_argument("--today", default="", help="retrieved_at に使う日付（試験用）")
    args = parser.parse_args()

    with open(_SOURCE_PATH, encoding="utf-8") as f:
        source = json.load(f)

    report = {
        "status": "problem",
        "pageUrl": source["page_url"],
        "message": "",
        "oldSha256": source.get("sha256", ""),
        "oldVersion": source.get("version", ""),
    }

    try:
        raw, page_url = fetch(source["page_url"])
    except (urllib.error.URLError, OSError, TimeoutError) as error:
        report["message"] = f"配布ページを取得できませんでした: {error}"
        return write(args.report, report)

    link, problem = choose(find_links(decode_html(raw), page_url), source.get("file_url", ""))
    if link is None:
        report["message"] = problem
        return write(args.report, report)

    report["fileUrl"] = link["url"]
    report["fileText"] = link["text"]
    try:
        data, _ = fetch(link["url"])
    except (urllib.error.URLError, OSError, TimeoutError) as error:
        report["message"] = f"表計算ツールを取得できませんでした（{link['url']}）: {error}"
        return write(args.report, report)

    if not looks_like_xlsx(data):
        report["message"] = (
            f"取得したファイルが Excel ブックではありませんでした（{link['url']}）。"
        )
        return write(args.report, report)

    digest = hashlib.sha256(data).hexdigest()
    report["sha256"] = digest
    report["size"] = len(data)
    report["version"] = read_version(data)
    report["fileName"] = spreadsheet_name(link["url"])

    if digest == source.get("sha256"):
        report["status"] = "unchanged"
        report["message"] = "同梱している表計算ツールは配布ページの最新版と同じです。"
        return write(args.report, report)

    report["status"] = "updated"
    report["message"] = "配布ページの表計算ツールが、同梱しているものと違います。"

    if args.apply:
        with open(_WORKSHEET_PATH, "wb") as f:
            f.write(data)
        source["file_url"] = link["url"]
        source["file_name"] = report["fileName"]
        source["sha256"] = digest
        source["size"] = len(data)
        source["retrieved_at"] = args.today or datetime.date.today().isoformat()
        if report["version"]:
            source["version"] = report["version"].replace("ver", "").strip()
        with open(_SOURCE_PATH, "w", encoding="utf-8") as f:
            json.dump(source, f, ensure_ascii=False, indent=2)
            f.write("\n")

    return write(args.report, report)


def write(path: str, report: dict) -> int:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))

    step_output = os.environ.get("GITHUB_OUTPUT")
    if step_output:
        with open(step_output, "a", encoding="utf-8") as f:
            f.write(f"status={report['status']}\n")
    # ここでは失敗（非 0）にしない。「取れなかった」ときも issue を立てて
    # から落としたいので、赤にするのはワークフローの最後の段が行う。
    # status を見ずにこのスクリプトの終了状態だけを見ると、確認できて
    # いないことを見落とすので注意（status == "problem" は失敗として扱う）。
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
