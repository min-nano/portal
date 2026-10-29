#!/usr/bin/env bash
# PR レビュー（PR エージェント）に使う code-review プラグインを、固定した
# commit から取り出す。
#
# プラグインの取得元と commit は git submodule（.gitmodules の SUBMODULE）で
# 固定し、Dependabot（gitsubmodule）に更新させる。取得元のリポジトリには tag も
# release も無く、Actions でも npm のパッケージでもないので、Dependabot が
# 追えるのは submodule だけ。submodule 自体はチェックアウトしない（actions/checkout
# の既定）。ここで、記録された commit から PLUGIN_PATH だけを DEST に取り出す。
#
# 取り出したら、プラグインのファイルがあるかを確かめる（置き場所が変わった
# commit に Dependabot が上げたときに、ここで落とす）。Dependabot の PR では
# review ジョブが走らないので、tests.yml の review-plugin ジョブが毎回これを
# 走らせて確かめる。
#
# 使い方（リポジトリのルートで。SHA は HEAD のツリーから読むので、浅い
# チェックアウトでよい）:
#
#   .github/scripts/claude-review-plugin.sh "$RUNNER_TEMP/plugins"
#
# 標準出力に、取り出したプラグインのディレクトリだけを出す。
set -euo pipefail

SUBMODULE=.github/claude-plugins-official
PLUGIN_PATH=plugins/code-review
REQUIRED=(.claude-plugin/plugin.json commands/code-review.md)

dest="${1:?取り出し先のディレクトリを指定してください}"

url="$(git config -f .gitmodules "submodule.${SUBMODULE}.url")"
sha="$(git rev-parse "HEAD:${SUBMODULE}")"

git init -q "$dest"
git -C "$dest" sparse-checkout set "$PLUGIN_PATH"
git -C "$dest" fetch -q --depth 1 --filter=blob:none "$url" "$sha"
git -C "$dest" checkout -q FETCH_HEAD
echo "プラグイン: ${url%.git}/tree/${sha}/${PLUGIN_PATH}" >&2

plugin="$dest/$PLUGIN_PATH"
for file in "${REQUIRED[@]}"; do
  if [ ! -f "$plugin/$file" ]; then
    echo "::error::code-review プラグインの ${PLUGIN_PATH}/${file} が ${url} の ${sha} にありません。プラグインの置き場所が変わった可能性があります。${SUBMODULE} の取得元・commit か、このスクリプトの PLUGIN_PATH を直してください。"
    exit 1
  fi
done

echo "$plugin"
