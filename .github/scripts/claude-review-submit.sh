#!/usr/bin/env bash
# PR に判定のレビュー（Approve / Request changes）を出す。GitHub の API が
# 5xx を返したときは、間を空けて出し直す。
#
# tests.yml の review ジョブの判定の段が使う。5xx は GitHub 側の一時的な
# 失敗で、出し直せば通ることが多い（2026-11 に #228 の Approve が 502 で
# 落ちた。Settings の「Allow GitHub Actions to create and approve pull
# requests」の問題ではなかった）。4xx（権限が無い・内容がおかしい）は出し
# 直しても変わらないので、すぐに失敗にする。
#
# 5xx でも、GitHub 側ではレビューが作られていることがある。そのまま出し
# 直すと同じ判定が 2 つ付くので、出し直す前に、同じ判定（同じ commit・
# 種類・本文で、SINCE 以降に REVIEWER〈既定 github-actions[bot]〉が出した
# もの）が既にあるかを確かめ、あれば出せたとみなす。
#
# 使い方（環境変数 GH_TOKEN・PR・HEAD_SHA を渡す。SINCE・RETRIES・
# RETRY_DELAY は任意）:
#
#   .github/scripts/claude-review-submit.sh APPROVE "本文"
#
# 終了コード: 0 出せた、1 出せなかった（4xx など）、2 5xx が続いて出せなかった
set -euo pipefail

event="${1:?判定（APPROVE / REQUEST_CHANGES）を渡してください}"
body="${2:?本文を渡してください}"
: "${PR:?PR（PR 番号）を渡してください}"
: "${HEAD_SHA:?HEAD_SHA（判定を付ける commit）を渡してください}"
repo="${GITHUB_REPOSITORY:?}"
reviewer="${REVIEWER:-github-actions[bot]}"
since="${SINCE:-1970-01-01T00:00:00Z}"
retries="${RETRIES:-3}"
delay="${RETRY_DELAY:-10}"

case "$event" in
  APPROVE) state=APPROVED ;;
  REQUEST_CHANGES) state=CHANGES_REQUESTED ;;
  *) echo "判定は APPROVE か REQUEST_CHANGES です: $event" >&2; exit 1 ;;
esac

# 同じ判定が既に付いているか（5xx でも作られていた場合）。
already_posted() {
  gh api --paginate "repos/$repo/pulls/$PR/reviews?per_page=100" |
    jq -s -e --arg user "$reviewer" --arg sha "$HEAD_SHA" --arg state "$state" \
      --arg body "$body" --arg since "$since" \
      '[add[] | select(.user.login == $user and .commit_id == $sha and
        .state == $state and .body == $body and .submitted_at >= $since)]
       | length > 0' > /dev/null
}

attempt=0
while true; do
  if err="$(gh api "repos/$repo/pulls/$PR/reviews" --silent \
      -f commit_id="$HEAD_SHA" -f event="$event" -f body="$body" 2>&1)"; then
    exit 0
  fi
  echo "$err" >&2
  # gh は本文が JSON なら「gh: 〈message〉 (HTTP 502)」、そうでなければ
  # （ロードバランサの HTML など）「gh: HTTP 502」と出す。どちらも拾う。
  if ! grep -qE 'HTTP 5[0-9]{2}' <<< "$err"; then
    exit 1
  fi
  # 5xx でも作られていることがあるので、出し直す前（最後の 1 回の後も）に確かめる。
  # 一覧への反映を待つため、間を空けてから見る。
  sleep "$delay"
  if already_posted; then
    echo "5xx でしたが、判定は付いていました。" >&2
    exit 0
  fi
  if [ "$attempt" -ge "$retries" ]; then
    echo "GitHub の API が ${retries} 回出し直しても 5xx を返しました。" >&2
    exit 2
  fi
  attempt=$((attempt + 1))
  echo "GitHub の API が 5xx を返したので、出し直します（${attempt}/${retries}）。" >&2
done
