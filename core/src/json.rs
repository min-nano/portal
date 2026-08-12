//! 最小限の JSON の読み書き。
//!
//! この crate は外部クレートに依存しない（Cargo.toml 参照）ため、受け渡しに
//! 使う JSON もここで完結させる。必要なのは「画面／サーバから受け取った
//! フォーム入力を読む」と「計算結果を書き出す」だけなので、機能は素朴で良い。

use std::fmt::Write as _;

/// JSON の値。オブジェクトは挿入順を保つよう連想配列ではなく列で持つ
/// （書き出した JSON の見た目が毎回同じになり、差分を追いやすい）。
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Value>),
    Obj(Vec<(String, Value)>),
}

/// 入れ子の深さの上限。壊れた（あるいは意地の悪い）入力で再帰が
/// 深くなりすぎないようにするための歯止め。
const MAX_DEPTH: usize = 64;

impl Value {
    /// オブジェクトを組み立てる。`Value::obj([("key", 1.into())])` のように使う。
    pub fn obj<const N: usize>(entries: [(&str, Value); N]) -> Value {
        Value::Obj(
            entries
                .into_iter()
                .map(|(key, value)| (key.to_string(), value))
                .collect(),
        )
    }

    /// オブジェクトのキーを引く（オブジェクト以外・キーが無い場合は None）。
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Obj(entries) => entries
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Num(number) => Some(*number),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(text) => Some(text),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Value::Arr(items) => Some(items),
            _ => None,
        }
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }

    /// JSON 文字列にする。
    pub fn to_json(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            Value::Null => out.push_str("null"),
            Value::Bool(true) => out.push_str("true"),
            Value::Bool(false) => out.push_str("false"),
            // 非有限値は JSON で表せない。計算結果には現れない（入力の時点で
            // 弾いている）が、書き出せない値を黙って壊さないよう null にする。
            Value::Num(number) if !number.is_finite() => out.push_str("null"),
            Value::Num(number) => {
                // Rust の既定の書式は「読み戻すと同じ値になる最短の表記」で、
                // 指数表記を使わない。JSON として妥当で、JavaScript の
                // JSON.parse / Python の json.loads がそのまま同じ値に戻す。
                let _ = write!(out, "{number}");
            }
            Value::Str(text) => write_string(out, text),
            Value::Arr(items) => {
                out.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    item.write(out);
                }
                out.push(']');
            }
            Value::Obj(entries) => {
                out.push('{');
                for (index, (key, value)) in entries.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    write_string(out, key);
                    out.push(':');
                    value.write(out);
                }
                out.push('}');
            }
        }
    }
}

impl From<f64> for Value {
    fn from(value: f64) -> Value {
        Value::Num(value)
    }
}

impl From<usize> for Value {
    fn from(value: usize) -> Value {
        Value::Num(value as f64)
    }
}

impl From<bool> for Value {
    fn from(value: bool) -> Value {
        Value::Bool(value)
    }
}

impl From<&str> for Value {
    fn from(value: &str) -> Value {
        Value::Str(value.to_string())
    }
}

impl From<String> for Value {
    fn from(value: String) -> Value {
        Value::Str(value)
    }
}

impl From<Vec<Value>> for Value {
    fn from(value: Vec<Value>) -> Value {
        Value::Arr(value)
    }
}

/// 文字列を JSON の文字列リテラルとして書く。
///
/// 非 ASCII はそのまま UTF-8 で出す（JSON として妥当で、受け手の
/// JavaScript / Python はどちらも UTF-8 で読む）。
fn write_string(out: &mut String, text: &str) {
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control if (control as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", control as u32);
            }
            other => out.push(other),
        }
    }
    out.push('"');
}

/// JSON 文字列を読む。
pub fn parse(text: &str) -> Result<Value, String> {
    let mut parser = Parser {
        bytes: text.as_bytes(),
        position: 0,
    };
    parser.skip_whitespace();
    let value = parser.value(0)?;
    parser.skip_whitespace();
    if parser.position != parser.bytes.len() {
        return Err("JSON の末尾に余分な文字があります。".to_string());
    }
    Ok(value)
}

