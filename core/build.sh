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
# 成果物はコミットする（フロントエンドのビルドにも Cloud Run のビルドにも
# Rust を要らなくするため）。core/ を変更したらこれを実行し、.wasm も一緒に
# コミットすること。toolchain は core/rust-toolchain.toml で固定してあり、
# 同じソースからは同じバイト列が出るので、実行し忘れは CI が検出する。
set -eu

crate_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
destination="$crate_dir/../backend/app/wasm/nail_array_core.wasm"

cd "$crate_dir"
cargo test
cargo build --release --target wasm32-unknown-unknown

mkdir -p "$(dirname -- "$destination")"
cp target/wasm32-unknown-unknown/release/nail_array_core.wasm "$destination"

echo "作成しました: $destination ($(wc -c < "$destination") バイト)"
