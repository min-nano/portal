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
use crate::wall;

/// 1 パターンあたりの釘の上限。実務の面材 1 枚では 100 本程度なので十分に
/// 余裕がある。桁を間違えた入力（格子に 0〜1000 を 1mm 刻みで書くなど）で
/// 計算とページ描画が止まらないようにするための歯止め。
pub const MAX_NAILS: usize = 2000;
pub const MAX_PATTERNS: usize = 50;
/// 1 物件あたりの壁の上限と、壁 1 枚を構成する面材の上限。
pub const MAX_WALLS: usize = 50;
pub const MAX_WALL_PANELS: usize = 20;

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

/// 壁 1 枚分の入力（グレー本 3.3 の面材張り大壁）。
///
/// 面材の釘配列は「登録した釘配列パターンを選ぶ」形にしてある（patternId で
/// 指す）。同じ配列の面材を 2 枚使う壁なら、同じパターンを 2 回選べばよい。
#[derive(Debug, Clone, PartialEq)]
pub struct WallInput {
    pub wall_id: String,
    pub wall_name: String,
    /// 階高 H [mm]。
    pub height: f64,
    /// 壁の幅 W [mm]。
    pub width: f64,
    /// 表 3.3.1 から読み込んだ組合せの id（読み込んだ跡を残すだけで、計算には
    /// 使わない。読み込んだあと数値を手で直せるようにするため）。
    pub material_id: String,
    /// 面材の厚さ t [mm]。
    pub thickness: f64,
    /// 面材のせん断弾性係数 GB [kN/mm²]。
    pub shear_modulus: f64,
    /// 釘 1 本あたりの一面せん断: 剛性 k [kN/mm]。
    pub k: f64,
    /// 釘の降伏点変位 δv [mm]。
    pub delta_v: f64,
    /// 釘の終局変位 δu [mm]。
    pub delta_u: f64,
    /// 釘の降伏耐力 ΔPv [kN]。
    pub delta_pv: f64,
    /// 表 3.3.2 から読み込んだ規格の id（読み込んだ跡を残すだけ）。
    pub grade_id: String,
    /// 面材のせん断強度 τmax [N/mm²]。
    pub tau_max: f64,
    /// 繊維直交方向の曲げヤング係数 E1 [N/mm²]。
    pub e1: f64,
    /// 繊維平行方向の曲げヤング係数 E2 [N/mm²]。
    pub e2: f64,
    /// 中間材（間柱等）を設けるか。せん断座屈の ξ になる。
    pub has_intermediate_stud: bool,
    /// 壁を構成する面材。
    pub panels: Vec<WallPanelInput>,
}

/// 壁を構成する面材 1 枚分の入力。
#[derive(Debug, Clone, PartialEq)]
pub struct WallPanelInput {
    /// 面材として使う釘配列パターンの patternId。
    pub pattern_id: String,
    /// 面材の繊維方向（"" は長辺方向）。せん断座屈の a・b の取り方を決める。
    pub grain: String,
}

/// フォーム全体の入力（1 ファイル = 1 物件）。
#[derive(Debug, Clone, PartialEq)]
pub struct FormData {
    pub project_name: String,
    pub issued_on: String,
    pub patterns: Vec<Pattern>,
    pub walls: Vec<WallInput>,
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

impl WallInput {
    pub fn to_value(&self) -> Value {
        Value::obj([
            ("wallId", self.wall_id.clone().into()),
            ("wallName", self.wall_name.clone().into()),
            ("height", self.height.into()),
            ("width", self.width.into()),
            ("materialId", self.material_id.clone().into()),
            ("thickness", self.thickness.into()),
            ("shearModulus", self.shear_modulus.into()),
            ("k", self.k.into()),
            ("deltaV", self.delta_v.into()),
            ("deltaU", self.delta_u.into()),
            ("deltaPv", self.delta_pv.into()),
            ("gradeId", self.grade_id.clone().into()),
            ("tauMax", self.tau_max.into()),
            ("e1", self.e1.into()),
            ("e2", self.e2.into()),
            ("hasIntermediateStud", self.has_intermediate_stud.into()),
            (
                "panels",
                Value::Arr(
                    self.panels
                        .iter()
                        .map(|panel| {
                            Value::obj([
                                ("patternId", panel.pattern_id.clone().into()),
                                ("grain", panel.grain.clone().into()),
                            ])
                        })
                        .collect(),
                ),
            ),
        ])
    }

