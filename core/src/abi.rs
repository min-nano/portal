//! wasm としての受け渡し（線形メモリの確保・解放と、唯一の呼び出し口）。
//!
//! 画面（JavaScript）とサーバ（Python + wasmtime）は、どちらもこの 3 つの
//! 関数だけを使う。wasm-bindgen のようなグルーを挟まないので、ブラウザと
//! サーバがまったく同じ .wasm を、同じ手順で呼べる。
//!
//! 呼び出しの手順:
//!   1. `nac_alloc(len)` で入力（UTF-8 の JSON）を置く場所を確保する。
//!   2. 線形メモリへ書き込み、`nac_call(ptr, len)` を呼ぶ。
//!   3. 戻り値は「先頭 4 バイト = 本体の長さ（リトルエンディアンの u32）、
//!      続いて UTF-8 の JSON」という形の領域を指す。
//!   4. 入力を `nac_free(ptr, len)`、応答を `nac_free(ptr, 4 + 長さ)` で返す。
//!
//! 長さを前置きするのは、応答の長さを別の関数で取りに行かせないため
//! （呼び出しごとに状態を持たずに済み、取り違えが起きない）。

use std::slice;

/// 応答の先頭に置く長さ（u32、リトルエンディアン）のバイト数。
pub const LENGTH_PREFIX: usize = 4;

/// `len` バイトの領域を確保して先頭を返す。
///
/// 呼び出し側は、使い終わったら必ず同じ `len` で `nac_free` を呼ぶこと。
#[no_mangle]
pub extern "C" fn nac_alloc(len: usize) -> *mut u8 {
    // 容量ちょうどの領域を作る（Vec の容量は要求より大きいことがあり、
    // 解放時に食い違うと未定義動作になるため、箱スライスにして揃える）。
    let buffer = vec![0_u8; len].into_boxed_slice();
    Box::into_raw(buffer).cast::<u8>()
}

/// `nac_alloc` / `nac_call` が返した領域を解放する。
///
/// # Safety
/// `ptr` と `len` は、この crate が返したときの組み合わせであること。
#[no_mangle]
pub unsafe extern "C" fn nac_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    drop(Box::from_raw(slice::from_raw_parts_mut(ptr, len)));
}

/// JSON の要求（UTF-8）を処理し、長さを前置きした JSON の応答を返す。
///
/// # Safety
/// `ptr` から `len` バイトが、有効な UTF-8 の読み取り可能な領域であること。
#[no_mangle]
pub unsafe extern "C" fn nac_call(ptr: *const u8, len: usize) -> *mut u8 {
    let request = match std::str::from_utf8(slice::from_raw_parts(ptr, len)) {
        Ok(request) => crate::call(request),
        // 呼び出し側の作りが壊れている場合。応答の形は保ったまま伝える。
        Err(_) => r#"{"ok":false,"error":"要求が UTF-8 ではありません。"}"#.to_string(),
    };

    let body = request.into_bytes();
    let mut response = Vec::with_capacity(LENGTH_PREFIX + body.len());
    response.extend_from_slice(&(body.len() as u32).to_le_bytes());
    response.extend_from_slice(&body);
    Box::into_raw(response.into_boxed_slice()).cast::<u8>()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ネイティブ（cargo test）でも同じ手順で呼べることを確かめる。
    /// wasm での呼び出しは backend/tests・frontend/tests が本物の .wasm で試す。
    #[test]
    fn round_trips_a_request_through_the_raw_abi() {
        let request = br#"{"op": "config"}"#;
        unsafe {
            let input = nac_alloc(request.len());
            slice::from_raw_parts_mut(input, request.len()).copy_from_slice(request);

            let output = nac_call(input, request.len());
            let mut length = [0_u8; LENGTH_PREFIX];
            length.copy_from_slice(slice::from_raw_parts(output, LENGTH_PREFIX));
            let length = u32::from_le_bytes(length) as usize;
            let body = std::str::from_utf8(slice::from_raw_parts(
                output.add(LENGTH_PREFIX),
                length,
            ))
            .unwrap()
            .to_string();

            nac_free(input, request.len());
            nac_free(output, LENGTH_PREFIX + length);

            assert!(body.contains(r#""ok":true"#), "{body}");
            assert!(body.contains(crate::VERSION), "{body}");
        }
    }
}
