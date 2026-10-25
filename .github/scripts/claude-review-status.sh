#!/usr/bin/env bash
# PR の Claude レビュー（code-review プラグイン）の状況を調べる。
#
# tests.yml の review ジョブが、プラグインを呼ぶ前と後に使う。
#
#   前: 判定（Approve / Request changes）があれば、PR 全体ではなく、その
#       判定の head（verdict_sha）からの差分を再レビューする。head が
#       変わっていなければ何もしない（開き直しなど）
#   後: この実行でレビューが付いたかを数え、判定の材料にする。付いて
#       いなければジョブを失敗にする（Ready なのに未レビューを残さない）
#
# 「済み」の印は、ワークフローが出す判定のレビュー（VERDICT_AUTHOR、既定
# github-actions[bot]）の本文にある目印 MARKER。プラグインのコメントの有無を
# 印にすると、途中で止まった実行（コメントを一部だけ付けたところで中断）を
# 「済み」と取り違える。判定は全部が終わった後にしか出ないので、こちらを使う。
#
# この実行で付いたレビューとして数えるのは、SINCE（ISO 8601、UTC）以降に
# REVIEWER（既定 github-actions[bot]。claude-review.mjs が GITHUB_TOKEN で付ける）が付けた
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
# false）、verdict_sha（最後の判定を出したときの PR の head。再レビューの
# 起点）、inline・summary・clean（件数）、reviewed（inline か summary が
# 1 件以上なら true）として渡す。
set -euo pipefail

: "${PR:?PR（PR 番号）を渡してください}"
repo="${GITHUB_REPOSITORY:?}"
reviewer="${REVIEWER:-github-actions[bot]}"
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

# 一覧は古い順に返るので、最後の行が最新の判定。
verdict_shas="$(gh api --paginate "repos/$repo/pulls/$PR/reviews?per_page=100" \
  --jq ".[] | select(.user.login == \"$verdict_author\" and ((.body // \"\") | contains(\"$marker\"))) | .commit_id")"
verdicts="$(printf '%s' "$verdict_shas" | grep -c . || true)"
verdict_sha="$(printf '%s\n' "$verdict_shas" | tail -n 1)"

state="$(gh api "repos/$repo/pulls/$PR" \
  --jq 'if .state != "open" then "closed" elif .draft then "draft" else "open" end')"

verdict=false
[ "$verdicts" -gt 0 ] && verdict=true
reviewed=false
{ [ "$inline" -gt 0 ] || [ "$summary" -gt 0 ]; } && reviewed=true

echo "PR #$PR: state=$state verdict=$verdict${verdict_sha:+（$verdict_sha）} reviewed=$reviewed（$since 以降: インライン $inline 件・まとめ $summary 件（うち指摘なし $clean 件））"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "state=$state"
    echo "verdict=$verdict"
    echo "verdict_sha=$verdict_sha"
    echo "reviewed=$reviewed"
    echo "inline=$inline"
    echo "summary=$summary"
    echo "clean=$clean"
  } >> "$GITHUB_OUTPUT"
fi
