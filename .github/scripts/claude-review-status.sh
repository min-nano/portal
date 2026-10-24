#!/usr/bin/env bash
# PR の Claude レビュー（code-review プラグイン）の状況を調べる。
#
# claude-review.yml がプラグインを呼ぶ前と後に使う。
#
#   前: 判定（Approve / Request changes）まで済んでいれば、プラグインを
#       起動せずに終える（開き直しなど）
#   後: この実行でレビューが付いたかを数え、判定の材料にする。付いて
#       いなければジョブを失敗にする（Ready なのに未レビューを残さない）
#
# 「済み」の印は、ワークフローが出す判定のレビュー（VERDICT_AUTHOR、既定
# github-actions[bot]）の本文にある目印 MARKER。プラグインのコメントの有無を
# 印にすると、途中で止まった実行（コメントを一部だけ付けたところで中断）を
# 「済み」と取り違える。判定は全部が終わった後にしか出ないので、こちらを使う。
#
# この実行で付いたレビューとして数えるのは、SINCE（ISO 8601、UTC）以降に
# REVIEWER（既定 claude[bot]）が付けた
#   inline   インラインコメントのうち、スレッドの起点のもの（返信は除く。
#            `@claude` とのやり取りの返信を指摘と数えないため）
#   summary  `## Code review` で始まる PR へのコメント（指摘が無かったときの 1 件）
#   clean    summary のうち「No issues found」を含むもの
#
# API への反映が遅れて直後の一覧に出ないことがあるので、RETRIES 回まで
# 数秒おきに取り直す（inline も summary も 0 件のときだけ）。
#
# 使い方（環境変数 GH_TOKEN・PR を渡す。SINCE・RETRIES は任意）:
#
#   - id: after
#     env:
#       GH_TOKEN: ${{ github.token }}
#       PR: ${{ github.event.pull_request.number }}
#       SINCE: ${{ steps.start.outputs.since }}
#       RETRIES: '5'
#     run: .github/scripts/claude-review-status.sh
#
# 結果は GITHUB_OUTPUT に state（open / draft / closed）、verdict（true /
# false）、inline・summary・clean（件数）、reviewed（inline か summary が
# 1 件以上なら true）として渡す。
set -euo pipefail

: "${PR:?PR（PR 番号）を渡してください}"
repo="${GITHUB_REPOSITORY:?}"
reviewer="${REVIEWER:-claude[bot]}"
verdict_author="${VERDICT_AUTHOR:-github-actions[bot]}"
marker="${MARKER:-<!-- claude-review-verdict -->}"
since="${SINCE:-1970-01-01T00:00:00Z}"
retries="${RETRIES:-0}"

# --paginate はページごとに --jq の結果を出すので、件数を足し合わせる。
count() {
  gh api --paginate "$1" --jq "$2" | awk '{ s += $1 } END { print s + 0 }'
}

measure() {
  inline="$(count "repos/$repo/pulls/$PR/comments?per_page=100" \
    "[.[] | select(.user.login == \"$reviewer\" and .in_reply_to_id == null and .created_at >= \"$since\")] | length")"
  summary="$(count "repos/$repo/issues/$PR/comments?per_page=100" \
    "[.[] | select(.user.login == \"$reviewer\" and .created_at >= \"$since\" and (.body | ltrimstr(\"\\n\") | startswith(\"## Code review\")))] | length")"
  clean="$(count "repos/$repo/issues/$PR/comments?per_page=100" \
    "[.[] | select(.user.login == \"$reviewer\" and .created_at >= \"$since\" and (.body | ltrimstr(\"\\n\") | startswith(\"## Code review\")) and (.body | contains(\"No issues found\")))] | length")"
}

measure
attempt=0
while [ "$inline" -eq 0 ] && [ "$summary" -eq 0 ] && [ "$attempt" -lt "$retries" ]; do
  attempt=$((attempt + 1))
  echo "レビューのコメントがまだ見えないので取り直す（${attempt}/${retries}）"
  sleep 5
  measure
done

verdicts="$(count "repos/$repo/pulls/$PR/reviews?per_page=100" \
  "[.[] | select(.user.login == \"$verdict_author\" and ((.body // \"\") | contains(\"$marker\")))] | length")"

state="$(gh api "repos/$repo/pulls/$PR" \
  --jq 'if .state != "open" then "closed" elif .draft then "draft" else "open" end')"

verdict=false
[ "$verdicts" -gt 0 ] && verdict=true
reviewed=false
{ [ "$inline" -gt 0 ] || [ "$summary" -gt 0 ]; } && reviewed=true

echo "PR #$PR: state=$state verdict=$verdict reviewed=$reviewed（$since 以降: インライン $inline 件・まとめ $summary 件（うち指摘なし $clean 件））"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "state=$state"
    echo "verdict=$verdict"
    echo "reviewed=$reviewed"
    echo "inline=$inline"
    echo "summary=$summary"
    echo "clean=$clean"
  } >> "$GITHUB_OUTPUT"
fi
