#!/usr/bin/env python3
"""カバレッジ計測（Cobertura XML）のパスの正規化。

テストは 3 つの言語に分かれていて、カバレッジを出す道具もそれぞれ違う
（Rust は cargo-llvm-cov、Python は pytest-cov、画面は @vitest/coverage-v8）。
出力形式は 3 つとも Cobertura XML に揃えられるが、**そこに書かれるファイル
パスの基準がばらばら** で、そのままでは Codecov が実際のファイルに
突き合わせられない:

    core      <source>/…/portal/core</source>        filename="src/report.rs"
    backend   <source>/…/portal/backend/app</source> filename="main.py"
    frontend  <source>/…/portal/frontend</source>    filename="src/api.js"

このスクリプトがそれを直す。「Cobertura XML をどう読むか」を 1 か所に閉じ込める
ためにここへ置いてある（ワークフローに散らさない）。

  normalize  各テストジョブが自分の XML に対して実行する。<source> と
             filename を突き合わせて、パスを **リポジトリのルートからの相対**
             （core/src/report.rs, backend/app/main.py, frontend/src/api.js）へ
             書き換える。こうしておくと Codecov がスイートをまたいで同じ基準で
             ファイルを突き合わせられる（PR の差分も当然リポジトリ相対で出る）。

依存は標準ライブラリだけ。CI では pip を通さずそのまま実行する。
"""

from __future__ import annotations

import argparse
import xml.etree.ElementTree as ET
from pathlib import Path


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

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
