#!/usr/bin/env bash
# Claude レビュー（claude-review.yml・claude-rereview.yml）の実行環境を用意する。
#
# Agent SDK と code-review プラグインを入れ、claude-review.mjs と並べて置く。
# SDK は固定する（レビューを動かす仕組みなので、他のアクションと同じ扱い）。
# プラグインはレビューの指示そのもので、このリポジトリのコードの動作には
# 関わらないため、固定せず毎回 anthropics/claude-code の最新を取る。
# どちらもワークスペースの外（RUNNER_TEMP）に置く（レビュー対象に混ぜない）。
#
# 結果は GITHUB_ENV に PLUGIN_DIR（プラグインのディレクトリ）として渡す。
# スクリプトは "$RUNNER_TEMP/claude-review/claude-review.mjs" に置く。
set -euo pipefail

dir="${RUNNER_TEMP:?}/claude-review"
mkdir -p "$dir"
cp .github/scripts/claude-review.mjs "$dir/"
(
  cd "$dir"
  npm init -y > /dev/null
  npm install --no-audit --no-fund --ignore-scripts \
    @anthropic-ai/claude-agent-sdk@0.3.310 zod@4.6.7
)
git clone -q --depth 1 https://github.com/anthropics/claude-code.git "$dir/claude-code"
echo "プラグイン: anthropics/claude-code@$(git -C "$dir/claude-code" rev-parse HEAD)"
echo "PLUGIN_DIR=$dir/claude-code/plugins/code-review" >> "${GITHUB_ENV:?}"