    fn sheathing(&self) -> wall::Sheathing {
        wall::Sheathing {
            thickness: self.thickness,
            shear_modulus: self.shear_modulus,
            tau_max: self.tau_max,
            e1: self.e1,
            e2: self.e2,
        }
    }

    fn nail(&self) -> wall::NailShear {
        wall::NailShear {
            k: self.k,
            delta_v: self.delta_v,
            delta_u: self.delta_u,
            delta_pv: self.delta_pv,
        }
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
            (
                "walls",
                Value::Arr(self.walls.iter().map(WallInput::to_value).collect()),
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

    // 壁は「あってもなくてもよい」節。釘配列諸定数だけを求めたい物件では
    // 0 枚のままにできる（パターンと違って 1 枚を補わない）。
    let raw_walls = match data.get("walls") {
        Some(Value::Arr(items)) => items.as_slice(),
        _ => &[],
    };
    if raw_walls.len() > MAX_WALLS {
        return Err(format!("壁は {MAX_WALLS} 枚までです。"));
    }
    let mut walls = Vec::with_capacity(raw_walls.len());
    for (index, item) in raw_walls.iter().enumerate() {
        walls.push(normalize_wall(item, index)?);
    }

    Ok(FormData {
        project_name: text_of(data.get("projectName")),
        issued_on: text_of(data.get("issuedOn")),
        patterns,
        walls,
    })
}

pub fn normalize_wall(item: &Value, index: usize) -> Result<WallInput, String> {
    let wall_id = match text_of(item.get("wallId")) {
        id if id.is_empty() => format!("w{}", index + 1),
        id => id,
    };

    let raw_panels = match item.get("panels") {
        Some(Value::Arr(items)) => items.as_slice(),
        _ => &[],
    };
    if raw_panels.len() > MAX_WALL_PANELS {
        return Err(format!(
            "1 枚の壁に選べる面材は {MAX_WALL_PANELS} 枚までです。"
        ));
    }
    let panels = raw_panels
        .iter()
        .map(|panel| WallPanelInput {
            pattern_id: text_of(panel.get("patternId")),
            grain: wall::Grain::from_id(&text_of(panel.get("grain")))
                .id()
                .to_string(),
        })
        // まだパターンを選んでいない行は、面材として数えない。
        .filter(|panel| !panel.pattern_id.is_empty())
        .collect();

    Ok(WallInput {
        wall_id,
        wall_name: text_of(item.get("wallName")),
        height: float_of(item.get("height"), "階高 H")?,
        width: float_of(item.get("width"), "壁の幅 W")?,
        material_id: text_of(item.get("materialId")),
        thickness: float_of(item.get("thickness"), "面材の厚さ t")?,
        shear_modulus: float_of(item.get("shearModulus"), "面材のせん断弾性係数 GB")?,
        k: float_of(item.get("k"), "釘のせん断剛性 k")?,
        delta_v: float_of(item.get("deltaV"), "釘の降伏点変位 δv")?,
        delta_u: float_of(item.get("deltaU"), "釘の終局変位 δu")?,
        delta_pv: float_of(item.get("deltaPv"), "釘の降伏耐力 ΔPv")?,
        grade_id: text_of(item.get("gradeId")),
        tau_max: float_of(item.get("tauMax"), "面材のせん断強度 τmax")?,
        e1: float_of(item.get("e1"), "曲げヤング係数 E1")?,
        e2: float_of(item.get("e2"), "曲げヤング係数 E2")?,
        has_intermediate_stud: matches!(item.get("hasIntermediateStud"), Some(Value::Bool(true))),
        panels,
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

/// 全ての壁を計算する。計算できない壁は ok: false で返す。
pub fn compute_all_walls(data: &FormData) -> Value {
    let library = PanelLibrary::of(data);
    Value::Arr(
        data.walls
            .iter()
            .enumerate()
            .map(|(index, input)| {
                match build_wall_report(input, &library, index) {
                    Ok(Value::Obj(mut entries)) => {
                        entries.insert(0, ("ok".to_string(), true.into()));
                        Value::Obj(entries)
                    }
                    Ok(_) => unreachable!("build_wall_report はオブジェクトを返す"),
                    Err(error) => Value::obj([
                        ("ok", false.into()),
                        ("wallId", input.wall_id.clone().into()),
                        ("wallName", input.wall_name.clone().into()),
                        ("error", error.into()),
                    ]),
                }
            })
            .collect(),
    )
}

/// 保存できる状態か確かめ、全ての壁の計算結果を返す。
pub fn validate_walls(data: &FormData) -> Result<Vec<Value>, String> {
    let library = PanelLibrary::of(data);
    let mut reports = Vec::with_capacity(data.walls.len());
    for (index, input) in data.walls.iter().enumerate() {
        reports.push(
            build_wall_report(input, &library, index)
                .map_err(|error| format!("「{}」を計算できません: {error}", wall_label(input, index)))?,
        );
    }
    Ok(reports)
}

/// 保存できる状態か確かめ、全パターンの計算結果を返す。
pub fn validate(data: &FormData) -> Result<Vec<Value>, String> {
    let mut reports = Vec::with_capacity(data.patterns.len());
    for (index, pattern) in data.patterns.iter().enumerate() {
        let (nails, reason) = nails_and_reason(pattern);
        if let Some(reason) = reason {
            return Err(format!(
                "「{}」を計算できません: {reason}",
                pattern_label(pattern, index)
            ));
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

// --- 壁の計算（グレー本 3.3） -----------------------------------------------

/// 壁の見出しに使う名前（未入力なら通し番号で代替する）。
fn wall_label(input: &WallInput, index: usize) -> String {
    if input.wall_name.is_empty() {
        format!("壁{}", index + 1)
    } else {
        input.wall_name.clone()
    }
}

/// 登録済みの釘配列パターンを、壁から patternId で引けるようにしたもの。
///
/// 壁は「登録した配列パターンを選ぶ」形で面材を指すので、1 つの壁が同じ
/// パターンを 2 回選ぶこともある。パターンごとの計算は 1 度だけにしたいので、
/// ここでまとめて済ませておく。
struct PanelLibrary<'a> {
    entries: Vec<(&'a Pattern, String, Result<nail_array::Constants, String>)>,
}

impl<'a> PanelLibrary<'a> {
    fn of(data: &'a FormData) -> PanelLibrary<'a> {
        PanelLibrary {
            entries: data
                .patterns
                .iter()
                .enumerate()
                .map(|(index, pattern)| {
                    let constants = nails_of(pattern).and_then(|nails| {
                        nail_array::compute(&nails, pattern.panel_area())
                            .map_err(|error| error.0)
                    });
                    (pattern, pattern_label(pattern, index), constants)
                })
                .collect(),
        }
    }

    /// 壁が選んだ 1 枚分を、面材の入力として組み立てる。
    fn get(&self, panel: &WallPanelInput) -> Result<wall::PanelSpec, String> {
        let (pattern, name, constants) = self
            .entries
            .iter()
            .find(|(pattern, _, _)| pattern.pattern_id == panel.pattern_id)
            .ok_or_else(|| {
                "選ばれた釘配列パターンが見つかりません。面材を選び直してください。".to_string()
            })?;
        let constants = constants.as_ref().map_err(|reason| {
            format!(
                "釘配列パターン「{}」を計算できません: {reason}",
                pattern.pattern_name
            )
        })?;
        Ok(wall::PanelSpec::new(
            name,
            constants,
            pattern.width,
            pattern.height,
            wall::Grain::from_id(&panel.grain),
        ))
    }
}

/// パターンの見出しに使う名前（未入力なら通し番号で代替する）。
fn pattern_label(pattern: &Pattern, index: usize) -> String {
    if pattern.pattern_name.is_empty() {
        format!("パターン{}", index + 1)
    } else {
        pattern.pattern_name.clone()
    }
}

/// 壁 1 枚の結果を、画面表示にも PDF にも使える形で組み立てる。
fn build_wall_report(
    input: &WallInput,
    library: &PanelLibrary,
    index: usize,
) -> Result<Value, String> {
    if input.panels.is_empty() {
        return Err(
            "壁を構成する面材がありません。登録した釘配列パターンから 1 枚以上選んでください。"
                .to_string(),
        );
    }
    let panels = input
        .panels
        .iter()
        .map(|panel| library.get(panel))
        .collect::<Result<Vec<_>, _>>()?;

    let result = wall::compute(&wall::Wall {
        height: input.height,
        width: input.width,
        sheathing: input.sheathing(),
        nail: input.nail(),
        has_intermediate_stud: input.has_intermediate_stud,
        panels,
    })
    .map_err(|error| error.0)?;

    let six = |value: f64| significant(value, SIGNIFICANT_DIGITS);
    let step = |label: &str, equation: &str, value: String| {
        Value::obj([
            ("label", label.into()),
            ("eq", equation.into()),
            ("value", value.into()),
        ])
    };
    let row = |label: &str, value: String| {
        Value::obj([("label", label.into()), ("value", value.into())])
    };

    let mut inputs = vec![
        row("階高 H", format!("{} mm", format_int(input.height))),
        row("壁の幅 W", format!("{} mm", format_int(input.width))),
    ];
    if let Some(material) = wall::find_material(&input.material_id) {
        inputs.push(row("面材と釘の組合せ", material.label()));
    }
    inputs.push(row(
        "面材の厚さ t",
        format!("{} mm", six(input.thickness)),
    ));
    inputs.push(row(
        "面材のせん断弾性係数 GB",
        format!("{} kN/mm²", six(input.shear_modulus)),
    ));
    inputs.push(row(
        "釘 1 本あたりの一面せん断",
        format!(
            "k = {} kN/mm　δv = {} mm　δu = {} mm　ΔPv = {} kN",
            six(input.k),
            six(input.delta_v),
            six(input.delta_u),
            six(input.delta_pv)
        ),
    ));
    if let Some(grade) = wall::find_grade(&input.grade_id) {
        inputs.push(row("面材の規格", grade.label()));
    }
    inputs.push(row(
        "面材のせん断強度・曲げヤング係数",
        format!(
            "τmax = {} N/mm²　E1 = {} N/mm²　E2 = {} N/mm²",
            six(input.tau_max),
            format_int(input.e1),
            format_int(input.e2)
        ),
    ));
    inputs.push(row(
        "中間材（間柱等）",
        format!(
            "{}（せん断座屈の ξ = {}）",
            if input.has_intermediate_stud {
                "あり"
            } else {
                "なし"
            },
            format_int(result.xi)
        ),
    ));
    inputs.push(row(
        "面材の枚数",
        format!("{} 枚", format_int(result.panels.len() as f64)),
    ));

    // 面材のせん断破壊・せん断座屈の検定で、いちばん余裕の少ない面材。
    let worst = |ratio: fn(&wall::PanelResult) -> f64| {
        result
            .panels
            .iter()
            .max_by(|left, right| {
                ratio(left)
                    .partial_cmp(&ratio(right))
                    .expect("検定の値は有限")
            })
            .expect("面材は 1 枚以上")
    };
    // τmax は壁の中で共通なので、せん断破壊は τN がいちばん大きい面材で決まる。
    let worst_shear = worst(|panel| panel.tau_n);
    // τcr は面材ごとに違うので、座屈は τN/τcr がいちばん大きい面材で決まる。
    let worst_buckling = worst(|panel| panel.tau_n / panel.tau_cr);

    Ok(Value::obj([
        ("wallId", input.wall_id.clone().into()),
        ("wallName", wall_label(input, index).into()),
        ("inputs", Value::Arr(inputs)),
        (
            "panelColumns",
            Value::Arr(
                [
                    "面材（釘配列パターン）",
                    "Aw [mm²]",
                    "Ixy",
                    "Zxy",
                    "Cxy",
                    "K0 [kN·mm/rad]",
                    "My [kN·mm]",
                    "Mu [kN·mm]",
                    "μ",
                ]
                .into_iter()
                .map(Value::from)
                .collect(),
            ),
        ),
        (
            "panels",
            Value::Arr(
                result
                    .panels
                    .iter()
                    .map(|panel| {
                        Value::obj([
                            ("label", panel.spec.label.clone().into()),
                            (
                                "cells",
                                Value::Arr(
                                    [
                                        format_int(panel.spec.area),
                                        six(panel.spec.ixy),
                                        six(panel.spec.zxy),
                                        six(panel.spec.cxy),
                                        format_int(panel.k0),
                                        format_int(panel.my),
                                        format_int(panel.mu),
                                        six(panel.ductility),
                                    ]
                                    .into_iter()
                                    .map(Value::from)
                                    .collect(),
                                ),
                            ),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "summary",
            Value::Arr(vec![
                Value::obj([
                    ("key", "K".into()),
                    ("unit", "kN/rad".into()),
                    ("value", six(result.k).into()),
                ]),
                Value::obj([
                    ("key", "Pa".into()),
                    ("unit", "kN".into()),
                    ("value", six(result.pa).into()),
                ]),
                Value::obj([
                    ("key", "ΔPa".into()),
                    ("unit", "kN/m".into()),
                    ("value", six(result.delta_pa).into()),
                ]),
            ]),
        ),
        (
            "steps",
            Value::Arr(vec![
                step(
                    "回転剛性 K0（面材ごとの和）",
                    "(3.3.3)",
                    format_int(result.k0) + " kN·mm/rad",
                ),
                step("面内せん断剛性 K = K0 / H", "(3.3.2)", six(result.k) + " kN/rad"),
                step(
                    "変形角 1/150 時のモーメント K0/150",
                    "(3.3.1)",
                    format_int(result.m150) + " kN·mm",
                ),
                step(
                    "降伏モーメント My（面材ごとの和）",
                    "(3.3.5)",
                    format_int(result.my) + " kN·mm",
                ),
                step(
                    "終局モーメント Mu（面材ごとの和）",
                    "(3.3.6)",
                    format_int(result.mu) + " kN·mm",
                ),
                step(
                    "塑性率 μ（面材ごとの最小値）",
                    "(3.3.7)",
                    six(result.ductility),
                ),
                step(
                    "終局時のモーメント 0.2√(2μ−1)×Mu",
                    "(3.3.1)",
                    format_int(result.ultimate_moment) + " kN·mm",
                ),
                step(
                    "許容せん断耐力 Pa = min{ My, K0/150, 0.2√(2μ−1)×Mu } / H",
                    "(3.3.1)",
                    six(result.pa) + " kN",
                ),
                step(
                    "壁長さあたりの許容せん断耐力 ΔPa = Pa / W",
                    "",
                    six(result.delta_pa) + " kN/m",
                ),
                step("Pa を決めた項", "", result.governing.label().to_string()),
            ]),
        ),
        (
            "bucklingColumns",
            Value::Arr(
                [
                    "面材（釘配列パターン）",
                    "繊維方向",
                    "a [mm]",
                    "b [mm]",
                    "β",
                    "τN [N/mm²]",
                    "τmax [N/mm²]",
                    "τcr [N/mm²]",
                    "判定",
                ]
                .into_iter()
                .map(Value::from)
                .collect(),
            ),
        ),
        (
            "buckling",
            Value::Arr(
                result
                    .panels
                    .iter()
                    .map(|panel| {
                        Value::obj([
                            ("label", panel.spec.label.clone().into()),
                            ("ok", (panel.shear_ok && panel.buckling_ok).into()),
                            (
                                "cells",
                                Value::Arr(
                                    [
                                        panel.spec.grain_label.to_string(),
                                        format_int(panel.spec.a),
                                        format_int(panel.spec.b),
                                        six(panel.beta),
                                        six(panel.tau_n),
                                        six(input.tau_max),
                                        six(panel.tau_cr),
                                        if panel.shear_ok && panel.buckling_ok {
                                            "OK".to_string()
                                        } else {
                                            "NG".to_string()
                                        },
                                    ]
                                    .into_iter()
                                    .map(Value::from)
                                    .collect(),
                                ),
                            ),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "checks",
            Value::Arr(vec![
                Value::obj([
                    ("label", "適用範囲 3.3(1)① 許容せん断耐力の上限".into()),
                    (
                        "value",
                        format!(
                            "ΔPa = {} kN/m {} {} kN/m",
                            six(result.delta_pa),
                            if result.within_limit { "≦" } else { ">" },
                            six(wall::ALLOWABLE_SHEAR_LIMIT)
                        )
                        .into(),
                    ),
                    ("ok", result.within_limit.into()),
                ]),
                Value::obj([
                    ("label", "面材のせん断破壊 τN < τmax（3.3.8）".into()),
                    (
                        "value",
                        // どの面材の値かは、上の面材ごとの表で分かる。ここは
                        // いちばん余裕の少ない面材の値だけを短く出す。
                        format!(
                            "最大 τN = {} N/mm² {} τmax = {} N/mm²",
                            six(worst_shear.tau_n),
                            if result.shear_ok { "<" } else { "≧" },
                            six(input.tau_max)
                        )
                        .into(),
                    ),
                    ("ok", result.shear_ok.into()),
                ]),
                Value::obj([
                    ("label", "面材のせん断座屈 τN < τcr（3.3.8）".into()),
                    (
                        "value",
                        format!(
                            "最大 τN/τcr の面材で τN = {} {} τcr = {} N/mm²",
                            six(worst_buckling.tau_n),
                            if result.buckling_ok { "<" } else { "≧" },
                            six(worst_buckling.tau_cr)
                        )
                        .into(),
                    ),
                    ("ok", result.buckling_ok.into()),
                ]),
            ]),
        ),
        (
            "result",
            Value::obj([
                ("K0", result.k0.into()),
                ("K", result.k.into()),
                ("M150", result.m150.into()),
                ("My", result.my.into()),
                ("Mu", result.mu.into()),
                ("mu", result.ductility.into()),
                ("Mu_term", result.ultimate_moment.into()),
                ("Pa", result.pa.into()),
                ("dPa", result.delta_pa.into()),
            ]),
        ),
        ("governing", result.governing.id().into()),
        ("withinLimit", result.within_limit.into()),
        ("shearOk", result.shear_ok.into()),
        ("bucklingOk", result.buckling_ok.into()),
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
            walls: Vec::new(),
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
            walls: Vec::new(),
        };
        let error = validate(&data).unwrap_err();
        assert!(error.contains("「南面」を計算できません"), "{error}");
    }

    // --- 壁の計算（グレー本 3.3） -------------------------------------------

    /// グレー本 3.3(3) の計算例（図 3.3.10）を、フォームの入力の形で組み立てる。
    ///
    /// 面材は表 3.2.1 の配列をそのまま登録し、壁はその 2 枚を選ぶ。釘 1 本
    /// あたりの数値は、本文が計算に使っているものをそのまま置く
    /// （表 3.3.1 の N-65 / CN65 の入れ替わりについては wall.rs のコメント）。
    fn wall_example_form() -> FormData {
        let pattern = |index: usize, id: &str| {
            let preset = crate::presets::find(id).expect("表 3.2.1 にある配列");
            normalize_pattern(&preset.to_pattern_value(), index).unwrap()
        };
        // 繊維方向は指定しない（長辺方向とみなす）。
        let panel = |pattern_id: &str| WallPanelInput {
            pattern_id: pattern_id.to_string(),
            grain: String::new(),
        };
        FormData {
            project_name: "グレー本 3.3 の計算例".to_string(),
            issued_on: String::new(),
            patterns: vec![
                pattern(0, "910x1820-s455-n75-hi"),
                pattern(1, "910x910-s455-n75-ro"),
            ],
            walls: vec![WallInput {
                wall_id: "w1".to_string(),
                wall_name: "計算例の大壁".to_string(),
                height: 3000.0,
                width: 910.0,
                material_id: "plywood12-n65".to_string(),
                thickness: 12.0,
                shear_modulus: 0.40,
                k: 0.483,
                delta_v: 2.3,
                delta_u: 17.0,
                delta_pv: 1.13,
                grade_id: "plywood-jas1".to_string(),
                tau_max: 3.6,
                e1: 3500.0,
                e2: 5500.0,
                has_intermediate_stud: true,
                panels: vec![panel("p1"), panel("p2")],
            }],
        }
    }

    fn only_wall(data: &FormData) -> Value {
        let walls = compute_all_walls(data);
        walls.as_array().unwrap()[0].clone()
    }

    /// 本: Pa = 8.37 kN、ΔPa = 9.20 kN/m（決めているのは K0/150）。
    #[test]
    fn the_wall_example_matches_the_book() {
        let report = only_wall(&wall_example_form());

        assert_eq!(report.get("ok"), Some(&Value::Bool(true)));
        assert_eq!(report.get("governing").unwrap().as_str(), Some("drift"));
        assert_eq!(report.get("withinLimit"), Some(&Value::Bool(true)));

        let result = report.get("result").unwrap();
        let value = |key: &str| result.get(key).unwrap().as_f64().unwrap();
        assert!((value("Pa") - 8.37).abs() <= 0.03, "{}", value("Pa"));
        assert!((value("dPa") - 9.20).abs() <= 0.03, "{}", value("dPa"));
        assert!((value("K0") - 3_765_224.0).abs() <= 12_000.0, "{}", value("K0"));
        assert!((value("My") - 34_623.0).abs() <= 100.0, "{}", value("My"));
        assert!((value("Mu") - 41_312.0).abs() <= 100.0, "{}", value("Mu"));
        assert!((value("mu") - 5.25).abs() <= 0.01, "{}", value("mu"));
    }

    /// 面材ごとの表には、選んだ釘配列パターンの名前と諸定数が並ぶ。
    #[test]
    fn the_wall_report_lists_every_panel_it_is_made_of() {
        let report = only_wall(&wall_example_form());

        assert_eq!(report.get("panelColumns").unwrap().as_array().unwrap().len(), 9);
        let panels = report.get("panels").unwrap().as_array().unwrap();
        assert_eq!(panels.len(), 2);
        assert_eq!(
            panels[0].get("label").unwrap().as_str(),
            Some("1820×910 縦置・日型（間柱・根太 @455 / 釘 @75）")
        );
        // 面材ごとの列は Aw から μ までの 8 つ（見出しの 9 列 − 面材名）。
        let cells = panels[0].get("cells").unwrap().as_array().unwrap();
        assert_eq!(cells.len(), 8);
        assert_eq!(cells[0].as_str(), Some("1,656,200"));

        let summary = labelled(&report, "summary", "key");
        assert_eq!(
            summary.iter().map(|(key, _)| key.as_str()).collect::<Vec<_>>(),
            vec!["K", "Pa", "ΔPa"]
        );
    }

    /// 入力欄の控えには、階高・壁幅・面材と釘の数値がそのまま並ぶ。
    #[test]
    fn the_wall_inputs_section_repeats_what_was_typed() {
        let inputs = labelled(&only_wall(&wall_example_form()), "inputs", "label");

        assert!(inputs.contains(&("階高 H".to_string(), "3,000 mm".to_string())));
        assert!(inputs.contains(&("壁の幅 W".to_string(), "910 mm".to_string())));
        assert!(inputs.contains(&(
            "面材と釘の組合せ".to_string(),
            "構造用合板 12mm + 鉄丸釘 N-65".to_string()
        )));
        assert!(inputs.contains(&(
            "面材の規格".to_string(),
            "構造用合板 JAS 1 級".to_string()
        )));
        assert!(inputs.contains(&(
            "中間材（間柱等）".to_string(),
            "あり（せん断座屈の ξ = 2）".to_string()
        )));
        assert!(inputs.contains(&("面材の枚数".to_string(), "2 枚".to_string())));
    }

    /// 上限を超えたら、検定の行に「超えている」と出す（計算は止めない）。
    #[test]
    fn the_wall_report_flags_a_wall_over_the_upper_limit() {
        let mut data = wall_example_form();
        data.walls[0].width = 300.0;
        let report = only_wall(&data);

        assert_eq!(report.get("withinLimit"), Some(&Value::Bool(false)));
        let checks = report.get("checks").unwrap().as_array().unwrap();
        let limit = &checks[0];
        assert!(limit.get("label").unwrap().as_str().unwrap().contains("上限"));
        assert_eq!(limit.get("ok"), Some(&Value::Bool(false)));
        assert!(limit.get("value").unwrap().as_str().unwrap().contains(">"));
    }

    /// 面材を選んでいない壁・見つからないパターンを指す壁は、理由を返す。
    #[test]
    fn walls_that_cannot_be_calculated_are_explained() {
        let cases = [
            (Vec::new(), "面材がありません"),
            (
                vec![WallPanelInput {
                    pattern_id: "p9".to_string(),
                    grain: String::new(),
                }],
                "見つかりません",
            ),
        ];
        for (panels, expected) in cases {
            let mut data = wall_example_form();
            data.walls[0].panels = panels;
            let report = only_wall(&data);
            assert_eq!(report.get("ok"), Some(&Value::Bool(false)));
            let error = report.get("error").unwrap().as_str().unwrap();
            assert!(error.contains(expected), "{error} should mention {expected}");
        }
    }

    /// 選んだ釘配列パターンが計算できないときは、そのパターン名で伝える。
    #[test]
    fn a_wall_reports_the_pattern_that_cannot_be_calculated() {
        let mut data = wall_example_form();
        data.patterns[0].pattern_name = "南面 下".to_string();
        data.patterns[0].grid_x = String::new();
        data.patterns[0].grid_y = String::new();
        data.patterns[0].mode = "grid".to_string();

        let error = only_wall(&data);
        let error = error.get("error").unwrap().as_str().unwrap();
        assert!(error.contains("「南面 下」"), "{error}");
    }

    /// 壁が 1 枚も計算できないと保存させない。名前で どの壁か を伝える。
    #[test]
    fn validate_walls_names_the_wall_that_cannot_be_calculated() {
        let mut data = wall_example_form();
        data.walls[0].wall_name = String::new();
        data.walls[0].height = 0.0;

        let error = validate_walls(&data).unwrap_err();
        assert!(error.contains("「壁1」を計算できません"), "{error}");
        assert!(error.contains("階高 H"), "{error}");
    }

    /// 壁を 1 枚も置いていない物件（釘配列諸定数だけを求める使い方）も通る。
    #[test]
    fn a_form_without_walls_is_valid() {
        let data = normalize(r#"{"patterns": [{"width": 910, "height": 610}]}"#).unwrap();
        assert!(data.walls.is_empty());
        assert!(validate_walls(&data).unwrap().is_empty());
        assert!(compute_all_walls(&data).as_array().unwrap().is_empty());
    }

    /// 壁の入力も、未知のキーを捨てて足りないキーを既定値で埋める。
    #[test]
    fn normalizes_walls_like_patterns() {
        let data = normalize(
            r#"{"walls": [{"wallName": " 南面 ", "height": "3000", "junk": 1,
                 "panels": [{"patternId": "p1"}, {"patternId": ""}, {}]}]}"#,
        )
        .unwrap();

        let wall = &data.walls[0];
        assert_eq!(wall.wall_id, "w1");
        assert_eq!(wall.wall_name, "南面");
        assert_eq!(wall.height, 3000.0);
        assert_eq!(wall.width, 0.0);
        // 空の patternId（未選択の行）は落とす。
        assert_eq!(
            wall.panels,
            vec![WallPanelInput {
                pattern_id: "p1".to_string(),
                grain: String::new()
            }]
        );
        assert_eq!(data.to_value().get("walls").unwrap().as_array().unwrap().len(), 1);
    }

    #[test]
    fn rejects_too_many_walls_and_panels() {
        let walls = vec![r#"{"height": 1}"#; MAX_WALLS + 1].join(",");
        let error = normalize(&format!(r#"{{"walls": [{walls}]}}"#)).unwrap_err();
        assert!(error.contains("壁は"), "{error}");

        let panels = vec![r#"{"patternId": "p1"}"#; MAX_WALL_PANELS + 1].join(",");
        let error = normalize(&format!(r#"{{"walls": [{{"panels": [{panels}]}}]}}"#)).unwrap_err();
        assert!(error.contains("面材は"), "{error}");
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
