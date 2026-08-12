#!/bin/sh
# 唯一の計算実装（この crate）を wasm にして、配布場所へ置く。
#
#   core/src/*.rs  →  backend/app/wasm/nail_array_core.wasm
#
# 置き場所がバックエンドの中なのは、Cloud Run のデプロイが backend/ だけを
# 送るため（gcloud run deploy --source backend）。画面はこの .wasm を
# /api/tools/timber-panel-shear-calculator/core.wasm から受け取るので、
# 画面とサーバが同じバイト列を動かすことが構造として保証される。
#
# 成果物はコミットしない。CI（テスト・デプロイ）はそのつどこれを実行して
# 作り直すので、リポジトリに古い .wasm が残ることがない。手元でバックエンド
# やテストを動かすときは、最初に 1 度これを実行すること（要 rustup。
# toolchain は core/rust-toolchain.toml が指定する）。
#
# 式ごとの検証は `cargo test` にある（このスクリプトは走らせない。CI では
# Core ジョブが別に実行する）。
set -eu

crate_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
destination="$crate_dir/../backend/app/wasm/nail_array_core.wasm"

cd "$crate_dir"

# 固定した toolchain と wasm32 ターゲットを用意する（未取得なら rustup が
# ここで取ってくる）。rustup を使っていない環境では、あらかじめ
# wasm32-unknown-unknown を入れておくこと。
if command -v rustup >/dev/null 2>&1; then
  rustup target add wasm32-unknown-unknown
fi

cargo build --release --target wasm32-unknown-unknown

mkdir -p "$(dirname -- "$destination")"
cp target/wasm32-unknown-unknown/release/nail_array_core.wasm "$destination"

echo "作成しました: $destination ($(wc -c < "$destination") バイト)"
