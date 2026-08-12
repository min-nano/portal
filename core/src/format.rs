//! 画面と計算書 PDF が共有する、数値の見せ方。
//!
//! 「画面では 0.0036、計算書では 0.00359」のような食い違いが起きないよう、
//! 表示用の文字列はここだけで作る。丸めの結果は文字列として wasm の外へ
//! 出るので、画面（JavaScript）とサーバ（Python）は整形を一切しない。

/// 有効桁数。Zxy ≈ 0.0036 のように小さい値でも Cxy = Zpxy / Zxy を自分で
/// 検算できるだけの桁を確保する（GAS 版の画面表示と同じ 6 桁）。
pub const SIGNIFICANT_DIGITS: usize = 6;

/// 有効桁数で整形する（整数部には 3 桁区切りを付ける）。
///
/// 「小数点以下の桁数」を固定すると、Zxy ≈ 0.0036 や Zpxy ≈ 0.0045 のような
/// 小さい値で有効桁が 2 桁しか出ず、Cxy = Zpxy / Zxy の検算ができない。
/// そのため丸めは有効桁で行い、末尾の 0 も有効桁として残す。
pub fn significant(value: f64, digits: usize) -> String {
    if !value.is_finite() {
        return "-".to_string();
    }
    if value == 0.0 {
        return "0".to_string();
    }
    // 指数表記で一度丸める。桁数の判断に log10 を使わないのは、対数の
    // 最終桁が処理系で 1 ULP ずれると桁数が変わってしまうため
    // （指数表記の指数部は文字列として正確に読み取れる）。
    let digits = digits.max(1);
    let scientific = format!("{:.*e}", digits - 1, value);
    let (_, exponent_text) = scientific
        .split_once('e')
        .expect("Rust の指数表記は必ず 'e' を含む");
    let exponent: i32 = exponent_text.parse().expect("指数部は整数");
    // 先に有効桁で丸めてから桁数を数える（9.9999… が 10.000 へ繰り上がる
    // ときに有効桁が 1 桁増えてしまうのを防ぐ）。
    let rounded: f64 = scientific.parse().expect("指数表記は読み戻せる");
    let fraction_digits = (digits as i32 - 1 - exponent).clamp(0, 100) as usize;
    group_digits(&format!("{rounded:.fraction_digits$}"))
}

/// 整数として 3 桁区切りで整形する（釘本数・面材面積など）。
///
/// 端数は偶数丸め（0.5 は近い方の偶数へ）。Rust の書式指定と Python の
/// round() が同じ規則なので、移植の前後で表示が変わらない。
pub fn format_int(value: f64) -> String {
    if !value.is_finite() {
        return "-".to_string();
    }
    group_digits(&format!("{value:.0}"))
}

/// 入力された寸法を、打ち込まれたとおりの見た目で返す（へりあき・呼び径など）。
///
/// 有効桁で整形すると 10 mm が「10.0000 mm」になってしまい、入力欄の控えとして
/// 読みづらい。ここは末尾に 0 を足さず、10 → "10"、12.5 → "12.5" と出す。
pub fn format_dimension(value: f64) -> String {
    if !value.is_finite() {
        return "-".to_string();
    }
    group_digits(&format!("{value}"))
}

/// "-1234567.89" を "-1,234,567.89" にする。
fn group_digits(text: &str) -> String {
    let (sign, digits) = match text.strip_prefix('-') {
        Some(rest) => ("-", rest),
        None => ("", text),
    };
    let (integer, fraction) = match digits.split_once('.') {
        Some((integer, fraction)) => (integer, Some(fraction)),
        None => (digits, None),
    };

    let mut grouped = String::with_capacity(integer.len() + integer.len() / 3);
    for (index, character) in integer.chars().enumerate() {
        if index > 0 && (integer.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(character);
    }

    let mut out = String::new();
    // "-0" は符号を落として "0" にする（round(-0.4) の類が「-0」と出ない
    // ようにするため。Python の round() と同じ見た目になる）。
    if !(grouped == "0" && fraction.is_none()) {
        out.push_str(sign);
    }
    out.push_str(&grouped);
    if let Some(fraction) = fraction {
        out.push('.');
        out.push_str(fraction);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn six(value: f64) -> String {
        significant(value, SIGNIFICANT_DIGITS)
    }

    #[test]
    fn keeps_six_significant_digits() {
        assert_eq!(six(445.0), "445.000");
        assert_eq!(six(657150.0), "657,150");
        assert_eq!(six(0.0035885), "0.00358850");
        assert_eq!(six(1.2615536), "1.26155");
        assert_eq!(six(0.0), "0");
        assert_eq!(six(-2227.63), "-2,227.63");
    }

    #[test]
    fn does_not_gain_a_digit_when_rounding_carries() {
        // 9.999999 → 10.0000（有効 6 桁のまま）。
        assert_eq!(six(9.999999), "10.0000");
    }

    #[test]
    fn falls_back_to_a_dash_for_non_finite_values() {
        assert_eq!(six(f64::NAN), "-");
        assert_eq!(six(f64::INFINITY), "-");
        assert_eq!(format_int(f64::NAN), "-");
    }

    #[test]
    fn accepts_other_digit_counts() {
        assert_eq!(significant(445.0, 4), "445.0");
        assert_eq!(significant(1234.5678, 4), "1,235");
    }

    /// 入力された寸法は、打ち込まれたとおりの見た目で出す。
    #[test]
    fn formats_dimensions_without_padding_zeros() {
        assert_eq!(format_dimension(10.0), "10");
        assert_eq!(format_dimension(12.5), "12.5");
        assert_eq!(format_dimension(3.05), "3.05");
        assert_eq!(format_dimension(1820.0), "1,820");
        assert_eq!(format_dimension(f64::NAN), "-");
    }

    #[test]
    fn formats_integers_with_separators() {
        assert_eq!(format_int(555100.0), "555,100");
        assert_eq!(format_int(2227.63), "2,228");
        assert_eq!(format_int(0.0), "0");
        assert_eq!(format_int(-0.4), "0");
        assert_eq!(format_int(-1500.0), "-1,500");
        // 端数 0.5 は偶数側へ（Python の round() と同じ）。
        assert_eq!(format_int(0.5), "0");
        assert_eq!(format_int(1.5), "2");
        assert_eq!(format_int(2.5), "2");
    }
}
