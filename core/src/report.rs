//! フォーム入力の正規化と、画面・計算書 PDF が共有する計算結果の組み立て。
//!
//! 「入力欄の文字列をどう釘座標として読むか」「計算できない入力をどう説明
//! するか」「結果を何桁で見せるか」まで含めてここに置く。画面（wasm）と
//! サーバ（同じ .wasm）は同じ関数を呼ぶので、編集中に見ている数値と計算書
//! PDF に刷られる数値が食い違うことがない。
//!
//! 移植元は GAS 版 gas-timber-panel-shear-calculator と、その Python 移植
//! （backend/app/panel_shear.py の計算部分）。

use crate::format::{format_int, significant, SIGNIFICANT_DIGITS};
use crate::json::Value;
use crate::nail_array::{self, Nail};

/// 1 パターンあたりの釘の上限。実務の面材 1 枚では 100 本程度なので十分に
/// 余裕がある。桁を間違えた入力（格子に 0〜1000 を 1mm 刻みで書くなど）で
/// 計算とページ描画が止まらないようにするための歯止め。
pub const MAX_NAILS: usize = 2000;
pub const MAX_PATTERNS: usize = 50;

/// 釘配列図に添える座標値の有効桁数（図は小さいので本文より粗くする）。
const DIAGRAM_AXIS_DIGITS: usize = 4;

/// 1 パターン分の入力。
#[derive(Debug, Clone, PartialEq)]
pub struct Pattern {
    pub pattern_id: String,
    pub pattern_name: String,
    pub width: f64,
    pub height: f64,
    pub mode: String,
    pub grid_x: String,
    pub grid_y: String,
    pub coords: String,
}

/// フォーム全体の入力（1 ファイル = 1 物件）。
#[derive(Debug, Clone, PartialEq)]
pub struct FormData {
    pub project_name: String,
    pub issued_on: String,
    pub patterns: Vec<Pattern>,
}

impl Pattern {
    pub fn panel_area(&self) -> f64 {
        self.width * self.height
    }

    pub fn to_value(&self) -> Value {
        Value::obj([
            ("patternId", self.pattern_id.clone().into()),
            ("patternName", self.pattern_name.clone().into()),
            ("width", self.width.into()),
            ("height", self.height.into()),
            ("mode", self.mode.clone().into()),
            ("gridX", self.grid_x.clone().into()),
            ("gridY", self.grid_y.clone().into()),
            ("coords", self.coords.clone().into()),
        ])
    }
}

impl FormData {
    pub fn to_value(&self) -> Value {
        Value::obj([
            ("projectName", self.project_name.clone().into()),
            ("issuedOn", self.issued_on.clone().into()),
            (
                "patterns",
                Value::Arr(self.patterns.iter().map(Pattern::to_value).collect()),
            ),
        ])
    }
}

// --- 入力の正規化 ------------------------------------------------------------

/// 受け取った本文を、このツールが扱う形へ整える。
///
/// 未知のキーは捨て、パターンは 1 つ以上に整える（空のフォームでも
/// 「パターンが 1 つある」状態から始められるようにする）。
pub fn normalize_data(data: &Value) -> Result<FormData, String> {
    if !matches!(data, Value::Obj(_)) {
        return Err("入力データがありません。".to_string());
    }

    let raw_patterns = match data.get("patterns") {
        Some(Value::Arr(items)) => items.as_slice(),
        _ => &[],
    };
    if raw_patterns.len() > MAX_PATTERNS {
        return Err(format!("パターンは {MAX_PATTERNS} 個までです。"));
    }

    let mut patterns = Vec::with_capacity(raw_patterns.len().max(1));
    for (index, pattern) in raw_patterns.iter().enumerate() {
        patterns.push(normalize_pattern(pattern, index)?);
    }
    if patterns.is_empty() {
        patterns.push(normalize_pattern(&Value::Null, 0)?);
    }

    Ok(FormData {
        project_name: text_of(data.get("projectName")),
        issued_on: text_of(data.get("issuedOn")),
        patterns,
    })
}

