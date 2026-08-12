#!/usr/bin/env python3
"""カバレッジ計測（Cobertura XML）の正規化と集計。

テストは 3 つの言語に分かれていて、カバレッジを出す道具もそれぞれ違う
（Rust は cargo-llvm-cov、Python は pytest-cov、画面は @vitest/coverage-v8）。
出力形式は 3 つとも Cobertura XML に揃えられるが、**そこに書かれるファイル
パスの基準がばらばら** で、そのままでは 1 つの表にまとめられない:

    core      <source>/…/portal/core</source>        filename="src/report.rs"
    backend   <source>/…/portal/backend/app</source> filename="main.py"
    frontend  <source>/…/portal/frontend</source>    filename="src/api.js"

このスクリプトは 2 つの仕事をする。どちらも「Cobertura XML をどう読むか」を
1 か所に閉じ込めるためにここへ置いてある（ワークフローに散らさない）。

  normalize  各テストジョブが自分の XML に対して実行する。<source> と
             filename を突き合わせて、パスを **リポジトリのルートからの相対**
             （core/src/report.rs, backend/app/main.py, frontend/src/api.js）へ
             書き換える。こうしておくと diff-cover が「この PR が変えた行」と
             カバレッジを突き合わせられる（差分は当然リポジトリ相対で出る）。

  summary    coverage ジョブが、正規化済みの XML をまとめて読み、スイートごと
             と全体の行・分岐の数を JSON にする。PR コメントの表はこの JSON
             だけを見て組み立てる。

行数は XML の line-rate 属性ではなく <line> 要素を数えて求める。道具ごとに
丸め方が違ううえ、「覆われた行 / 全体の行」を表に出したいため。<method> の
下にも同じ行が現れる（cargo-llvm-cov）ので、<class>/<lines> だけを数える。

依存は標準ライブラリだけ。CI では pip を通さずそのまま実行する。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

# condition-coverage="50% (1/2)" から (1, 2) を取り出す。
_CONDITION = re.compile(r"\((\d+)/(\d+)\)")


def _repo_relative(filename: str, sources: list[Path], repo_root: Path) -> str:
    """XML 中のファイルパスを、リポジトリのルートからの相対パスにする。

    filename は絶対パスのことも、<source> からの相対パスのこともある。
    候補を順に試し、リポジトリの中に収まったものを採用する。どれも収まら
    なければ（リポジトリ外のファイル＝依存ライブラリなど）そのまま返す。
    """
    path = Path(filename)
    candidates = [path] if path.is_absolute() else [source / path for source in sources]
    candidates.append(repo_root / path)

    for candidate in candidates:
        try:
            return candidate.resolve().relative_to(repo_root).as_posix()
        except ValueError:
            continue
    return path.as_posix()


def normalize(args: argparse.Namespace) -> int:
    repo_root = Path(args.repo_root).resolve()
    tree = ET.parse(args.input)
    root = tree.getroot()

    sources = [
        Path(element.text.strip())
        for element in root.findall("sources/source")
        if element.text and element.text.strip()
    ] or [repo_root]

    for class_element in root.iter("class"):
        filename = class_element.get("filename")
        if filename:
            class_element.set("filename", _repo_relative(filename, sources, repo_root))

    # 書き換えた後は、どのパスもリポジトリのルート基準になっている。
    sources_element = root.find("sources")
    if sources_element is None:
        sources_element = ET.SubElement(root, "sources")
    for child in list(sources_element):
        sources_element.remove(child)
    ET.SubElement(sources_element, "source").text = "."

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    tree.write(output, encoding="utf-8", xml_declaration=True)
    return 0


def _count(path: Path) -> dict[str, int]:
    """1 つの Cobertura XML の行・分岐を数える。"""
    root = ET.parse(path).getroot()

    # (ファイル, 行番号) をキーにして重複を潰す。同じ行が複数の <class> に
    # 現れることがある（言語やツールによる）ので、最も多いヒット数を採る。
    line_hits: dict[tuple[str, str], int] = {}
    branch_hits: dict[tuple[str, str], tuple[int, int]] = {}

    for class_element in root.iter("class"):
        filename = class_element.get("filename", "")
        lines_element = class_element.find("lines")
        if lines_element is None:
            continue
        for line in lines_element.findall("line"):
            number = line.get("number")
            if number is None:
                continue
            key = (filename, number)
            hits = int(float(line.get("hits", "0")))
            line_hits[key] = max(line_hits.get(key, 0), hits)

            condition = line.get("condition-coverage")
            if line.get("branch") == "true" and condition:
                matched = _CONDITION.search(condition)
                if matched:
                    covered, total = int(matched.group(1)), int(matched.group(2))
                    previous = branch_hits.get(key)
                    if previous is None or covered > previous[0]:
                        branch_hits[key] = (covered, total)

    return {
        "line_covered": sum(1 for hits in line_hits.values() if hits > 0),
        "line_total": len(line_hits),
        "branch_covered": sum(covered for covered, _ in branch_hits.values()),
        "branch_total": sum(total for _, total in branch_hits.values()),
    }


def _percent(covered: int, total: int) -> float | None:
    """カバレッジの百分率。測る行が無ければ None（表では ⚪ になる）。"""
    return round(100.0 * covered / total, 2) if total else None


def _with_percent(counts: dict[str, int]) -> dict[str, object]:
    return {
        **counts,
        "line_percent": _percent(counts["line_covered"], counts["line_total"]),
        "branch_percent": _percent(counts["branch_covered"], counts["branch_total"]),
    }


def summary(args: argparse.Namespace) -> int:
    suites = []
    overall = {"line_covered": 0, "line_total": 0, "branch_covered": 0, "branch_total": 0}

    for spec in args.reports:
        name, separator, raw_path = spec.partition("=")
        if not separator:
            print(f"coverage.py: '名前=パス' の形で渡すこと: {spec}", file=sys.stderr)
            return 2
        path = Path(raw_path)
        if not path.exists():
            # 1 つのスイートの計測が欠けても、残りの報告は続ける（欠けている
            # ことは表に「—」として出る）。
            print(f"coverage.py: 見つからない: {path}", file=sys.stderr)
            suites.append({"name": name, **_with_percent(dict.fromkeys(overall, 0))})
            continue
        counts = _count(path)
        for key, value in counts.items():
            overall[key] += value
        suites.append({"name": name, **_with_percent(counts)})

    report = {"suites": suites, "overall": _with_percent(overall)}
    text = json.dumps(report, indent=2, ensure_ascii=False)
    if args.output:
        Path(args.output).write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    normalize_parser = subparsers.add_parser(
        "normalize", help="Cobertura XML のパスをリポジトリ相対に書き換える"
    )
    normalize_parser.add_argument("input", help="入力の Cobertura XML")
    normalize_parser.add_argument("--output", required=True, help="書き出し先")
    normalize_parser.add_argument(
        "--repo-root", default=".", help="リポジトリのルート（既定: カレント）"
    )
    normalize_parser.set_defaults(func=normalize)

    summary_parser = subparsers.add_parser(
        "summary", help="正規化済みの XML をまとめて数え、JSON にする"
    )
    summary_parser.add_argument(
        "reports", nargs="+", metavar="名前=パス", help="スイート名と XML の組"
    )
    summary_parser.add_argument("--output", help="JSON の書き出し先（既定: 標準出力のみ）")
    summary_parser.set_defaults(func=summary)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
