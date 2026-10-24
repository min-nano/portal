#!/usr/bin/env bash
# PR に Claude（code-review プラグイン）のレビューが付いているかを調べる。
#
# claude-review.yml がプラグインを呼ぶ前と後に使う。
#
#   前: 既にレビュー済みなら、プラグインを起動せずに終える（開き直しなど）
#   後: Ready なのにレビューが付いていなければ、ジョブを失敗にする
#
# プラグインは「レビュー不要（自明な変更）」「Claude が既にコメントした」と
# 判断すると、何も書かずに終わる。そのまま緑で終えると、Ready なのに
# 未レビューの PR が気付かれずに残るので、後の確認で赤にする。
#
# 「レビュー済み」とみなすのは、レビューの名義（REVIEWER、既定 claude[bot]）の
#   - インラインコメント（指摘があったとき、プラグインはこれだけを付ける）
#   - `## Code review` で始まる PR へのコメント（指摘が無かったときの 1 件）
# のどちらかがあるとき。`@claude` への返事など、他のコメントは数えない。
#
# 使い方（環境変数 GH_TOKEN・PR を渡す）:
#
#   - id: before
#     env:
#       GH_TOKEN: ${{ github.token }}
#       PR: ${{ github.event.pull_request.number }}
#     run: .github/scripts/claude-review-status.sh
#
# 結果は GITHUB_OUTPUT に reviewed（true / false）と state（open / draft /
# closed）として渡す。
set -euo pipefail

: "${PR:?PR（PR 番号）を渡してください}"
reviewer="${REVIEWER:-claude[bot]}"
repo="${GITHUB_REPOSITORY:?}"

# --paginate はページごとに --jq の結果を出すので、件数を足し合わせる。
count() {
  gh api --paginate "$1" --jq "$2" | awk '{ s += $1 } END { print s + 0 }'
}

inline="$(count "repos/$repo/pulls/$PR/comments?per_page=100" \
  "[.[] | select(.user.login == \"$reviewer\")] | length")"
summary="$(count "repos/$repo/issues/$PR/comments?per_page=100" \
  "[.[] | select(.user.login == \"$reviewer\" and (.body | ltrimstr(\"\\n\") | startswith(\"## Code review\")))] | length")"

state="$(gh api "repos/$repo/pulls/$PR" \
  --jq 'if .state != "open" then "closed" elif .draft then "draft" else "open" end')"

if [ "$inline" -gt 0 ] || [ "$summary" -gt 0 ]; then
  reviewed=true
else
  reviewed=false
fi

echo "PR #$PR: state=$state reviewed=$reviewed（インライン $inline 件・まとめ $summary 件）"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "reviewed=$reviewed" >> "$GITHUB_OUTPUT"
  echo "state=$state" >> "$GITHUB_OUTPUT"
fi