pub fn normalize_pattern(pattern: &Value, index: usize) -> Result<Pattern, String> {
    let pattern_id = match text_of(pattern.get("patternId")) {
        id if id.is_empty() => format!("p{}", index + 1),
        id => id,
    };
    let mode = match text_of(pattern.get("mode")) {
        mode if mode == "coords" => "coords".to_string(),
        _ => "grid".to_string(),
    };
    Ok(Pattern {
        pattern_id,
        pattern_name: text_of(pattern.get("patternName")),
        width: float_of(pattern.get("width"), "面材の幅 W")?,
        height: float_of(pattern.get("height"), "面材の高さ H")?,
        mode,
        grid_x: text_of(pattern.get("gridX")),
        grid_y: text_of(pattern.get("gridY")),
        coords: text_of(pattern.get("coords")),
    })
}

/// 文字列として読む（前後の空白は落とす）。数値で送られてきても受け取る。
fn text_of(value: Option<&Value>) -> String {
    match value {
        Some(Value::Str(text)) => text.trim().to_string(),
        Some(Value::Num(number)) => Value::Num(*number).to_json(),
        _ => String::new(),
    }
}

/// 数値として読む。未入力（欠落・null・空文字）は 0 とみなす。
fn float_of(value: Option<&Value>, label: &str) -> Result<f64, String> {
    let number = match value {
        None | Some(Value::Null) => return Ok(0.0),
        Some(Value::Num(number)) => *number,
        Some(Value::Str(text)) => {
            let text = text.trim();
            if text.is_empty() {
                return Ok(0.0);
            }
            text.parse::<f64>()
                .map_err(|_| format!("{label}には数値を入力してください。"))?
        }
        Some(_) => return Err(format!("{label}には数値を入力してください。")),
    };
    if !number.is_finite() {
        return Err(format!("{label}には有限の数値を入力してください。"));
    }
    Ok(number)
}

/// 「0, 445, 890」のようなカンマ・空白区切りの数値列を読む。
///
/// 区切りは半角・全角どちらの読点・空白でもよく、数字が全角（４４５）でも
/// 読む。日本語入力のまま打ち込んだ座標を、入力し直させないため。
pub fn parse_number_list(text: &str) -> Vec<f64> {
    text.split(|character: char| {
        matches!(character, ',' | '，' | '、') || character.is_whitespace()
    })
        .filter(|token| !token.is_empty())
        .filter_map(|token| to_halfwidth(token).parse::<f64>().ok())
        .filter(|number| number.is_finite())
        .collect()
}

/// 全角の数字・符号・小数点を半角へ直す（それ以外の文字はそのまま）。
fn to_halfwidth(token: &str) -> String {
    token
        .chars()
        .map(|character| match character {
            '０'..='９' => char::from_u32(character as u32 - '０' as u32 + '0' as u32)
                .expect("全角数字は半角数字へ移せる"),
            '．' => '.',
            '＋' => '+',
            '－' | 'ー' | '−' => '-',
            other => other,
        })
        .collect()
}

/// 「x, y」を 1 行に 1 本ずつ書いた釘座標を読む。
pub fn parse_coord_lines(text: &str) -> Vec<Nail> {
    text.lines()
        .filter_map(|line| {
            let parts = parse_number_list(line);
            match parts.as_slice() {
                [x, y, ..] => Some(Nail { x: *x, y: *y }),
                _ => None,
            }
        })
        .collect()
}

/// このパターンを計算できない理由を返す（計算できるなら None）。
///
/// nail_array 側にも同じ状況を弾く guard があるが、あちらは計算式が壊れた
/// 入力を受け取らないための最終防衛線で、文言も式の言葉（「Ix + Iy が 0」）で
/// 書かれている。画面に出すのは、入力欄の言葉で書いたこちらの理由。
///
/// ここで挙げる 3 つが、入力から到達しうる計算不能のすべて:
///   - 釘が無い / 面積が 0     … nail_array::validate_input
///   - 釘が 1 点に集中している … Ix + Iy = 0
///   - 釘が 1 直線上に並ぶ     … Zx もしくは Zy が 0 → Zxy = 0
fn unusable_reason(pattern: &Pattern, nails: &[Nail]) -> Option<String> {
    if nails.is_empty() {
        return Some("釘座標が入力されていません。少なくとも 1 本の釘が必要です。".to_string());
    }
    if !(pattern.panel_area() > 0.0) {
        return Some("面材の幅 W と高さ H に正の数値を入力してください。".to_string());
    }

    let spread_x = nails.iter().any(|nail| nail.x != nails[0].x);
    let spread_y = nails.iter().any(|nail| nail.y != nails[0].y);
    if !spread_x && !spread_y {
        return Some("釘が 1 点に集中しているため、釘配列諸定数を求められません。".to_string());
    }
    if !spread_x || !spread_y {
        return Some(
            "釘が 1 直線上に並んでいるため、釘配列諸定数を求められません。\
             X 方向・Y 方向のどちらにも広がりが必要です。"
                .to_string(),
        );
    }
    None
}

