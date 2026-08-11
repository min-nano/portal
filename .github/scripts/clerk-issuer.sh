#!/usr/bin/env bash
# Clerk の Publishable Key から、バックエンドが JWT 検証に使う issuer を導出する。
#
# キーは pk_<live|test>_<base64> の形で、デコードすると Frontend API のホスト名
# + "$" になる。issuer はそこから一意に決まるため、別のリポジトリ変数として
# 二重管理せず導出する（鍵とインスタンスの食い違いが原理的に起きない）。
#
# 本番（pk_live_）とプレビュー（pk_test_）で期待するプレフィックスが違うだけ
# なので、両方のワークフローがこのスクリプトを共有する。プレフィックスを必ず
# 確かめるのは、取り違えるとプレビューが本番の Clerk インスタンスを向いたり、
# 本番が開発インスタンスのトークンを受け付けたりするため。
#
# 使い方: clerk-issuer.sh <キー> <期待するプレフィックス> <変数名（メッセージ用）>
#   例: clerk-issuer.sh "$KEY" pk_live_ CLERK_PUBLISHABLE_KEY
# 導出した issuer（https://<ホスト名>）を標準出力に書く。
set -euo pipefail

key="${1:?キーを渡してください}"
prefix="${2:?期待するプレフィックスを渡してください}"
name="${3:?変数名を渡してください}"

case "$key" in
  "$prefix"*) ;;
  *)
    echo "::error::$name は ${prefix}... で始まるキーである必要があります。" >&2
    exit 1
    ;;
esac

encoded="${key#"$prefix"}"
# Clerk のキーは base64 のパディングを落としているため補う。
while [ $(( ${#encoded} % 4 )) -ne 0 ]; do encoded="${encoded}="; done

if ! host="$(printf '%s' "$encoded" | base64 -d 2>/dev/null)"; then
  echo "::error::$name をデコードできませんでした。" >&2
  exit 1
fi

host="${host%\$}"
case "$host" in
  ''|*[!a-zA-Z0-9.-]*)
    echo "::error::$name から取り出したホスト名が不正です: '${host}'" >&2
    exit 1
    ;;
esac

echo "https://$host"
