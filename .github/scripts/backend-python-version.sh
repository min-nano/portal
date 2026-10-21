#!/usr/bin/env bash
# backend/Dockerfile の FROM 行から、本番（Cloud Run）で動く Python の X.Y を読み取る。
#
# テストを本番と同じ系列で動かすため、バージョンは Dockerfile だけを正とし、
# ワークフローには直書きしない（二重管理すると片方だけ上がって食い違う）。
# dependabot が Dockerfile を上げれば、テストもそのまま追従する。
#
# python:latest のように X.Y が読めない書き方にされたら、既定の Python へ
# 黙って落ちるのではなく、ここで落とす。
#
# 使い方（actions/setup-python の前に置く）:
#
#   - id: python-version
#     run: .github/scripts/backend-python-version.sh
#   - uses: actions/setup-python@...
#     with:
#       python-version: ${{ steps.python-version.outputs.version }}
#
# 読み取った X.Y は標準出力に書き、GITHUB_OUTPUT があれば version として渡す。
set -euo pipefail

dockerfile=backend/Dockerfile

version="$(sed -nE 's/^FROM python:([0-9]+\.[0-9]+)([-.@ ].*)?$/\1/p' "$dockerfile" | head -n 1)"
if [ -z "$version" ]; then
  echo "::error file=$dockerfile::FROM python:X.Y の行が見つかりません" >&2
  exit 1
fi

echo "$version"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "version=$version" >> "$GITHUB_OUTPUT"
fi