/// 釘リストと、計算できない理由（計算できるなら None）を返す。
///
/// 理由をエラーではなく戻り値にしているのは、入力途中のパターンを画面へ
/// そのまま出すため。
fn nails_and_reason(pattern: &Pattern) -> (Vec<Nail>, Option<String>) {
    let nails = if pattern.mode == "grid" {
        let xs = parse_number_list(&pattern.grid_x);
        let ys = parse_number_list(&pattern.grid_y);
        // 格子は組み合わせの数で増えるので、作る前に本数を確かめる。
        if xs.len() * ys.len() > MAX_NAILS {
            return (
                Vec::new(),
                Some(format!(
                    "釘の本数が多すぎます（{} × {} 本）。1 パターンあたり {} 本までにしてください。",
                    xs.len(),
                    ys.len(),
                    MAX_NAILS
                )),
            );
        }
        nail_array::build_rectangular_grid(&xs, &ys)
    } else {
        let nails = parse_coord_lines(&pattern.coords);
        if nails.len() > MAX_NAILS {
            return (
                Vec::new(),
                Some(format!(
                    "釘の本数が多すぎます（{} 本）。1 パターンあたり {} 本までにしてください。",
                    nails.len(),
                    MAX_NAILS
                )),
            );
        }
        nails
    };
    let reason = unusable_reason(pattern, &nails);
    (nails, reason)
}

/// パターンの入力方式に応じて釘リストを組み立てる（計算できない入力はエラー）。
pub fn nails_of(pattern: &Pattern) -> Result<Vec<Nail>, String> {
    let (nails, reason) = nails_and_reason(pattern);
    match reason {
        Some(reason) => Err(reason),
        None => Ok(nails),
    }
}

// --- 計算（画面と PDF が共有する表示用データ） ------------------------------

/// 全パターンを計算する。計算できないパターンは ok: false で返す。
///
/// 入力途中でも画面に出せるよう、1 つのパターンの不備で他のパターンの
/// 結果まで失わせない（保存時は validate() で改めて全件を確かめる）。
pub fn compute_all(data: &FormData) -> Value {
    Value::Arr(
        data.patterns
            .iter()
            .map(|pattern| {
                let (nails, reason) = nails_and_reason(pattern);
                // 理由が無ければ build_report は必ず成功する（失敗するのは
                // unusable_reason の判定漏れ＝不具合）。画面を落とさずに
                // 理由として見せるため、こちらも ok: false へ寄せる。
                let report = match reason {
                    Some(reason) => Err(reason),
                    None => build_report(pattern, &nails),
                };
                match report {
                    Ok(Value::Obj(mut entries)) => {
                        entries.insert(0, ("ok".to_string(), true.into()));
                        Value::Obj(entries)
                    }
                    Ok(_) => unreachable!("build_report はオブジェクトを返す"),
                    Err(error) => Value::obj([
                        ("ok", false.into()),
                        ("patternId", pattern.pattern_id.clone().into()),
                        ("patternName", pattern.pattern_name.clone().into()),
                        ("error", error.into()),
                    ]),
                }
            })
            .collect(),
    )
}

/// 保存できる状態か確かめ、全パターンの計算結果を返す。
pub fn validate(data: &FormData) -> Result<Vec<Value>, String> {
    let mut reports = Vec::with_capacity(data.patterns.len());
    for (index, pattern) in data.patterns.iter().enumerate() {
        let (nails, reason) = nails_and_reason(pattern);
        if let Some(reason) = reason {
            let name = if pattern.pattern_name.is_empty() {
                format!("パターン{}", index + 1)
            } else {
                pattern.pattern_name.clone()
            };
            return Err(format!("「{name}」を計算できません: {reason}"));
        }
        reports.push(build_report(pattern, &nails)?);
    }
    Ok(reports)
}

/// 1 パターンを計算し、画面表示にも PDF にも使える形で返す。
///
/// 表示用の文字列（有効桁・単位）まで組み立てて返すことで、画面と計算書で
/// 桁の丸め方が食い違わないようにしている。
pub fn compute_pattern(pattern: &Pattern) -> Result<Value, String> {
    let nails = nails_of(pattern)?;
    build_report(pattern, &nails)
}

