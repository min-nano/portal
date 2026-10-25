#!/usr/bin/env bash
# Claude レビューの結果を、PR のレビュー（Approve / Request changes）として出す
# （claude-review.yml・claude-rereview.yml から使う）。
#
# 指摘あり（インラインコメントがある）→ Request changes、
# 「No issues found」のまとめだけ → Approve。どちらでもない（まとめは
# あるが「No issues found」を含まない）なら、判定せずに落とす。
#
# 本文の目印（claude-review-status.sh の MARKER）が「判定まで済んだ」の
# 印になる。
#
# 出すのは GITHUB_TOKEN（github-actions[bot]）。Approve には Settings →
# Actions → General の「Allow GitHub Actions to create and approve pull
# requests」が要る（howtec-worksheet-check.yml の PR 作成と同じ設定）。
#
# 環境変数: GH_TOKEN・PR・INLINE・CLEAN（claude-review-status.sh の件数）・
# KIND（本文での呼び名。既定「レビュー」）
set -euo pipefail

: "${PR:?PR（PR 番号）を渡してください}"
: "${INLINE:?}" "${CLEAN:?}"
kind="${KIND:-レビュー}"
marker="${MARKER:-<!-- claude-review-verdict -->}"

if [ "$INLINE" -gt 0 ]; then
  gh pr review "$PR" --request-changes \
    --body "$(printf '%s\n\nClaude の%sで指摘が %s 件ありました。インラインコメントを確認してください。' "$marker" "$kind" "$INLINE")"
elif [ "$CLEAN" -gt 0 ]; then
  if ! gh pr review "$PR" --approve \
      --body "$(printf '%s\n\nClaude の%sで指摘はありませんでした。' "$marker" "$kind")"; then
    echo "::error::Approve できませんでした。Settings → Actions → General の「Allow GitHub Actions to create and approve pull requests」が有効か確認してください（README「Claude による PR レビュー（PR エージェント）」参照）。"
    exit 1
  fi
else
  echo "::error::Claude のまとめコメントに「No issues found」が無く、インラインコメントもありません。指摘の有無を判定できないので、まとめコメントを確認して人が判定してください。"
  exit 1
fi
