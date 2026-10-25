#!/usr/bin/env bash
# PR の head のテスト（tests.yml のジョブ）が通るのを待つ（claude-review.yml から
# 使う）。テストが通るまで Claude のレビューはしない。
#
# 見るのは HEAD_SHA のチェックランのうち、名前が TESTS（改行区切り）にあるもの。
# 同じ名前が複数ある（再実行した）ときは、最後に始まったものを見る。
#
#   全部 success           passed=true で終える
#   どれかが success 以外  失敗にする（テストが落ちた。レビューしない）
#   まだ終わっていない     INTERVAL 秒おきに取り直し、TIMEOUT 秒で失敗にする
#
# 待っている間に PR に push されたら（head が HEAD_SHA でなくなったら）、
# 待つのをやめて passed=false で終える。新しい head の実行が後に控えていて、
# そちらがレビューする。
#
# 環境変数: GH_TOKEN・PR・HEAD_SHA・TESTS（必須）、INTERVAL（既定 20）・
# TIMEOUT（既定 1500）
set -euo pipefail

: "${PR:?PR（PR 番号）を渡してください}"
: "${HEAD_SHA:?}" "${TESTS:?}"
repo="${GITHUB_REPOSITORY:?}"
interval="${INTERVAL:-20}"
timeout="${TIMEOUT:-1500}"

names="$(printf '%s\n' "$TESTS" | sed '/^[[:space:]]*$/d')"
names_json="$(printf '%s\n' "$names" | jq -R . | jq -sc .)"
start=$(date +%s)

while :; do
  head="$(gh api "repos/$repo/pulls/$PR" --jq .head.sha)"
  if [ "$head" != "$HEAD_SHA" ]; then
    echo "::notice::PR #${PR} の head が ${HEAD_SHA} から ${head} に進んだので、この実行ではレビューしません（新しい head の実行がレビューする）。"
    echo "passed=false" >> "${GITHUB_OUTPUT:-/dev/null}"
    exit 0
  fi

  # 名前ごとに最後に始まったチェックランの「状態 結論 名前」。
  latest="$(gh api --paginate "repos/$repo/commits/$HEAD_SHA/check-runs?per_page=100" \
      --jq '.check_runs[]' |
    jq -sr --argjson names "$names_json" '
      [.[] | select(.name as $n | $names | index($n))]
      | group_by(.name) | map(max_by(.started_at))
      | .[] | "\(.status) \(.conclusion // "-") \(.name)"')"

  failed="$(printf '%s\n' "$latest" | awk '$1 == "completed" && $2 != "success"' | cut -d' ' -f3-)"
  if [ -n "$failed" ]; then
    echo "::error::テストが通っていないので、レビューしません: $(printf '%s' "$failed" | paste -sd ',' - | sed 's/,/、/g')。テストを直して push するか、テストを再実行して通ったらこのジョブを再実行してください。"
    exit 1
  fi
  passed="$(printf '%s\n' "$latest" | awk '$1 == "completed" && $2 == "success"' | grep -c . || true)"
  total="$(printf '%s\n' "$names" | grep -c .)"
  if [ "$passed" -eq "$total" ]; then
    echo "テストが通りました（${total} 件）。"
    echo "passed=true" >> "${GITHUB_OUTPUT:-/dev/null}"
    exit 0
  fi

  if [ $(( $(date +%s) - start )) -ge "$timeout" ]; then
    echo "::error::${timeout} 秒待ってもテストが終わりませんでした（通ったもの ${passed}/${total} 件）。テストが通ってから、このジョブを再実行してください。"
    exit 1
  fi
  echo "テストの終わりを待っています（通ったもの ${passed}/${total} 件）"
  sleep "$interval"
done