fn nail_arrangement_text(pattern: &Pattern, nails: &[Nail]) -> String {
    if pattern.mode == "grid" {
        format!(
            "格子　X: {}　／　Y: {}",
            pattern.grid_x, pattern.grid_y
        )
    } else {
        format!("座標を直接入力（{} 点）", nails.len())
    }
}

/// 計算できると分かっているパターンの結果を組み立てる。
fn build_report(pattern: &Pattern, nails: &[Nail]) -> Result<Value, String> {
    let area = pattern.panel_area();
    let result = nail_array::compute(nails, area).map_err(|error| error.0)?;
    let six = |value: f64| significant(value, SIGNIFICANT_DIGITS);

    let step = |label: &str, equation: &str, value: String| {
        Value::obj([
            ("label", label.into()),
            ("eq", equation.into()),
            ("value", value.into()),
        ])
    };

    Ok(Value::obj([
        ("patternId", pattern.pattern_id.clone().into()),
        ("patternName", pattern.pattern_name.clone().into()),
        (
            "nails",
            Value::Arr(
                nails
                    .iter()
                    .map(|nail| Value::obj([("x", nail.x.into()), ("y", nail.y.into())]))
                    .collect(),
            ),
        ),
        ("panelArea", area.into()),
        (
            "result",
            Value::obj([
                ("n", result.n.into()),
                ("panel_area", result.panel_area.into()),
                ("x0", result.x0.into()),
                ("y0", result.y0.into()),
                ("Ix", result.ix.into()),
                ("Iy", result.iy.into()),
                ("Ixy", result.ixy.into()),
                ("dx_max", result.dx_max.into()),
                ("dy_max", result.dy_max.into()),
                ("Zx", result.zx.into()),
                ("Zy", result.zy.into()),
                ("Zxy", result.zxy.into()),
                ("alpha_x", result.alpha_x.into()),
                ("Zpxy", result.zpxy.into()),
                ("Cxy", result.cxy.into()),
            ]),
        ),
        (
            "inputs",
            Value::Arr(vec![
                Value::obj([
                    ("label", "面材寸法 W × H".into()),
                    (
                        "value",
                        format!(
                            "{} × {} mm",
                            format_int(pattern.width),
                            format_int(pattern.height)
                        )
                        .into(),
                    ),
                ]),
                Value::obj([
                    ("label", "面材面積 Aw".into()),
                    ("value", format!("{} mm²", format_int(area)).into()),
                ]),
                Value::obj([
                    ("label", "釘配列".into()),
                    ("value", nail_arrangement_text(pattern, nails).into()),
                ]),
                Value::obj([
                    ("label", "釘本数 n".into()),
                    (
                        "value",
                        format!("{} 本", format_int(result.n as f64)).into(),
                    ),
                ]),
            ]),
        ),
        (
            "summary",
            Value::Arr(vec![
                Value::obj([
                    ("key", "Ixy".into()),
                    ("unit", "mm²/mm²".into()),
                    ("value", six(result.ixy).into()),
                ]),
                Value::obj([
                    ("key", "Zxy".into()),
                    ("unit", "mm/mm²".into()),
                    ("value", six(result.zxy).into()),
                ]),
                Value::obj([
                    ("key", "Cxy".into()),
                    ("unit", "".into()),
                    ("value", six(result.cxy).into()),
                ]),
            ]),
        ),
        (
            "steps",
            Value::Arr(vec![
                step("釘本数 n", "", format_int(result.n as f64)),
                step("X方向 中立軸 x0", "(3.2.2b)", six(result.x0) + " mm"),
                step("Y方向 中立軸 y0", "(3.2.2a)", six(result.y0) + " mm"),
                step("二次モーメント Ix", "(3.2.2a)", format_int(result.ix) + " mm²"),
                step("二次モーメント Iy", "(3.2.2b)", format_int(result.iy) + " mm²"),
                step("Ixy", "(3.2.1)", six(result.ixy) + " mm²/mm²"),
                step("端部距離 (y-y0)max", "", six(result.dy_max) + " mm"),
                step("端部距離 (x-x0)max", "", six(result.dx_max) + " mm"),
                step("釘配列係数 Zx", "(3.2.4a)", six(result.zx) + " mm"),
                step("釘配列係数 Zy", "(3.2.4b)", six(result.zy) + " mm"),
                step("Zxy", "(3.2.3)", six(result.zxy) + " mm/mm²"),
                step("変形割合 αx", "(3.2.7)", six(result.alpha_x)),
                step("塑性釘配列係数 Zpxy", "(3.2.6)", six(result.zpxy) + " mm/mm²"),
                step("Cxy", "(3.2.5)", six(result.cxy)),
            ]),
        ),
        ("diagram", build_diagram(pattern, nails, &result)),
    ]))
}

