//! 面材張り耐力要素 釘配列諸定数の**唯一の計算実装**。
//!
//! この crate をビルドした 1 つの .wasm を、画面（ブラウザ）とサーバ
//! （Cloud Run の FastAPI）の両方が読み込んで動かす。同じバイト列を同じ
//! 引数で呼ぶので、編集中に画面が出す数値と、保存時にサーバが計算書 PDF へ
//! 刷る数値は本来ぴったり一致する（それでも保存時に突き合わせて、食い違えば
//! 警告を出す。README「計算の一元管理（Rust → wasm）」参照）。
//!
//! 呼び出し口は 1 つだけで、JSON の要求を渡すと JSON の応答が返る:
//!
//! ```text
//! {"op": "computeAll", "data": {...}}  → {"ok": true,  "patterns": [...]}
//! {"op": "validate",   "data": {...}}  → {"ok": true,  "patterns": [...]}
//! {"op": "normalize",  "data": {...}}  → {"ok": true,  "data": {...}}
//! {"op": "config"}                     → {"ok": true,  "version": "1.0.0", ...}
//! 失敗                                  → {"ok": false, "error": "利用者に見せる日本語"}
//! ```
//!
//! wasm としての受け渡し（線形メモリの確保・解放）は abi.rs にある。

pub mod abi;
pub mod format;
pub mod json;
pub mod nail_array;
pub mod report;

use json::Value;

/// この計算実装の版。画面とサーバで食い違っていないかを保存時に確かめる
/// （画面が古いまま開きっぱなしのタブ、といった食い違いを拾うため）。
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// JSON の要求を処理して、JSON の応答を返す。
///
/// 応答は必ず `ok` を持つ。エラーは Result ではなく応答に載せる
/// （wasm の呼び出し側が、成功と失敗を同じ 1 回の呼び出しで受け取れる）。
pub fn call(request: &str) -> String {
    match dispatch(request) {
        Ok(Value::Obj(mut entries)) => {
            entries.insert(0, ("ok".to_string(), true.into()));
            Value::Obj(entries).to_json()
        }
        Ok(value) => value.to_json(),
        Err(error) => Value::obj([("ok", false.into()), ("error", error.into())]).to_json(),
    }
}

fn dispatch(request: &str) -> Result<Value, String> {
    let request = json::parse(request)?;
    let operation = request
        .get("op")
        .and_then(Value::as_str)
        .ok_or_else(|| "要求に op がありません。".to_string())?;
    let data = || request.get("data").unwrap_or(&Value::Null);

    match operation {
        "computeAll" => {
            let form = report::normalize_data(data())?;
            Ok(Value::obj([("patterns", report::compute_all(&form))]))
        }
        "validate" => {
            let form = report::normalize_data(data())?;
            Ok(Value::obj([(
                "patterns",
                Value::Arr(report::validate(&form)?),
            )]))
        }
        "normalize" => {
            let form = report::normalize_data(data())?;
            Ok(Value::obj([("data", form.to_value())]))
        }
        "config" => Ok(Value::obj([
            ("version", VERSION.into()),
            ("maxPatterns", report::MAX_PATTERNS.into()),
            ("maxNails", report::MAX_NAILS.into()),
            ("significantDigits", format::SIGNIFICANT_DIGITS.into()),
        ])),
        other => Err(format!("知らない操作です: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call_json(request: &str) -> Value {
        json::parse(&call(request)).unwrap()
    }

    #[test]
    fn compute_all_returns_one_entry_per_pattern() {
        let response = call_json(
            r#"{"op": "computeAll", "data": {"patterns": [
                 {"patternId": "p1", "width": 610, "height": 910,
                  "gridX": "0, 445, 890", "gridY": "0, 145, 295, 445, 590"},
                 {"patternId": "p2", "width": 610, "height": 910}
               ]}}"#,
        );

        assert_eq!(response.get("ok"), Some(&Value::Bool(true)));
        let patterns = response.get("patterns").unwrap().as_array().unwrap();
        assert_eq!(patterns.len(), 2);
        assert_eq!(patterns[0].get("ok"), Some(&Value::Bool(true)));
        assert_eq!(patterns[1].get("ok"), Some(&Value::Bool(false)));
    }

    #[test]
    fn validate_refuses_a_pattern_that_cannot_be_calculated() {
        let response = call_json(
            r#"{"op": "validate", "data": {"patterns": [
                 {"patternName": "南面", "width": 610, "height": 910}]}}"#,
        );

        assert_eq!(response.get("ok"), Some(&Value::Bool(false)));
        assert!(response
            .get("error")
            .unwrap()
            .as_str()
            .unwrap()
            .contains("「南面」を計算できません"));
    }

    #[test]
    fn normalize_drops_unknown_keys_and_fills_in_defaults() {
        let response = call_json(r#"{"op": "normalize", "data": {"junk": 1}}"#);

        let data = response.get("data").unwrap();
        assert_eq!(data.get("projectName").unwrap().as_str(), Some(""));
        assert_eq!(data.get("junk"), None);
        assert_eq!(data.get("patterns").unwrap().as_array().unwrap().len(), 1);
    }

    #[test]
    fn config_carries_the_version_and_the_limits() {
        let response = call_json(r#"{"op": "config"}"#);

        assert_eq!(response.get("version").unwrap().as_str(), Some(VERSION));
        assert_eq!(response.get("maxPatterns").unwrap().as_f64(), Some(50.0));
    }

    #[test]
    fn broken_requests_come_back_as_an_error_not_a_panic() {
        for request in ["", "{}", r#"{"op": "なにか"}"#, r#"{"op": "computeAll", "data": 1}"#] {
            let response = call_json(request);
            assert_eq!(
                response.get("ok"),
                Some(&Value::Bool(false)),
                "{request} should fail"
            );
            assert!(response.get("error").unwrap().as_str().is_some());
        }
    }
}