struct Parser<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.position).copied()
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.position += 1;
        }
    }

    fn expect(&mut self, byte: u8) -> Result<(), String> {
        if self.peek() == Some(byte) {
            self.position += 1;
            Ok(())
        } else {
            Err(format!(
                "JSON の {} 文字目に '{}' が必要です。",
                self.position + 1,
                byte as char
            ))
        }
    }

    fn literal(&mut self, word: &str) -> Result<(), String> {
        if self.bytes[self.position..].starts_with(word.as_bytes()) {
            self.position += word.len();
            Ok(())
        } else {
            Err(format!("JSON の {} 文字目を読めません。", self.position + 1))
        }
    }

    fn value(&mut self, depth: usize) -> Result<Value, String> {
        if depth > MAX_DEPTH {
            return Err("JSON の入れ子が深すぎます。".to_string());
        }
        match self.peek() {
            Some(b'{') => self.object(depth),
            Some(b'[') => self.array(depth),
            Some(b'"') => Ok(Value::Str(self.string()?)),
            Some(b't') => self.literal("true").map(|()| Value::Bool(true)),
            Some(b'f') => self.literal("false").map(|()| Value::Bool(false)),
            Some(b'n') => self.literal("null").map(|()| Value::Null),
            Some(_) => self.number(),
            None => Err("JSON が空です。".to_string()),
        }
    }

    fn object(&mut self, depth: usize) -> Result<Value, String> {
        self.expect(b'{')?;
        let mut entries = Vec::new();
        self.skip_whitespace();
        if self.peek() == Some(b'}') {
            self.position += 1;
            return Ok(Value::Obj(entries));
        }
        loop {
            self.skip_whitespace();
            let key = self.string()?;
            self.skip_whitespace();
            self.expect(b':')?;
            self.skip_whitespace();
            let value = self.value(depth + 1)?;
            entries.push((key, value));
            self.skip_whitespace();
            match self.peek() {
                Some(b',') => self.position += 1,
                Some(b'}') => {
                    self.position += 1;
                    return Ok(Value::Obj(entries));
                }
                _ => return Err("JSON のオブジェクトが閉じていません。".to_string()),
            }
        }
    }

    fn array(&mut self, depth: usize) -> Result<Value, String> {
        self.expect(b'[')?;
        let mut items = Vec::new();
        self.skip_whitespace();
        if self.peek() == Some(b']') {
            self.position += 1;
            return Ok(Value::Arr(items));
        }
        loop {
            self.skip_whitespace();
            items.push(self.value(depth + 1)?);
            self.skip_whitespace();
            match self.peek() {
                Some(b',') => self.position += 1,
                Some(b']') => {
                    self.position += 1;
                    return Ok(Value::Arr(items));
                }
                _ => return Err("JSON の配列が閉じていません。".to_string()),
            }
        }
    }

    fn string(&mut self) -> Result<String, String> {
        self.expect(b'"')?;
        let mut text = String::new();
        loop {
            let byte = self
                .peek()
                .ok_or_else(|| "JSON の文字列が閉じていません。".to_string())?;
            match byte {
                b'"' => {
                    self.position += 1;
                    return Ok(text);
                }
                b'\\' => {
                    self.position += 1;
                    let escape = self
                        .peek()
                        .ok_or_else(|| "JSON の文字列が閉じていません。".to_string())?;
                    self.position += 1;
                    match escape {
                        b'"' => text.push('"'),
                        b'\\' => text.push('\\'),
                        b'/' => text.push('/'),
                        b'b' => text.push('\u{08}'),
                        b'f' => text.push('\u{0c}'),
                        b'n' => text.push('\n'),
                        b'r' => text.push('\r'),
                        b't' => text.push('\t'),
                        b'u' => text.push(self.unicode_escape()?),
                        _ => return Err("JSON の文字列に不正なエスケープがあります。".to_string()),
                    }
                }
                _ => {
                    // UTF-8 の続きのバイトをまとめて写す（入力は &str なので
                    // 文字境界は必ず正しい）。
                    let start = self.position;
                    while let Some(next) = self.peek() {
                        if next == b'"' || next == b'\\' {
                            break;
                        }
                        self.position += 1;
                    }
                    text.push_str(
                        std::str::from_utf8(&self.bytes[start..self.position])
                            .map_err(|_| "JSON の文字列を読めません。".to_string())?,
                    );
                }
            }
        }
    }

    /// `\uXXXX`（必要ならサロゲートペア）を 1 文字に戻す。
    fn unicode_escape(&mut self) -> Result<char, String> {
        let first = self.hex4()?;
        let code = if (0xd800..0xdc00).contains(&first) {
            // 上位サロゲート。続く \uXXXX と組にして 1 文字にする。
            if self.peek() == Some(b'\\') && self.bytes.get(self.position + 1) == Some(&b'u') {
                self.position += 2;
                let second = self.hex4()?;
                if (0xdc00..0xe000).contains(&second) {
                    0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00)
                } else {
                    return Err("JSON の文字列に不正なサロゲートがあります。".to_string());
                }
            } else {
                return Err("JSON の文字列に不正なサロゲートがあります。".to_string());
            }
        } else {
            first
        };
        char::from_u32(code).ok_or_else(|| "JSON の文字列に不正な文字があります。".to_string())
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let end = self.position + 4;
        let digits = self
            .bytes
            .get(self.position..end)
            .ok_or_else(|| "JSON の \\u エスケープが短すぎます。".to_string())?;
        let text = std::str::from_utf8(digits)
            .map_err(|_| "JSON の \\u エスケープを読めません。".to_string())?;
        let code = u32::from_str_radix(text, 16)
            .map_err(|_| "JSON の \\u エスケープを読めません。".to_string())?;
        self.position = end;
        Ok(code)
    }

    fn number(&mut self) -> Result<Value, String> {
        let start = self.position;
        while let Some(byte) = self.peek() {
            match byte {
                b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9' => self.position += 1,
                _ => break,
            }
        }
        let text = std::str::from_utf8(&self.bytes[start..self.position])
            .map_err(|_| "JSON の数値を読めません。".to_string())?;
        text.parse::<f64>()
            .map(Value::Num)
            .map_err(|_| format!("JSON の数値 \"{text}\" を読めません。"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_an_object() {
        let value = parse(r#"{"a": 1, "b": [true, null, "x"]}"#).unwrap();
        assert_eq!(value.get("a").unwrap().as_f64(), Some(1.0));
        assert_eq!(value.get("b").unwrap().as_array().unwrap().len(), 3);
        assert!(value.get("c").is_none());
    }

    #[test]
    fn round_trips_japanese_text_and_escapes() {
        let value = parse(r#"{"name": "○○邸\n\"南面\"\t\\"}"#).unwrap();
        assert_eq!(value.get("name").unwrap().as_str(), Some("○○邸\n\"南面\"\t\\"));
        assert_eq!(parse(&value.to_json()).unwrap(), value);
    }

    #[test]
    fn reads_unicode_escapes_including_surrogate_pairs() {
        let value = parse(r#"["釘", "😀"]"#).unwrap();
        let items = value.as_array().unwrap();
        assert_eq!(items[0].as_str(), Some("釘"));
        assert_eq!(items[1].as_str(), Some("😀"));
    }

    #[test]
    fn writes_integral_numbers_without_a_decimal_point() {
        assert_eq!(Value::Num(555100.0).to_json(), "555100");
        assert_eq!(Value::Num(0.5).to_json(), "0.5");
        assert_eq!(Value::Num(f64::NAN).to_json(), "null");
    }

    #[test]
    fn keeps_the_order_of_object_keys() {
        let value = Value::obj([("b", 1.0.into()), ("a", 2.0.into())]);
        assert_eq!(value.to_json(), r#"{"b":1,"a":2}"#);
    }

    #[test]
    fn rejects_broken_input() {
        for text in ["", "{", "[1,]", r#"{"a" 1}"#, "1 2", "\"unterminated"] {
            assert!(parse(text).is_err(), "{text} should be rejected");
        }
    }

    #[test]
    fn rejects_deeply_nested_input() {
        let text = "[".repeat(200) + &"]".repeat(200);
        assert!(parse(&text).is_err());
    }
}