/// 釘配列図に必要な「描く範囲・目盛・中立軸の見出し」をまとめる。
///
/// 画面の SVG と計算書 PDF は縮尺こそ違うが、範囲の取り方と目盛の文字は
/// 同じにしたい（同じ図の別サイズであってほしい）ので、幾何のうち縮尺に
/// 依らない部分をここで決める。範囲は「面材枠 (0,0)-(W,H) と全釘」の外接
/// 矩形。釘が面材からはみ出す配列でも切り取らず、はみ出していることが
/// 見えるようにするため。
fn build_diagram(pattern: &Pattern, nails: &[Nail], result: &nail_array::Constants) -> Value {
    let mut min_x = 0.0_f64;
    let mut max_x = pattern.width;
    let mut min_y = 0.0_f64;
    let mut max_y = pattern.height;
    for nail in nails {
        min_x = min_x.min(nail.x);
        max_x = max_x.max(nail.x);
        min_y = min_y.min(nail.y);
        max_y = max_y.max(nail.y);
    }

    let ticks = |values: &[f64]| {
        let mut unique: Vec<f64> = values.to_vec();
        unique.sort_by(|a, b| a.partial_cmp(b).expect("有限の座標のみ"));
        unique.dedup();
        Value::Arr(
            unique
                .into_iter()
                .map(|value| {
                    Value::obj([("value", value.into()), ("label", format_int(value).into())])
                })
                .collect(),
        )
    };

    let xs: Vec<f64> = nails.iter().map(|nail| nail.x).collect();
    let ys: Vec<f64> = nails.iter().map(|nail| nail.y).collect();

    Value::obj([
        ("minX", min_x.into()),
        ("maxX", max_x.into()),
        ("minY", min_y.into()),
        ("maxY", max_y.into()),
        ("xTicks", ticks(&xs)),
        ("yTicks", ticks(&ys)),
        (
            "axis",
            Value::obj([
                ("x0", result.x0.into()),
                ("y0", result.y0.into()),
                (
                    "xLabel",
                    format!("x0 = {}", significant(result.x0, DIAGRAM_AXIS_DIGITS)).into(),
                ),
                (
                    "yLabel",
                    format!("y0 = {}", significant(result.y0, DIAGRAM_AXIS_DIGITS)).into(),
                ),
            ]),
        ),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json;

    /// グレー本 解説の計算例（図 3.2.2）。W 910 × H 610 の横置きで、
    /// へりあき 10 mm を見込んだ座標（本は左下の釘を (0, 0) として書いている）。
    fn example_pattern() -> Pattern {
        Pattern {
            pattern_id: "p1".to_string(),
            pattern_name: "グレー本の計算例".to_string(),
            width: 910.0,
            height: 610.0,
            mode: "grid".to_string(),
            grid_x: "10, 455, 900".to_string(),
            grid_y: "10, 155, 305, 455, 600".to_string(),
            coords: String::new(),
        }
    }

    fn normalize(text: &str) -> Result<FormData, String> {
        normalize_data(&json::parse(text).unwrap())
    }

    fn labelled(report: &Value, section: &str, key: &str) -> Vec<(String, String)> {
        report
            .get(section)
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                (
                    row.get(key).unwrap().as_str().unwrap().to_string(),
                    row.get("value").unwrap().as_str().unwrap().to_string(),
                )
            })
            .collect()
    }

    // --- 入力の正規化 --------------------------------------------------------

    #[test]
    fn keeps_only_known_keys() {
        let data =
            normalize(r#"{"projectName": " 邸 ", "unknown": 1, "patterns": [{"width": "610", "junk": 2}]}"#)
                .unwrap();
        assert_eq!(data.project_name, "邸");
        assert_eq!(data.patterns[0].width, 610.0);
        assert_eq!(data.to_value().get("unknown"), None);
    }

    /// パターンが 1 つも無い入力でも、画面が編集を始められる形にする。
    #[test]
    fn gives_an_empty_form_one_pattern() {
        let data = normalize("{}").unwrap();
        assert_eq!(data.patterns.len(), 1);
        assert_eq!(data.patterns[0].pattern_id, "p1");
        assert_eq!(data.patterns[0].mode, "grid");
    }

    #[test]
    fn rejects_a_non_numeric_dimension() {
        let error = normalize(r#"{"patterns": [{"width": "ろく"}]}"#).unwrap_err();
        assert!(error.contains("面材の幅 W"), "{error}");
    }

    #[test]
    fn rejects_too_many_patterns() {
        let patterns = vec![r#"{"width": 1}"#; MAX_PATTERNS + 1].join(",");
        let error = normalize(&format!(r#"{{"patterns": [{patterns}]}}"#)).unwrap_err();
        assert!(error.contains("パターンは"), "{error}");
    }

    #[test]
    fn parses_number_lists_ignoring_separators_and_junk() {
        assert_eq!(
            parse_number_list("0, 445  890\n1200"),
            vec![0.0, 445.0, 890.0, 1200.0]
        );
        assert_eq!(parse_number_list("0, あ, 445"), vec![0.0, 445.0]);
        assert!(parse_number_list("").is_empty());
    }

    /// 日本語入力のまま打ち込んでも読めること（打ち直させない）。
    #[test]
    fn parses_full_width_numbers_and_separators() {
        assert_eq!(
            parse_number_list("０、４４５　８９０"),
            vec![0.0, 445.0, 890.0]
        );
        assert_eq!(parse_number_list("−１２．５，３"), vec![-12.5, 3.0]);
    }

    #[test]
    fn parses_two_numbers_per_coordinate_line() {
        let nails = parse_coord_lines("0, 0\n445 295\n\n910\n");
        assert_eq!(
            nails,
            vec![Nail { x: 0.0, y: 0.0 }, Nail { x: 445.0, y: 295.0 }]
        );
    }

    #[test]
    fn a_grid_is_every_combination() {
        assert_eq!(nails_of(&example_pattern()).unwrap().len(), 15);
    }

    /// 桁を間違えた入力で計算とページ描画が止まらないようにする。
    #[test]
    fn rejects_an_absurd_grid() {
        let axis = (0..100).map(|i| i.to_string()).collect::<Vec<_>>().join(",");
        let pattern = Pattern {
            grid_x: axis.clone(),
            grid_y: axis,
            ..example_pattern()
        };
        let error = nails_of(&pattern).unwrap_err();
        assert!(error.contains("釘の本数が多すぎます"), "{error}");
    }

    // --- 計算 ----------------------------------------------------------------

    #[test]
    fn the_reference_example_matches_the_book() {
        let report = compute_pattern(&example_pattern()).unwrap();

        assert_eq!(
            labelled(&report, "summary", "key"),
            vec![
                ("Ixy".to_string(), "0.888868".to_string()),
                ("Zxy".to_string(), "0.00358851".to_string()),
                ("Cxy".to_string(), "1.26155".to_string()),
            ]
        );
        assert_eq!(report.get("nails").unwrap().as_array().unwrap().len(), 15);
        assert_eq!(report.get("panelArea").unwrap().as_f64(), Some(555100.0));

        let steps = labelled(&report, "steps", "label");
        let step = |label: &str| {
            steps
                .iter()
                .find(|(name, _)| name == label)
                .map(|(_, value)| value.clone())
                .unwrap()
        };
        // 本は左下の釘を原点にしているので x0 = 445.0。ここはへりあき
        // 10 mm を見込んで面材の左下を原点にするため、その分だけ動く。
        assert_eq!(step("X方向 中立軸 x0"), "455.000 mm");
        assert_eq!(step("二次モーメント Iy"), "1,980,250 mm²");
        assert_eq!(step("変形割合 αx"), "0.750834");
    }

    #[test]
    fn the_inputs_section_repeats_what_was_typed() {
        let report = compute_pattern(&example_pattern()).unwrap();
        let inputs = labelled(&report, "inputs", "label");
        assert!(inputs.contains(&("面材寸法 W × H".to_string(), "910 × 610 mm".to_string())));
        assert!(inputs.contains(&("面材面積 Aw".to_string(), "555,100 mm²".to_string())));
        assert!(inputs.contains(&("釘本数 n".to_string(), "15 本".to_string())));
    }

    #[test]
    fn the_diagram_covers_the_panel_and_every_nail() {
        // へりあきを見込んだ配列なので、範囲は面材枠そのもの。
        let report = compute_pattern(&example_pattern()).unwrap();
        let diagram = report.get("diagram").unwrap();
        assert_eq!(diagram.get("minX").unwrap().as_f64(), Some(0.0));
        assert_eq!(diagram.get("maxX").unwrap().as_f64(), Some(910.0));
        assert_eq!(diagram.get("maxY").unwrap().as_f64(), Some(610.0));
        assert_eq!(diagram.get("xTicks").unwrap().as_array().unwrap().len(), 3);
        assert_eq!(diagram.get("yTicks").unwrap().as_array().unwrap().len(), 5);
        assert_eq!(
            diagram.get("axis").unwrap().get("xLabel").unwrap().as_str(),
            Some("x0 = 455.0")
        );
    }

    /// 釘が面材からはみ出す配列（入力の打ち間違い）は、切り取らずに
    /// 「はみ出していること」が見える範囲を返す。
    #[test]
    fn the_diagram_does_not_clip_nails_outside_the_panel() {
        let pattern = Pattern {
            width: 610.0,
            grid_x: "0, 445, 890".to_string(),
            ..example_pattern()
        };
        let report = compute_pattern(&pattern).unwrap();
        let diagram = report.get("diagram").unwrap();
        assert_eq!(diagram.get("maxX").unwrap().as_f64(), Some(890.0));
    }

    /// 計算できない理由は、式の言葉ではなく入力欄の言葉で伝える。
    #[test]
    fn unusable_patterns_are_explained_in_the_words_of_the_form() {
        let cases = [
            // 釘が無い / 面材の寸法が入っていない。
            (("610", "910", "", ""), "釘座標が入力されていません"),
            (("0", "910", "0, 445", "0, 295"), "面材の幅 W と高さ H に正の数値"),
            // 釘が 1 点に集中している（Ix + Iy = 0）。
            (("610", "910", "100", "200"), "1 点に集中している"),
            // 釘が 1 直線上に並ぶ（Zx もしくは Zy が 0 → Zxy = 0）。
            (("610", "910", "0, 445", "295"), "1 直線上に並んでいる"),
        ];
        for ((width, height, grid_x, grid_y), expected) in cases {
            let pattern = Pattern {
                width: width.parse().unwrap(),
                height: height.parse().unwrap(),
                grid_x: grid_x.to_string(),
                grid_y: grid_y.to_string(),
                ..example_pattern()
            };
            let error = compute_pattern(&pattern).unwrap_err();
            assert!(error.contains(expected), "{error} should mention {expected}");
        }
    }

    #[test]
    fn compute_all_reports_a_broken_pattern_without_losing_the_others() {
        let data = FormData {
            project_name: String::new(),
            issued_on: String::new(),
            patterns: vec![
                example_pattern(),
                Pattern {
                    pattern_id: "p2".to_string(),
                    grid_x: String::new(),
                    grid_y: String::new(),
                    ..example_pattern()
                },
            ],
        };

        let reports = compute_all(&data);
        let reports = reports.as_array().unwrap();

        assert_eq!(reports[0].get("ok"), Some(&Value::Bool(true)));
        assert_eq!(reports[1].get("ok"), Some(&Value::Bool(false)));
        assert!(reports[1]
            .get("error")
            .unwrap()
            .as_str()
            .unwrap()
            .contains("釘座標"));
    }

    #[test]
    fn validate_names_the_pattern_that_cannot_be_calculated() {
        let data = FormData {
            project_name: String::new(),
            issued_on: String::new(),
            patterns: vec![Pattern {
                pattern_name: "南面".to_string(),
                grid_x: String::new(),
                grid_y: String::new(),
                ..example_pattern()
            }],
        };
        let error = validate(&data).unwrap_err();
        assert!(error.contains("「南面」を計算できません"), "{error}");
    }

    #[test]
    fn coordinate_mode_reads_the_text_area() {
        let pattern = Pattern {
            mode: "coords".to_string(),
            coords: "0, 0\n0, 455\n455, 910".to_string(),
            ..example_pattern()
        };
        let report = compute_pattern(&pattern).unwrap();
        assert_eq!(report.get("nails").unwrap().as_array().unwrap().len(), 3);
        let inputs = labelled(&report, "inputs", "label");
        assert!(inputs.contains(&("釘配列".to_string(), "座標を直接入力（3 点）".to_string())));
    }
}
