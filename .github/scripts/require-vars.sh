#!/usr/bin/env bash
# 必須のリポジトリ変数が空でないことを確かめる。
#
# 未設定のリポジトリ変数は空文字として展開され、gcloud はそれを「未指定」と
# して受け入れてしまう。--service-account '' なら Compute 既定 SA、
# CLERK_ISSUER= なら認証設定なし、といった具合に、壊れた環境が「成功」として
# 出来上がる。デプロイの前にここで落とす。
#
# 値は環境変数として渡し、確認したい変数名を引数に並べる:
#
#   env:
#     PROJECT_ID: '${{ vars.PROJECT_ID }}'
#   run: .github/scripts/require-vars.sh PROJECT_ID ...
set -euo pipefail

missing=()
for name in "$@"; do
  [ -n "${!name:-}" ] || missing+=("$name")
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo "::error::リポジトリ変数が未設定です: ${missing[*]}（README「GitHub Actions（CI/CD）」参照）"
  exit 1
fi
