//! 小規模木造建築物の必要壁量と柱の小径の計算。
//!
//! 公益財団法人日本住宅・木材技術センターが配布している「壁量等の基準
//! (令和7年施行)に対応した表計算ツール（多機能版）」ver1.2.1 の数式を、
//! そのまま Rust で書き直したもの。提出物は配布物そのもの（値を入れた
//! xlsx）なので、**ここでの計算は配布物を置き換えるものではなく、
//! 画面に結果を出し、保存のときに突き合わせるためのもの**。
//!
//! ## どの数式を写したか
//!
//! 配布物のシート「表計算ツール（平屋建て）」「表計算ツール（2階建て）」の
//! 右側（X 列より右）には、入力欄から出力欄までの中間値がすべて置いてある。
//! このモジュールはその並びを追って計算する。対応するセルは各関数の
//! コメントに書いてあるので、配布物を開けば 1 対 1 で読み比べられる。
//! 数式そのものは wall_quantity_mapping.json の `guard.formulas` に控えて
//! あり、配布物が改訂されて数式が変わればテストが赤くなる。
//!
//! ## 配布物の癖もそのまま写す
//!
//! 「入力が足りない欄は空欄になる」「表に無い樹種は『該当なし』」といった
//! 見え方は配布物の作りそのものなので、ここでも同じにしてある。差が出たら
//! それは移植の誤りなので、直すのはこちら側（配布物には手を入れない）。
//! 唯一そろえられないのは Excel の丸め（ROUNDUP / ROUNDDOWN）で、これは
//! 15 桁の十進表記で丸める Excel の挙動を `roundup` / `rounddown` で真似る。
//!
//! ## これから
//!
//! 今後この計算は「配布物どおりではない計算」へ広げる予定なので、面材張り
//! 大壁（wall.rs）と同じく Rust に置き、画面とサーバが同じ .wasm を動かす。

use crate::column_strength;
use crate::format::format_dimension;
use crate::json::Value;

// --- 配布物が持っている定数 --------------------------------------------------
//
// いずれも配布物のシート右側（X〜AE 列）に直接書かれている数値。単位は
// 断りのない限り N/m²（床面積・壁面積あたりの荷重）。

/// 屋根の仕様ごとの荷重（Z6〜Z8 の素の値。屋根面積の割増を掛ける前）。
const ROOF: [(&str, f64); 3] = [
    ("瓦屋根（ふき土無）", 990.0),
    ("スレート屋根", 740.0),
    ("金属板ぶき", 500.0),
];

/// 外壁の仕様ごとの荷重（Z19〜Z23。階高 2.8 m のときの壁面積あたり）。
const EXTERIOR_WALL: [(&str, f64); 5] = [
    ("土塗り壁等", 1000.0),
    ("モルタル等", 890.0),
    ("サイディング", 600.0),
    ("金属板張", 500.0),
    ("下見板張", 350.0),
];

/// 太陽光発電設備等（Z3〜Z5）。「あり(200)」は屋根面積あたり 200 N/m²。
const SOLAR_NONE: &str = "なし(0)";
const SOLAR_FIXED_PREFIX: &str = "あり(200)";
const SOLAR_CUSTOM: &str = "あり(任意入力)";
const SOLAR_FIXED: f64 = 200.0;

/// 天井（屋根）断熱材（Z11・Z12）と外壁断熱材（Z24・Z25）。
const CUSTOM_INPUT: &str = "任意入力";
const CEILING_DEFAULT: f64 = 100.0;
const WALL_INSULATION_DEFAULT: f64 = 70.0;

/// 床（Z13）・内壁のせっこうボード（Z28）・開口部のトリプルガラス（Z26）。
const FLOOR: f64 = 610.0;
const INTERIOR_WALL: f64 = 200.0;
const OPENING: f64 = 400.0;

/// 積載荷重。地震力算定用（Z14・Z15）と柱算定用（Z16・Z17）で、
/// 住宅・共同住宅と事務所を使い分ける（用途が「非住宅」なら事務所）。
const LIVE_LOAD_SEISMIC: (f64, f64) = (600.0, 800.0);
const LIVE_LOAD_COLUMN: (f64, f64) = (1300.0, 1800.0);

/// 壁面積を床面積あたりへ均すときの、想定した建物（6 m × 16.5 m）と
/// 開口部の割合（AD19〜AD26 の式に直接書かれている）。
const PLAN_SHORT: f64 = 6.0;
const PLAN_LONG: f64 = 16.5;
const OPENING_RATIO: f64 = 0.09;

/// 多雪区域の積雪荷重（地震力算定用）に掛かる係数（Z9）。
const SNOW_FACTOR: f64 = 0.35;

/// 振動特性係数 Rt（AE10）。配布物は 1.0 で固定している。
const RT: f64 = 1.0;

/// 必要壁量へ直す係数（AE34 等の 0.0196）。壁倍率 1 の壁の単位長さあたりの
/// 許容せん断耐力 1.96 kN/m を、cm/m² の壁量へ読み替えるための除数。
const WALL_QUANTITY_DIVISOR: f64 = 0.0196;

/// 耐震等級 2・3 の割増（AE36・AE37）。
const GRADE_2_FACTOR: f64 = 1.25;
const GRADE_3_FACTOR: f64 = 1.5;

/// 柱 1 本が受け持つ床面積 Ae（AD50・AF55）と、2-1 が前提にしている
/// すぎ・無等級材の圧縮の基準強度 Fc（AC50・AE55）。
const COLUMN_LOAD_AREA: f64 = 5.0;
const COLUMN_1_STRENGTH: f64 = 17.7;

/// 柱の小径の算定式に出てくる定数（AB53・AC53 等）。
const SLENDERNESS_LIMIT: f64 = 150.0;
/// 有効細長比 150 に相当する「横架材間距離 / 材せい」の上限（Z76 の 43.3）。
const EFFECTIVE_SLENDERNESS_LIMIT: f64 = 43.3;
/// 細長比 λ = 3.46 × 横架材間距離 / 材せい（Z74）。
const SLENDERNESS_COEFFICIENT: f64 = 3.46;
/// 長期の許容応力度へ直す係数 1.1/3（Z78 等）。
const LONG_TERM_FACTOR: f64 = 1.1 / 3.0;

/// 横架材間距離の求め方。土台・胴差の分を階高から引く（AB50・AD55・AD56）。
const TOP_STOREY_DEDUCTION: f64 = 105.0;
const LOWER_STOREY_DEDUCTION: f64 = 120.0;

/// 2-3 が最初から並べている柱の断面（O78・Q78）。
const STANDARD_SECTIONS: [(&str, f64, f64); 2] = [("105角", 105.0, 105.0), ("120角", 120.0, 120.0)];

/// 選べない組合せのときに配布物が出す文字。
const NOT_IN_TABLE: &str = "該当なし";
const TOO_SLENDER: &str = "有効細長比150以上";

// --- 建物・用途・階 ----------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Building {
    /// 平屋建て（配布物のシート「表計算ツール（平屋建て）」）。
    OneStory,
    /// 2 階建て（同「表計算ツール（2階建て）」）。
    TwoStory,
}

/// 0. 設計の用途。住宅性能表示制度を使うときだけ耐震等級 2・3 と
/// 地震地域係数・多雪区域の入力欄が生きる（配布物の W8〜W10）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Usage {
    Performance,
    Office,
    Standard,
}

/// 階。平屋建ては First だけを使う。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Storey {
    First,
    Second,
}

impl Building {
    pub fn from_key(key: &str) -> Result<Building, String> {
        match key {
            "one_story" => Ok(Building::OneStory),
            "two_story" => Ok(Building::TwoStory),
            _ => Err("建物の種別（平屋建て / 2階建て）が不正です。".to_string()),
        }
    }

    fn key(self) -> &'static str {
        match self {
            Building::OneStory => "one_story",
            Building::TwoStory => "two_story",
        }
    }

    /// 上の階から順に返す（画面の表の列・行の並びになる）。
    fn storeys(self) -> &'static [Storey] {
        match self {
            Building::OneStory => &[Storey::First],
            Building::TwoStory => &[Storey::Second, Storey::First],
        }
    }
}

impl Usage {
    fn from_key(key: &str) -> Result<Usage, String> {
        match key {
            "performance" => Ok(Usage::Performance),
            "office" => Ok(Usage::Office),
            "standard" => Ok(Usage::Standard),
            _ => Err("「0. 設計の用途」を 1 つ選んでください。".to_string()),
        }
    }

    fn key(self) -> &'static str {
        match self {
            Usage::Performance => "performance",
            Usage::Office => "office",
            Usage::Standard => "standard",
        }
    }
}

impl Storey {
    fn key(self) -> &'static str {
        match self {
            Storey::First => "1f",
            Storey::Second => "2f",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Storey::First => "1階",
            Storey::Second => "2階",
        }
    }
}

// --- 入力の読み取り ----------------------------------------------------------

/// フォーム入力（画面が送ってくる形そのまま）。
///
/// 入力欄の key は wall_quantity_mapping.json が決めている。マッピングは
/// 「どのセルへ書くか」の単一の情報源で、こちらは「その値をどう計算に使うか」
/// の単一の実装。両者の key がそろっていることは、backend のテストが
/// `inputKeys` を突き合わせて確かめる。
pub struct Input<'a> {
    pub building: Building,
    pub usage: Usage,
    values: &'a Value,
    toggles: &'a Value,
}

impl<'a> Input<'a> {
    pub fn read(data: &'a Value) -> Result<Input<'a>, String> {
        if !matches!(data, Value::Obj(_)) {
            return Err("入力データがありません。".to_string());
        }
        Ok(Input {
            building: Building::from_key(text_of(data.get("building")).as_str())?,
            usage: Usage::from_key(text_of(data.get("usage")).as_str())?,
            values: data.get("values").unwrap_or(&Value::Null),
            toggles: data.get("toggles").unwrap_or(&Value::Null),
        })
    }

    /// 文字列の入力欄（選択肢を含む）。
    fn text(&self, key: &str) -> String {
        text_of(self.values.get(key))
    }

    /// 数値の入力欄。空欄は None（配布物の空セルと同じ扱い）。
    fn number(&self, key: &str) -> Option<f64> {
        number_of(self.values.get(key))
    }

    /// 数値の入力欄。空欄は 0（配布物の空セルを算術で使ったときと同じ）。
    fn zero(&self, key: &str) -> f64 {
        self.number(key).unwrap_or(0.0)
    }

    /// 算定方法のチェックボックス（W52・W61・W72 等）。
    fn toggle(&self, key: &str) -> bool {
        matches!(self.toggles.get(key), Some(Value::Bool(true)))
    }
}

/// 入力欄の値を文字列として読む（数値で送られてきても文字列に直す）。
fn text_of(value: Option<&Value>) -> String {
    match value {
        Some(Value::Str(text)) => text.trim().to_string(),
        Some(Value::Num(number)) => Value::Num(*number).to_json(),
        _ => String::new(),
    }
}

/// 入力欄の値を数値として読む。
///
/// 携帯の日本語入力で全角のまま打たれることがあるので、半角へ寄せてから
/// 読む（backend の NFKC・画面の normalize('NFKC') と同じ考え方）。
/// 数値にならない文字列は None（配布物では空セルと同じく 0 として扱われる）。
fn number_of(value: Option<&Value>) -> Option<f64> {
    let number = match value {
        Some(Value::Num(number)) => *number,
        Some(Value::Str(text)) => {
            let text = to_halfwidth(text.trim());
            if text.is_empty() {
                return None;
            }
            text.parse::<f64>().ok()?
        }
        _ => return None,
    };
    number.is_finite().then_some(number)
}

/// 選択肢に入っている数値（地震地域係数 Z・標準せん断力係数 C0）を読む。
///
/// 空欄は 0（配布物でも空セルは掛け算で 0 になる）。「ー」のように数値で
/// ない選択は NaN にして、以降の出力を空欄にする（配布物の #VALUE! と同じ）。
fn excel_number(text: &str) -> f64 {
    if text.is_empty() {
        return 0.0;
    }
    number_of(Some(&Value::Str(text.to_string()))).unwrap_or(f64::NAN)
}

fn to_halfwidth(text: &str) -> String {
    text.chars()
        .map(|character| match character {
            '０'..='９' => char::from_u32(character as u32 - '０' as u32 + '0' as u32)
                .expect("全角数字は半角数字へ移せる"),
            '．' => '.',
            '＋' => '+',
            '－' | '−' => '-',
            other => other,
        })
        .collect()
}

// --- Excel の丸め ------------------------------------------------------------

/// Excel の ROUNDUP（0 から遠い側へ丸める）。
///
/// Excel は 2 進数の値そのものではなく、15 桁の十進表記に直してから丸める。
/// たとえば 51.000000000000007 は 51 として扱われ、ROUNDUP しても 52 に
/// ならない。ここでも同じように、桁を合わせたあと 15 桁へ丸めてから
/// 切り上げる（そうしないと最後の 1 桁が配布物と食い違うことがある）。
fn roundup(value: f64, digits: i32) -> f64 {
    round_at(value, digits, |scaled| {
        if scaled < 0.0 {
            scaled.floor()
        } else {
            scaled.ceil()
        }
    })
}

/// Excel の ROUNDDOWN（0 に近い側へ丸める）。
fn rounddown(value: f64, digits: i32) -> f64 {
    round_at(value, digits, |scaled| {
        if scaled < 0.0 {
            scaled.ceil()
        } else {
            scaled.floor()
        }
    })
}

/// 桁をそろえて丸め、元の桁へ戻す。
///
/// 10 のべき乗は必ず「掛ける」側で使う（0.1 を掛ける・0.1 で割るは誤差が出る。
/// 75 / 0.1 は 750 にならず 749.9999999999999 になる）。
fn round_at(value: f64, digits: i32, round: impl Fn(f64) -> f64) -> f64 {
    if !value.is_finite() {
        return value;
    }
    if digits >= 0 {
        let factor = 10f64.powi(digits);
        round(significant15(value * factor)) / factor
    } else {
        let factor = 10f64.powi(-digits);
        round(significant15(value / factor)) * factor
    }
}

/// 15 桁の十進表記へ丸める（Excel が画面に出す桁数と同じ）。
fn significant15(value: f64) -> f64 {
    if !value.is_finite() || value == 0.0 {
        return value;
    }
    format!("{value:.14e}").parse().unwrap_or(value)
}

// --- 出力の升目 --------------------------------------------------------------

/// 出力欄 1 つ。配布物の出力セルと同じで、空欄と文言もそのまま持つ。
#[derive(Clone, Debug, PartialEq)]
pub enum Cell {
    /// 入力が足りず、配布物でも空欄になるところ。
    Blank,
    Number(f64),
    /// 「該当なし」「有効細長比150以上」のような、配布物が出す文言。
    Text(String),
}

impl Cell {
    /// 数値を、指定した小数位で丸めて升目にする（None は空欄）。
    fn number(value: Option<f64>) -> Cell {
        match value {
            Some(number) if number.is_finite() => Cell::Number(number),
            _ => Cell::Blank,
        }
    }

    /// 画面と突き合わせに使う文字列。
    pub fn text(&self) -> String {
        match self {
            Cell::Blank => String::new(),
            Cell::Number(number) => format_dimension(*number),
            Cell::Text(text) => text.clone(),
        }
    }

    fn to_value(&self, key: &str) -> Value {
        Value::obj([
            ("key", key.into()),
            ("text", self.text().into()),
            (
                "value",
                match self {
                    Cell::Number(number) => (*number).into(),
                    _ => Value::Null,
                },
            ),
        ])
    }
}

/// 出力の表 1 つ（配布物の「出力結果」の枠に対応する）。
pub struct Table {
    key: String,
    title: String,
    columns: Vec<(String, String)>,
    rows: Vec<Row>,
}

pub struct Row {
    label: String,
    cells: Vec<(String, Cell)>,
}

/// 出力の節（1. 必要壁量 / 2-1 / 2-2 / 2-3）。
pub struct Section {
    key: String,
    title: String,
    note: String,
    /// 算定方法のチェックボックスが切りのときは false（配布物でも空欄になる）。
    enabled: bool,
    tables: Vec<Table>,
}

impl Section {
    fn to_value(&self) -> Value {
        Value::obj([
            ("key", self.key.clone().into()),
            ("title", self.title.clone().into()),
            ("note", self.note.clone().into()),
            ("enabled", self.enabled.into()),
            (
                "tables",
                Value::Arr(self.tables.iter().map(Table::to_value).collect()),
            ),
        ])
    }
}

impl Table {
    fn to_value(&self) -> Value {
        Value::obj([
            ("key", self.key.clone().into()),
            ("title", self.title.clone().into()),
            (
                "columns",
                Value::Arr(
                    self.columns
                        .iter()
                        .map(|(key, label)| {
                            Value::obj([
                                ("key", key.as_str().into()),
                                ("label", label.as_str().into()),
                            ])
                        })
                        .collect(),
                ),
            ),
            (
                "rows",
                Value::Arr(
                    self.rows
                        .iter()
                        .map(|row| {
                            Value::obj([
                                ("label", row.label.as_str().into()),
                                (
                                    "cells",
                                    Value::Arr(
                                        row.cells
                                            .iter()
                                            .map(|(key, cell)| cell.to_value(key))
                                            .collect(),
                                    ),
                                ),
                            ])
                        })
                        .collect(),
                ),
            ),
        ])
    }
}

// --- 荷重（配布物のシート右側 X〜AE 列） --------------------------------------

/// 入力から決まる荷重の一式。配布物の中間セルと 1 対 1 に対応する。
struct Loads {
    /// Z6〜Z8: 屋根の荷重（割増込み）。未選択なら None。
    roof: Option<f64>,
    /// Z3〜Z5: 太陽光発電設備等。
    solar: Option<f64>,
    /// Z11・Z12: 天井（屋根）断熱材。
    ceiling: Option<f64>,
    /// Z19〜Z23: 外壁（階高 2.8 m 相当の素の値）。
    exterior_wall: Option<f64>,
    /// Z24・Z25: 外壁断熱材（同上）。
    wall_insulation: Option<f64>,
    /// Z9: 多雪区域の積雪荷重（地震力算定用）。多雪区域でなければ 0。
    /// 垂直積雪量・積雪単位荷重が入っていないときは None（配布物の「記入無し」）。
    snow: Option<f64>,
    /// AE13: 床面積比（2 階床面積 / 1 階床面積）。平屋建ては 1。
    floor_area_ratio: Option<f64>,
    /// AE29・AE32: 算定用建築物の高さ。
    building_height: f64,
    /// AF6: 地震地域係数 Z（用途が住宅性能表示以外なら 1）。
    seismic_zone: f64,
    /// H18・H19: 標準せん断力係数 C0。
    base_shear: f64,
    /// AA14: 積載荷重（地震力算定用）。
    live_load_seismic: f64,
    /// AA16: 積載荷重（柱算定用）。
    live_load_column: f64,
    /// 各階の階高（m）。
    height_1f: f64,
    height_2f: f64,
}

impl Loads {
    fn read(input: &Input) -> Loads {
        let two_story = input.building == Building::TwoStory;
        let office = input.usage == Usage::Office;

        let height_1f = input.zero("height_1f");
        let height_2f = if two_story {
            input.zero("height_2f")
        } else {
            0.0
        };
        let ridge = input.zero("ridge_minus_eaves");
        let eaves = input.zero("eaves");
        let pitch = input.zero("roof_pitch");

        // Z2 =(16.5+軒の出*2)*(6+軒の出*2)*SQRT(勾配^2+10^2)/(16.5*6)/10
        let slope_factor = (pitch * pitch + 100.0).sqrt() / 10.0;
        let roof_factor = (PLAN_LONG + eaves * 2.0) * (PLAN_SHORT + eaves * 2.0) * slope_factor
            / (PLAN_LONG * PLAN_SHORT);

        // 太陽光の任意入力と天井断熱材の任意入力は、床面積で均す。
        // 平屋建ては 1 階床面積、2 階建ては MAX(2 階, 1 階)。
        let area_1f = input.zero("floor_area_1f");
        let area_2f = if two_story {
            input.zero("floor_area_2f")
        } else {
            0.0
        };
        let spread_area = if two_story {
            area_1f.max(area_2f)
        } else {
            area_1f
        };

        let floor_area_ratio = if two_story {
            // AE13 =IF(2階床面積>0, 2階床面積/1階床面積, "")
            (area_2f > 0.0).then(|| area_2f / area_1f)
        } else {
            Some(1.0)
        };

        Loads {
            roof: lookup(&ROOF, &input.text("roof_spec")).map(|load| load * roof_factor),
            solar: solar_load(input, roof_factor, spread_area),
            ceiling: ceiling_load(input, spread_area),
            exterior_wall: lookup(&EXTERIOR_WALL, &input.text("wall_spec")),
            wall_insulation: wall_insulation_load(input),
            snow: snow_load(input, roof_factor, slope_factor),
            floor_area_ratio,
            building_height: if two_story {
                // AE32 =(最高高さ-軒高さ)/2 + 2階階高 + 1階階高 + 0.5
                ridge / 2.0 + height_2f + height_1f + 0.5
            } else {
                // AE29 =(最高高さ-軒高さ)/2 + 1階階高 + 0.5
                ridge / 2.0 + height_1f + 0.5
            },
            // AF6 =IF(用途が住宅性能表示以外, 1, 地震地域係数)
            seismic_zone: match input.usage {
                Usage::Performance => excel_number(&input.text("seismic_zone")),
                _ => 1.0,
            },
            base_shear: excel_number(&input.text("base_shear")),
            live_load_seismic: if office {
                LIVE_LOAD_SEISMIC.1
            } else {
                LIVE_LOAD_SEISMIC.0
            },
            live_load_column: if office {
                LIVE_LOAD_COLUMN.1
            } else {
                LIVE_LOAD_COLUMN.0
            },
            height_1f,
            height_2f,
        }
    }

    fn height_of(&self, storey: Storey) -> f64 {
        match storey {
            Storey::First => self.height_1f,
            Storey::Second => self.height_2f,
        }
    }

    /// AD19〜AD25 / AE19〜AE25: 壁面積あたりの荷重を、その階の床面積あたりへ均す。
    ///
    /// 6 m × 16.5 m の総 2 階を想定し、外周の壁（開口部を除く 91%）の面積を
    /// 床面積で割る。10 N/m² 単位へ切り上げるのも配布物のまま。
    fn per_floor(&self, base: f64, storey: Storey) -> f64 {
        let height = self.height_of(storey);
        let wall_area =
            (PLAN_SHORT * height * 2.0 + PLAN_LONG * height * 2.0) * (1.0 - OPENING_RATIO);
        roundup(base * wall_area / (PLAN_SHORT * PLAN_LONG), -1)
    }

    /// AD26 / AE26: 開口部の荷重（同じ均し方で、外周の 9%）。
    fn opening_per_floor(&self, storey: Storey) -> f64 {
        let height = self.height_of(storey);
        let area = (PLAN_SHORT * height * 2.0 + PLAN_LONG * height * 2.0) * OPENING_RATIO;
        roundup(OPENING * area / (PLAN_SHORT * PLAN_LONG), -1)
    }

    /// その階の壁荷重（外壁 + 内壁 + 外壁断熱材 + 開口部）[kN/m²]。
    ///
    /// 平屋建ての Z36、2 階建ての Z36（2 階）・Z38（1 階）。内壁のせっこう
    /// ボードは階高 2.8 m あたりの値なので、その階の階高で按分する。
    fn wall_load(&self, storey: Storey) -> Option<f64> {
        let exterior = self.per_floor(self.exterior_wall?, storey);
        let insulation = self.per_floor(self.wall_insulation?, storey);
        let interior = INTERIOR_WALL * self.height_of(storey) / 2.8;
        Some((exterior + interior + insulation + self.opening_per_floor(storey)) / 1000.0)
    }

    /// 屋根（屋根 + 太陽光 + 天井断熱材）の荷重 [kN/m²]。積雪は含まない。
    fn roof_load(&self) -> Option<f64> {
        Some((self.roof? + self.solar? + self.ceiling?) / 1000.0)
    }

    /// 2 階の床荷重 [kN/m²]（Z37 / AB37）。
    fn floor_load(&self, live_load: f64) -> f64 {
        (FLOOR + live_load) / 1000.0
    }
}

/// 選択肢から表を引く（配布物の VLOOKUP と同じ完全一致）。
fn lookup(table: &[(&str, f64)], key: &str) -> Option<f64> {
    table
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, value)| *value)
}

/// Z3〜Z5: 太陽光発電設備等。
fn solar_load(input: &Input, roof_factor: f64, spread_area: f64) -> Option<f64> {
    let choice = input.text("solar");
    if choice == SOLAR_NONE {
        return Some(0.0);
    }
    if choice.starts_with(SOLAR_FIXED_PREFIX) {
        return Some(SOLAR_FIXED * roof_factor);
    }
    if choice == SOLAR_CUSTOM {
        // Z5 =設備等の質量/床面積*9.8（床面積が 0 なら配布物も #DIV/0!）。
        let mass = input.zero("solar_mass");
        return (spread_area > 0.0).then(|| mass / spread_area * 9.8);
    }
    None
}

/// Z11・Z12: 天井（屋根）断熱材。
fn ceiling_load(input: &Input, spread_area: f64) -> Option<f64> {
    let choice = input.text("ceiling_insulation");
    if choice == CUSTOM_INPUT {
        if spread_area <= 0.0 {
            return None;
        }
        // Z12 =(ROUNDUP(面積*密度*厚さ/1000*9.8,-1)+…)/床面積
        let first = roundup(
            input.zero("ceiling_custom_1_area")
                * input.zero("ceiling_custom_1_density")
                * input.zero("ceiling_custom_1_thickness")
                / 1000.0
                * 9.8,
            -1,
        );
        let second = roundup(
            input.zero("ceiling_custom_2_area")
                * input.zero("ceiling_custom_2_density")
                * input.zero("ceiling_custom_2_thickness")
                / 1000.0
                * 9.8,
            -1,
        );
        return Some((first + second) / spread_area);
    }
    (!choice.is_empty()).then_some(CEILING_DEFAULT)
}

/// Z24・Z25: 外壁断熱材（階高 2.8 m 相当の素の値）。
fn wall_insulation_load(input: &Input) -> Option<f64> {
    let choice = input.text("wall_insulation");
    if choice == CUSTOM_INPUT {
        // Z25 =ROUNDUP(密度*厚さ*9.8/1000 + 密度*厚さ*9.8/1000, -1)
        return Some(roundup(
            input.zero("wall_custom_1_density") * input.zero("wall_custom_1_thickness") * 9.8
                / 1000.0
                + input.zero("wall_custom_2_density") * input.zero("wall_custom_2_thickness") * 9.8
                    / 1000.0,
            -1,
        ));
    }
    (!choice.is_empty()).then_some(WALL_INSULATION_DEFAULT)
}

/// Z9: 多雪区域の積雪荷重（地震力算定用）。
///
/// 屋根面積あたりの積雪荷重を、屋根の割増（Z2）と勾配（AB2）で床面積あたりへ
/// 直す。多雪区域でなければ 0、垂直積雪量・積雪単位荷重が空なら None
/// （配布物は「記入無し」と書き、以降の等級 1 以外の出力が空欄になる）。
fn snow_load(input: &Input, roof_factor: f64, slope_factor: f64) -> Option<f64> {
    if input.text("heavy_snow") != "あり(多雪区域)" {
        return Some(0.0);
    }
    let load = input.zero("snow_depth") * input.zero("snow_unit_load") * SNOW_FACTOR * roof_factor
        / slope_factor;
    (load > 0.0).then_some(load)
}

// --- 1. 単位面積当たりの必要壁量 Lw ------------------------------------------

/// 階ごとの「支えている部分の荷重」[kN/m²]。
///
/// 平屋建ての Z37・Z38、2 階建ての Z41〜Z44。基準法（積雪を含まない）と
/// 住宅性能表示制度（積雪を含む）で 2 通り作る。
struct SupportedLoads {
    /// 上の階から順。平屋建ては 1 つだけ。
    per_storey: Vec<(Storey, Option<f64>)>,
}

impl SupportedLoads {
    fn build(loads: &Loads, building: Building, with_snow: bool) -> SupportedLoads {
        let ratio = loads.floor_area_ratio;
        let snow = if with_snow { loads.snow } else { Some(0.0) };
        let roof = match (loads.roof_load(), snow, ratio) {
            (Some(roof), Some(snow), Some(ratio)) => Some((roof * 1000.0 + snow) * ratio / 1000.0),
            _ => None,
        };

        match building {
            Building::OneStory => {
                // Z37 = 屋根 + 0.5 × 壁
                let first = match (roof, loads.wall_load(Storey::First)) {
                    (Some(roof), Some(wall)) => Some(roof + 0.5 * wall),
                    _ => None,
                };
                SupportedLoads {
                    per_storey: vec![(Storey::First, first)],
                }
            }
            Building::TwoStory => {
                let wall_2f = loads.wall_load(Storey::Second);
                let wall_1f = loads.wall_load(Storey::First);
                let floor = loads.floor_load(loads.live_load_seismic);
                // Z41 = 2 階の屋根 + 0.5 × 2 階の壁
                let second = match (roof, wall_2f) {
                    (Some(roof), Some(wall)) => Some(roof + 0.5 * wall),
                    _ => None,
                };
                // Z39・Z40: 下屋（2 階が載っていない部分）の屋根。
                let lean_to = match (loads.roof_load(), snow, ratio) {
                    (Some(roof), Some(snow), Some(ratio)) if ratio < 1.0 => {
                        Some((1.0 - ratio) * (roof * 1000.0 + snow) / 1000.0)
                    }
                    (Some(_), Some(_), Some(_)) => Some(0.0),
                    _ => None,
                };
                // Z42 = 2 階の屋根 + 2 階の壁 + 2 階の床 + 0.5 × 1 階の壁 + 下屋
                let first = match (roof, wall_2f, wall_1f, lean_to, ratio) {
                    (Some(roof), Some(wall_2f), Some(wall_1f), Some(lean_to), Some(ratio)) => {
                        Some(roof + wall_2f + floor * ratio + 0.5 * wall_1f + lean_to)
                    }
                    _ => None,
                };
                SupportedLoads {
                    per_storey: vec![(Storey::Second, second), (Storey::First, first)],
                }
            }
        }
    }

    /// 1 階（最下階）が支えている荷重。Ai の分母になる。
    fn bottom(&self) -> Option<f64> {
        self.per_storey.last().and_then(|(_, load)| *load)
    }

    fn is_bottom(&self, storey: Storey) -> bool {
        self.per_storey
            .last()
            .is_some_and(|(key, _)| *key == storey)
    }
}

/// Ai（地震層せん断力係数の高さ方向の分布）。
///
/// 配布物の AE38・AF38 に書かれている式そのもの。最下階は αi = 1 なので
/// 必ず 1 になる（式の形も配布物のまま残してある）。
fn distribution_factor(alpha: f64, building_height: f64) -> f64 {
    let t = 2.0 * 0.03 * building_height;
    1.0 + (1.0 / alpha.sqrt() - alpha) * t / (1.0 + 3.0 * 0.03 * building_height)
}

/// 単位面積当たりの必要壁量 Lw [cm/m²]。
///
/// AE34 / AE38・AF38 と同じで、
///   Lw = ROUNDUP(Ai × C0 × Z × Rt / 0.0196 × その階が支えている荷重 / 床面積比, 0)
/// 床面積比で割るのは、上の階の荷重を「その階の床面積あたり」へ直すため。
fn required_wall_quantity(
    loads: &Loads,
    supported: &SupportedLoads,
    storey: Storey,
    with_seismic_zone: bool,
) -> Option<f64> {
    let (_, load) = supported
        .per_storey
        .iter()
        .find(|(key, _)| *key == storey)?;
    let load = (*load)?;
    let bottom = supported.bottom()?;
    let ratio = loads.floor_area_ratio?;
    if bottom == 0.0 || ratio == 0.0 {
        return None;
    }

    let ai = distribution_factor(load / bottom, loads.building_height);
    let zone = if with_seismic_zone {
        loads.seismic_zone
    } else {
        1.0
    };
    // 上の階の荷重は「2 階の床面積あたり」へ直してから壁量にする（AF38 の
    // 末尾の /$AE$13）。最下階はもともとその階の床面積あたりなので割らない。
    let per_floor_area = if supported.is_bottom(storey) {
        load
    } else {
        load / ratio
    };
    let value = roundup(
        ai * loads.base_shear * zone * RT / WALL_QUANTITY_DIVISOR * per_floor_area,
        0,
    );
    value.is_finite().then_some(value)
}

fn wall_quantity_section(input: &Input, loads: &Loads) -> Section {
    let performance = input.usage == Usage::Performance;
    let basic = SupportedLoads::build(loads, input.building, false);
    let with_snow = SupportedLoads::build(loads, input.building, true);

    let storeys = input.building.storeys();
    let columns: Vec<(String, String)> = storeys
        .iter()
        .rev()
        .map(|storey| (storey.key().to_string(), storey.label().to_string()))
        .collect();

    // 等級 1（基準法）は積雪を含まず、地震地域係数も掛けない。
    let mut rows = vec![Row {
        label: if performance { "等級1" } else { "基準法" }.to_string(),
        cells: storeys
            .iter()
            .rev()
            .map(|storey| {
                (
                    format!("lw.{}.grade1", storey.key()),
                    Cell::number(required_wall_quantity(loads, &basic, *storey, false)),
                )
            })
            .collect(),
    }];

    if performance {
        // 等級 2・3 は、積雪を含む荷重と地震地域係数から出した値の割増。
        for (label, factor, key) in [
            ("等級2", GRADE_2_FACTOR, "grade2"),
            ("等級3", GRADE_3_FACTOR, "grade3"),
        ] {
            rows.push(Row {
                label: label.to_string(),
                cells: storeys
                    .iter()
                    .rev()
                    .map(|storey| {
                        let base = required_wall_quantity(loads, &with_snow, *storey, true);
                        (
                            format!("lw.{}.{key}", storey.key()),
                            Cell::number(base.map(|value| roundup(value * factor, 0))),
                        )
                    })
                    .collect(),
            });
        }
    }

    Section {
        key: "wall_quantity".to_string(),
        title: "1. 単位面積当たりの必要壁量 Lw (cm/m²)".to_string(),
        note: if performance {
            "等級1は基準法と同じ値なので、積雪荷重は影響しません。".to_string()
        } else {
            "耐震等級2・3は、用途で「住宅性能表示制度を利用」を選ぶと出ます。".to_string()
        },
        enabled: true,
        tables: vec![Table {
            key: "lw".to_string(),
            title: String::new(),
            columns,
            rows,
        }],
    }
}

// --- 2. 柱の小径 -------------------------------------------------------------

/// 柱の計算に使う、階ごとの前提。
struct ColumnStorey {
    storey: Storey,
    /// 横架材間距離 l [mm]（AB50・AD55・AD56）。
    span: f64,
    /// 外周柱の床面積あたりの負担荷重 [kN/m²]（Z50・Z55・Z56）。
    perimeter: Option<f64>,
    /// 内部柱の床面積あたりの負担荷重 [kN/m²]（AA50・AA55・AA56）。
    interior: Option<f64>,
    /// 有効細長比の判定に使う「階高 − 差し引き」[m]（Z76・Z82・Z86）。
    clear_height: f64,
    /// 2-1 の「de/l」を出すときの分母（D57・D59・D60）。
    ///
    /// 平屋建てだけ、横架材間距離 l は階高 − 105 mm なのに、この表示は
    /// 階高 − 120 mm で割っている。配布物の表示に合わせてそのままにする。
    display_span: f64,
}

/// 柱の負担荷重（柱算定用の積載荷重を使う。地震力算定用とは別）。
fn column_storeys(loads: &Loads, building: Building) -> Vec<ColumnStorey> {
    // AB34: 屋根（床面積比を掛けない）。AB36・AB38: 各階の壁。
    let roof = loads.roof_load();
    let gypsum = |storey: Storey| INTERIOR_WALL * loads.height_of(storey) / 2.8 / 1000.0;

    match building {
        Building::OneStory => {
            let wall = loads.wall_load(Storey::First);
            vec![ColumnStorey {
                storey: Storey::First,
                span: loads.height_1f * 1000.0 - TOP_STOREY_DEDUCTION,
                // Z50 = 屋根 + 0.5 × 壁
                perimeter: match (roof, wall) {
                    (Some(roof), Some(wall)) => Some(roof + 0.5 * wall),
                    _ => None,
                },
                // AA50 = 屋根 + 0.5 × 内壁だけ
                interior: roof.map(|roof| roof + 0.5 * gypsum(Storey::First)),
                clear_height: loads.height_1f - TOP_STOREY_DEDUCTION / 1000.0,
                display_span: loads.height_1f * 1000.0 - LOWER_STOREY_DEDUCTION,
            }]
        }
        Building::TwoStory => {
            let wall_2f = loads.wall_load(Storey::Second);
            let wall_1f = loads.wall_load(Storey::First);
            let floor = loads.floor_load(loads.live_load_column);
            vec![
                ColumnStorey {
                    storey: Storey::Second,
                    span: loads.height_2f * 1000.0 - TOP_STOREY_DEDUCTION,
                    // Z55 = 屋根 + 0.5 × 2 階の壁
                    perimeter: match (roof, wall_2f) {
                        (Some(roof), Some(wall)) => Some(roof + 0.5 * wall),
                        _ => None,
                    },
                    interior: roof.map(|roof| roof + 0.5 * gypsum(Storey::Second)),
                    clear_height: loads.height_2f - TOP_STOREY_DEDUCTION / 1000.0,
                    display_span: loads.height_2f * 1000.0 - TOP_STOREY_DEDUCTION,
                },
                ColumnStorey {
                    storey: Storey::First,
                    span: loads.height_1f * 1000.0 - LOWER_STOREY_DEDUCTION,
                    // Z56 = 屋根 + 2 階の壁 + 2 階の床 + 0.5 × 1 階の壁
                    perimeter: match (roof, wall_2f, wall_1f) {
                        (Some(roof), Some(wall_2f), Some(wall_1f)) => {
                            Some(roof + wall_2f + floor + 0.5 * wall_1f)
                        }
                        _ => None,
                    },
                    // AA56 = 屋根 + 2 階の内壁 + 2 階の床 + 0.5 × 1 階の内壁
                    interior: roof.map(|roof| {
                        roof + gypsum(Storey::Second) + floor + 0.5 * gypsum(Storey::First)
                    }),
                    clear_height: loads.height_1f - LOWER_STOREY_DEDUCTION / 1000.0,
                    display_span: loads.height_1f * 1000.0 - LOWER_STOREY_DEDUCTION,
                },
            ]
        }
    }
}

/// 柱の小径 de [mm]。
///
/// 配布物の AB53 / AC65 と同じで、
///   - 細長い側（l/52.70 > 必要断面）は座屈で決まる
///   - 太い側（l/8.66 < 必要断面）は圧縮で決まる
///   - 間は両方を見込んだ式
/// のいずれかを切り上げ、さらに有効細長比 150 から決まる下限
/// （√12 × l / 150）と比べて大きい方を採る。
fn column_size(span: f64, load: f64, strength: f64) -> Option<f64> {
    if !(strength > 0.0) || !span.is_finite() {
        return None;
    }
    // AA53 =SQRT(負担荷重 × 負担面積 / (1.1/3 × Fc) × 1000)
    let required = (load * COLUMN_LOAD_AREA / (LONG_TERM_FACTOR * strength) * 1000.0).sqrt();
    if !required.is_finite() {
        return None;
    }
    let slender = span / 52.70;
    let stocky = span / 8.66;
    let size = if slender > required {
        (12.0 * span * span / 3000.0 * required * required).powf(0.25)
    } else if stocky < required {
        required
    } else {
        span / 75.05 + ((span / 75.05).powi(2) + required * required / 1.3).sqrt()
    };
    let size = roundup(size, 0);
    // AC53 =ROUNDUP(SQRT(12)*l/150, 0)（有効細長比 150 以下にするための下限）
    let minimum = roundup(12f64.sqrt() * span / SLENDERNESS_LIMIT, 0);
    size.is_finite().then(|| size.max(minimum))
}

/// 2-1 算定式と有効細長比より柱の小径を求める場合。
///
/// すぎ・無等級材（Fc = 17.7 N/mm²）を前提にした早見。
fn column_1_section(input: &Input, storeys: &[ColumnStorey]) -> Section {
    let enabled = input.toggle("use_column_1");
    let rows = storeys
        .iter()
        .map(|storey| {
            let size = enabled
                .then(|| {
                    storey
                        .perimeter
                        .and_then(|load| column_size(storey.span, load, COLUMN_1_STRENGTH))
                })
                .flatten();
            Row {
                label: storey.storey.label().to_string(),
                cells: vec![
                    (
                        format!("column1.{}.ratio", storey.storey.key()),
                        size.map_or(Cell::Blank, |size| {
                            Cell::Text(format!(
                                "１/{}",
                                format_dimension(rounddown(storey.display_span / size, 1))
                            ))
                        }),
                    ),
                    (
                        format!("column1.{}.size", storey.storey.key()),
                        Cell::number(size),
                    ),
                ],
            }
        })
        .collect();

    Section {
        key: "column_1".to_string(),
        title: "2-1 算定式と有効細長比より柱の小径を求める場合".to_string(),
        note: "すぎ・無等級材（平成12年建設省告示第1452号第5号）を前提に算定します。".to_string(),
        enabled,
        tables: vec![Table {
            key: "column1".to_string(),
            title: String::new(),
            columns: vec![
                ("ratio".to_string(), "de/l".to_string()),
                ("size".to_string(), "柱の小径 de (mm 以上)".to_string()),
            ],
            rows,
        }],
    }
}

/// 2-2 樹種等を選択し、算定式と有効細長比より柱の小径を求める場合。
fn column_2_section(input: &Input, storeys: &[ColumnStorey]) -> Section {
    let enabled = input.toggle("use_column_2");
    let tables = storeys
        .iter()
        .map(|storey| {
            let floor = storey.storey.key();
            let rows = (1..=4)
                .map(|index| {
                    let strength = if index == 4 {
                        // ④ は国土交通大臣が基準強度を指定した木材等（直接入力）。
                        entered_strength(input, &format!("c2_{floor}_④_strength"))
                    } else {
                        looked_up_strength(input, &format!("c2_{floor}_{}", circled(index)))
                    };
                    column_row(
                        circled(index),
                        &format!("column2.{floor}.{index}"),
                        &strength,
                        enabled,
                        storey,
                    )
                })
                .collect();
            Table {
                key: format!("column2.{floor}"),
                title: format!("{}の柱", storey.storey.label()),
                columns: vec![
                    ("fc".to_string(), "圧縮の基準強度 Fc (N/mm²)".to_string()),
                    ("size".to_string(), "柱の小径 (mm 以上)".to_string()),
                ],
                rows,
            }
        })
        .collect();

    Section {
        key: "column_2".to_string(),
        title: "2-2 樹種等を選択し、算定式と有効細長比より柱の小径を求める場合".to_string(),
        note: String::new(),
        enabled,
        tables,
    }
}

/// 圧縮の基準強度 Fc の欄と、計算に使う値。
///
/// 配布物では Fc の欄が「表から引いた値」「該当なし」「大臣認定の直接入力」の
/// 3 通りある。表に無い組合せは以降の計算も止まる（#VALUE!）が、直接入力の
/// 空欄は 0 として計算が進む（結果は 0 か空欄になる）ので、区別して持つ。
struct Strength {
    cell: Cell,
    value: Option<f64>,
}

/// ①〜③: JAS 規格・樹種等・等級等から表を引く。
fn looked_up_strength(input: &Input, prefix: &str) -> Strength {
    let jas = input.text(&format!("{prefix}_jas"));
    let species = input.text(&format!("{prefix}_species"));
    let grade = input.text(&format!("{prefix}_grade"));
    match column_strength::lookup(&jas, &species, &grade) {
        Some(value) => Strength {
            cell: Cell::Number(value),
            value: Some(value),
        },
        None => Strength {
            cell: Cell::Text(NOT_IN_TABLE.to_string()),
            value: None,
        },
    }
}

/// 国土交通大臣が基準強度を指定した木材等（直接入力）。
fn entered_strength(input: &Input, key: &str) -> Strength {
    let entered = input.number(key);
    Strength {
        cell: entered.map_or(Cell::Blank, Cell::Number),
        // 空欄は 0（配布物の空セルと同じ）。
        value: Some(entered.unwrap_or(0.0)),
    }
}

fn column_row(
    label: &str,
    key_prefix: &str,
    strength: &Strength,
    enabled: bool,
    storey: &ColumnStorey,
) -> Row {
    let size = enabled
        .then(|| {
            let strength = strength.value?;
            let load = storey.perimeter?;
            column_size(storey.span, load, strength)
        })
        .flatten();
    Row {
        label: label.to_string(),
        cells: vec![
            (
                format!("{key_prefix}.fc"),
                if enabled {
                    strength.cell.clone()
                } else {
                    Cell::Blank
                },
            ),
            (format!("{key_prefix}.size"), Cell::number(size)),
        ],
    }
}

/// 2-3 柱の小径別に柱の負担可能面積を求める場合。
fn column_3_section(input: &Input, storeys: &[ColumnStorey]) -> Section {
    let enabled = input.toggle("use_column_3");

    // 任意入力の断面（長辺・短辺）。座屈方向の材せいは短い方。
    let free: Vec<(String, Option<(f64, f64)>)> = (1..=2)
        .map(|index| {
            let long = input.number(&format!("free_{index}_long"));
            let short = input.number(&format!("free_{index}_short"));
            (
                format!("任意入力{}", circled(index)),
                match (long, short) {
                    (Some(long), Some(short)) => Some((long, short)),
                    _ => None,
                },
            )
        })
        .collect();

    let mut columns = vec![("fc".to_string(), "圧縮の基準強度 Fc (N/mm²)".to_string())];
    for (name, _, _) in STANDARD_SECTIONS {
        columns.push((section_key(name), name.to_string()));
    }
    for (label, _) in &free {
        columns.push((section_key(label), label.clone()));
    }

    let mut tables = Vec::new();
    for storey in storeys {
        for (place, place_label, load) in [
            ("out", "外周部の柱", storey.perimeter),
            ("in", "内部の柱", storey.interior),
        ] {
            let floor = storey.storey.key();
            let rows = (1..=3)
                .map(|index| {
                    let prefix = format!("c3_{floor}_{place}_{}", circled(index));
                    let strength = if index == 3 {
                        entered_strength(input, &format!("{prefix}_strength"))
                    } else {
                        looked_up_strength(input, &prefix)
                    };
                    column_3_row(
                        circled(index),
                        &format!("column3.{floor}.{place}.{index}"),
                        &strength,
                        enabled,
                        storey,
                        load,
                        &free,
                    )
                })
                .collect();
            tables.push(Table {
                key: format!("column3.{floor}.{place}"),
                title: format!("{}{place_label}", storey.storey.label()),
                columns: columns.clone(),
                rows,
            });
        }
    }

    Section {
        key: "column_3".to_string(),
        title: "2-3 柱の小径別に柱の負担可能面積を求める場合".to_string(),
        note: "外周部の柱とは外壁面に存する柱、内部の柱とは外壁に面しない柱を指します。"
            .to_string(),
        enabled,
        tables,
    }
}

#[allow(clippy::too_many_arguments)]
fn column_3_row(
    label: &str,
    key_prefix: &str,
    strength: &Strength,
    enabled: bool,
    storey: &ColumnStorey,
    load: Option<f64>,
    free: &[(String, Option<(f64, f64)>)],
) -> Row {
    let mut cells = vec![(
        format!("{key_prefix}.fc"),
        if enabled {
            strength.cell.clone()
        } else {
            Cell::Blank
        },
    )];
    let sections = STANDARD_SECTIONS
        .iter()
        .map(|(name, long, short)| (name.to_string(), Some((*long, *short))))
        .chain(free.iter().cloned());
    for (name, size) in sections {
        let key = format!("{key_prefix}.{}", section_key(&name));
        cells.push((
            key,
            supportable_area(strength.value, load, storey, size, enabled),
        ));
    }
    Row {
        label: label.to_string(),
        cells,
    }
}

/// 柱 1 本が負担できる床面積 [m²]（Z78 等）。
///
/// 長期の許容圧縮応力度（1.1/3 × 座屈低減係数 × Fc）に断面積を掛け、
/// 床面積あたりの負担荷重で割る。有効細長比が 150 を超える細い柱は、
/// 面積ではなく「有効細長比150以上」という断りを出す（配布物と同じ）。
fn supportable_area(
    strength: Option<f64>,
    load: Option<f64>,
    storey: &ColumnStorey,
    size: Option<(f64, f64)>,
    enabled: bool,
) -> Cell {
    let (Some((long, short)), true) = (size, enabled) else {
        return Cell::Blank;
    };
    let depth = long.min(short);
    if depth <= 0.0 {
        return Cell::Blank;
    }
    if storey.clear_height * 1000.0 / depth > EFFECTIVE_SLENDERNESS_LIMIT {
        return Cell::Text(TOO_SLENDER.to_string());
    }
    let (Some(strength), Some(load)) = (strength, load) else {
        return Cell::Blank;
    };
    if load <= 0.0 {
        return Cell::Blank;
    }
    // λ =3.46 × 横架材間距離 / 座屈方向の材せい
    let slenderness = SLENDERNESS_COEFFICIENT * storey.span / depth;
    let reduction = if slenderness <= 30.0 {
        1.0
    } else if slenderness > 100.0 {
        3000.0 / (slenderness * slenderness)
    } else {
        1.3 - 0.01 * slenderness
    };
    let area = rounddown(
        LONG_TERM_FACTOR * reduction * strength * long * short / load / 1000.0,
        1,
    );
    Cell::number(Some(area))
}

/// 「①」〜「④」。配布物の行見出しと同じ。
fn circled(index: usize) -> &'static str {
    ["①", "②", "③", "④"][index - 1]
}

/// 断面の見出しから、突き合わせに使う ASCII の key を作る。
fn section_key(label: &str) -> String {
    match label {
        "105角" => "d105".to_string(),
        "120角" => "d120".to_string(),
        "任意入力①" => "free1".to_string(),
        "任意入力②" => "free2".to_string(),
        other => other.to_string(),
    }
}

// --- まとめ ------------------------------------------------------------------

/// フォーム入力から、配布物の「出力結果」と同じ値を計算する。
pub fn compute(data: &Value) -> Result<Value, String> {
    let input = Input::read(data)?;
    let loads = Loads::read(&input);
    let storeys = column_storeys(&loads, input.building);

    let sections = vec![
        wall_quantity_section(&input, &loads),
        column_1_section(&input, &storeys),
        column_2_section(&input, &storeys),
        column_3_section(&input, &storeys),
    ];

    Ok(Value::obj([
        ("building", input.building.key().into()),
        ("usage", input.usage.key().into()),
        (
            "sections",
            Value::Arr(sections.iter().map(Section::to_value).collect()),
        ),
    ]))
}

/// この計算が読む入力欄の key（建物ごと）。
///
/// マッピング（書き込み先のセル）とこちら（計算）で key がずれていないかを、
/// backend のテストが突き合わせるために配る。
pub fn input_keys(building: Building) -> Vec<String> {
    let mut keys: Vec<String> = [
        "height_1f",
        "ridge_minus_eaves",
        "seismic_zone",
        "base_shear",
        "heavy_snow",
        "snow_depth",
        "snow_unit_load",
        "floor_area_1f",
        "eaves",
        "roof_pitch",
        "roof_spec",
        "wall_spec",
        "solar",
        "solar_mass",
        "ceiling_insulation",
        "ceiling_custom_1_area",
        "ceiling_custom_1_density",
        "ceiling_custom_1_thickness",
        "ceiling_custom_2_area",
        "ceiling_custom_2_density",
        "ceiling_custom_2_thickness",
        "wall_insulation",
        "wall_custom_1_density",
        "wall_custom_1_thickness",
        "wall_custom_2_density",
        "wall_custom_2_thickness",
        "free_1_long",
        "free_1_short",
        "free_2_long",
        "free_2_short",
    ]
    .iter()
    .map(|key| key.to_string())
    .collect();

    if building == Building::TwoStory {
        keys.push("height_2f".to_string());
        keys.push("floor_area_2f".to_string());
    }

    for storey in building.storeys() {
        let floor = storey.key();
        for index in 1..=3 {
            for role in ["jas", "species", "grade"] {
                keys.push(format!("c2_{floor}_{}_{role}", circled(index)));
            }
        }
        keys.push(format!("c2_{floor}_④_strength"));
        for place in ["out", "in"] {
            for index in 1..=2 {
                for role in ["jas", "species", "grade"] {
                    keys.push(format!("c3_{floor}_{place}_{}_{role}", circled(index)));
                }
            }
            keys.push(format!("c3_{floor}_{place}_③_strength"));
        }
    }
    keys
}

/// 算定方法のチェックボックスの key。
pub fn toggle_keys() -> [&'static str; 3] {
    ["use_column_1", "use_column_2", "use_column_3"]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json;

    /// 配布物の「表計算ツール入力例」シートに入っている値。
    ///
    /// 2 階建て・住宅性能表示制度・多雪区域の例で、配布物が計算した結果が
    /// そのままシートに残っている。ここではその入力を渡し、同じ数値が
    /// 出ることを確かめる（配布物そのものとの突き合わせは backend の
    /// test_wall_quantity_calculation.py が行う）。
    fn example() -> Value {
        json::parse(
            r#"{
              "building": "two_story",
              "usage": "performance",
              "toggles": {"use_column_1": true, "use_column_2": true, "use_column_3": true},
              "values": {
                "height_2f": "3", "height_1f": "3", "ridge_minus_eaves": "0.5",
                "seismic_zone": "0.9", "base_shear": "0.2",
                "heavy_snow": "あり(多雪区域)", "snow_depth": "100", "snow_unit_load": "30",
                "floor_area_2f": "60", "floor_area_1f": "60",
                "eaves": "0.5", "roof_pitch": "4",
                "roof_spec": "スレート屋根", "wall_spec": "サイディング",
                "solar": "あり(200)\n（部位面積あたり）",
                "ceiling_insulation": "100\n（初期値・天井）",
                "wall_insulation": "70（初期値）",
                "c2_2f_①_jas": "JAS目視等級区分構造用製材",
                "c2_2f_①_species": "すぎ", "c2_2f_①_grade": "二級",
                "c2_2f_②_jas": "JAS同一等級構成集成材",
                "c2_2f_②_species": "ー", "c2_2f_②_grade": "E95-F315(4層以上)",
                "c2_1f_①_jas": "JAS目視等級区分構造用製材",
                "c2_1f_①_species": "すぎ", "c2_1f_①_grade": "二級",
                "c2_1f_②_jas": "JAS同一等級構成集成材",
                "c2_1f_②_species": "ー", "c2_1f_②_grade": "E95-F315(4層以上)",
                "free_1_long": "210", "free_1_short": "105",
                "c3_2f_out_①_jas": "JAS目視等級区分構造用製材",
                "c3_2f_out_①_species": "すぎ", "c3_2f_out_①_grade": "二級",
                "c3_2f_in_①_jas": "JAS目視等級区分構造用製材",
                "c3_2f_in_①_species": "すぎ", "c3_2f_in_①_grade": "二級",
                "c3_1f_out_①_jas": "JAS目視等級区分構造用製材",
                "c3_1f_out_①_species": "すぎ", "c3_1f_out_①_grade": "二級",
                "c3_1f_out_②_jas": "JAS同一等級構成集成材",
                "c3_1f_out_②_species": "ー", "c3_1f_out_②_grade": "E95-F315(4層以上)",
                "c3_1f_in_①_jas": "JAS目視等級区分構造用製材",
                "c3_1f_in_①_species": "すぎ", "c3_1f_in_①_grade": "二級",
                "c3_1f_in_②_jas": "JAS同一等級構成集成材",
                "c3_1f_in_②_species": "ー", "c3_1f_in_②_grade": "E95-F315(4層以上)"
              }
            }"#,
        )
        .unwrap()
    }

    /// 計算結果を key → 表示文字列の一覧にする。
    fn texts(data: &Value) -> Vec<(String, String)> {
        let result = compute(data).unwrap();
        let mut out = Vec::new();
        for section in result.get("sections").unwrap().as_array().unwrap() {
            for table in section.get("tables").unwrap().as_array().unwrap() {
                for row in table.get("rows").unwrap().as_array().unwrap() {
                    for cell in row.get("cells").unwrap().as_array().unwrap() {
                        out.push((
                            cell.get("key").unwrap().as_str().unwrap().to_string(),
                            cell.get("text").unwrap().as_str().unwrap().to_string(),
                        ));
                    }
                }
            }
        }
        out
    }

    fn text_of_key(data: &Value, key: &str) -> String {
        texts(data)
            .into_iter()
            .find(|(name, _)| name == key)
            .unwrap_or_else(|| panic!("{key} が結果にありません"))
            .1
    }

    /// 配布物の H45・J45・H46・J46・H47・J47。
    #[test]
    fn reproduces_the_required_wall_quantity_of_the_example() {
        let data = example();
        assert_eq!(text_of_key(&data, "lw.1f.grade1"), "44");
        assert_eq!(text_of_key(&data, "lw.2f.grade1"), "25");
        assert_eq!(text_of_key(&data, "lw.1f.grade2"), "64");
        assert_eq!(text_of_key(&data, "lw.2f.grade2"), "44");
        assert_eq!(text_of_key(&data, "lw.1f.grade3"), "77");
        assert_eq!(text_of_key(&data, "lw.2f.grade3"), "53");
    }

    /// 配布物の D59・F59・D60・F60。
    #[test]
    fn reproduces_the_column_size_of_the_example() {
        let data = example();
        assert_eq!(text_of_key(&data, "column1.2f.size"), "84");
        assert_eq!(text_of_key(&data, "column1.2f.ratio"), "１/34.4");
        assert_eq!(text_of_key(&data, "column1.1f.size"), "105");
        assert_eq!(text_of_key(&data, "column1.1f.ratio"), "１/27.4");
    }

    /// 配布物の Q69・T69・Q70・T70・Q71・T71・T72（2 階）と Q73〜T76（1 階）。
    #[test]
    fn reproduces_the_column_sizes_by_species_of_the_example() {
        let data = example();
        assert_eq!(text_of_key(&data, "column2.2f.1.fc"), "20.4");
        assert_eq!(text_of_key(&data, "column2.2f.1.size"), "81");
        assert_eq!(text_of_key(&data, "column2.2f.2.fc"), "26");
        assert_eq!(text_of_key(&data, "column2.2f.2.size"), "77");
        // 選んでいない行は、配布物と同じく「該当なし」で小径は空欄。
        assert_eq!(text_of_key(&data, "column2.2f.3.fc"), "該当なし");
        assert_eq!(text_of_key(&data, "column2.2f.3.size"), "");
        // ④（大臣認定）は基準強度を入れていないので空欄。
        assert_eq!(text_of_key(&data, "column2.2f.4.fc"), "");
        assert_eq!(text_of_key(&data, "column2.2f.4.size"), "");
        assert_eq!(text_of_key(&data, "column2.1f.1.size"), "102");
        assert_eq!(text_of_key(&data, "column2.1f.2.size"), "97");
    }

    /// 配布物の O86〜U86（2 階外周）・O89〜（2 階内部）・O92〜（1 階外周）。
    #[test]
    fn reproduces_the_supportable_areas_of_the_example() {
        let data = example();
        assert_eq!(text_of_key(&data, "column3.2f.out.1.d105"), "14.9");
        assert_eq!(text_of_key(&data, "column3.2f.out.1.d120"), "26.3");
        assert_eq!(text_of_key(&data, "column3.2f.out.1.free1"), "29.9");
        // 任意入力②は寸法を入れていないので空欄。
        assert_eq!(text_of_key(&data, "column3.2f.out.1.free2"), "");
        // ②は樹種を選んでいないので「該当なし」。
        assert_eq!(text_of_key(&data, "column3.2f.out.2.fc"), "該当なし");
        assert_eq!(text_of_key(&data, "column3.2f.out.2.d105"), "");
        // ③（大臣認定）は空欄なので、配布物と同じく 0。
        assert_eq!(text_of_key(&data, "column3.2f.out.3.d105"), "0");
        assert_eq!(text_of_key(&data, "column3.2f.in.1.d105"), "19.5");
        assert_eq!(text_of_key(&data, "column3.2f.in.1.d120"), "34.3");
        assert_eq!(text_of_key(&data, "column3.1f.out.1.d105"), "5.8");
        assert_eq!(text_of_key(&data, "column3.1f.out.1.d120"), "10.2");
        assert_eq!(text_of_key(&data, "column3.1f.out.1.free1"), "11.7");
        assert_eq!(text_of_key(&data, "column3.1f.out.2.d105"), "7.4");
        assert_eq!(text_of_key(&data, "column3.1f.in.1.d105"), "8");
        assert_eq!(text_of_key(&data, "column3.1f.in.2.d120"), "17.9");
    }

    /// 算定方法のチェックボックスが切りなら、配布物と同じく出力は空欄。
    #[test]
    fn leaves_the_column_sections_blank_when_they_are_not_used() {
        let mut data = example();
        if let Value::Obj(entries) = &mut data {
            for (key, value) in entries.iter_mut() {
                if key == "toggles" {
                    *value = Value::obj([]);
                }
            }
        }
        assert_eq!(text_of_key(&data, "column1.2f.size"), "");
        assert_eq!(text_of_key(&data, "column2.2f.1.fc"), "");
        assert_eq!(text_of_key(&data, "column3.2f.out.1.d105"), "");
        // 必要壁量はチェックボックスに関係なく出る。
        assert_eq!(text_of_key(&data, "lw.1f.grade1"), "44");
    }

    /// 入力が足りないうちは、配布物と同じく空欄のまま（エラーにしない）。
    #[test]
    fn leaves_the_output_blank_while_the_input_is_incomplete() {
        let data =
            json::parse(r#"{"building": "one_story", "usage": "standard", "values": {}}"#).unwrap();
        assert_eq!(text_of_key(&data, "lw.1f.grade1"), "");
        // 基準法のときは耐震等級の行そのものが出ない。
        assert!(!texts(&data).iter().any(|(key, _)| key == "lw.1f.grade2"));
    }

    #[test]
    fn refuses_an_unknown_building_or_usage() {
        for request in [
            r#"{"building": "three_story", "usage": "standard", "values": {}}"#,
            r#"{"building": "one_story", "usage": "", "values": {}}"#,
            r#"[]"#,
        ] {
            assert!(
                compute(&json::parse(request).unwrap()).is_err(),
                "{request}"
            );
        }
    }

    /// Excel の丸めは 15 桁の十進表記で行われる。
    #[test]
    fn rounds_like_excel() {
        assert_eq!(roundup(43.052, 0), 44.0);
        assert_eq!(roundup(51.0, 0), 51.0);
        // 2 進表現では 51 をわずかに超えるが、Excel は 51 として扱う。
        assert_eq!(roundup(51.000000000000007, 0), 51.0);
        assert_eq!(roundup(744.5454, -1), 750.0);
        assert_eq!(rounddown(14.98, 1), 14.9);
        assert_eq!(rounddown(26.3076, 1), 26.3);
        assert_eq!(rounddown(29.959999999999997, 1), 29.9);
    }

    /// 平屋建てでも 2 階建てでも、計算が読む key はマッピングにあるものだけ。
    #[test]
    fn lists_the_input_keys_it_reads() {
        let keys = input_keys(Building::OneStory);
        assert!(keys.contains(&"height_1f".to_string()));
        assert!(!keys.contains(&"height_2f".to_string()));
        assert!(keys.contains(&"c2_1f_①_jas".to_string()));
        assert!(keys.contains(&"c3_1f_in_③_strength".to_string()));

        let keys = input_keys(Building::TwoStory);
        assert!(keys.contains(&"height_2f".to_string()));
        assert!(keys.contains(&"c2_2f_④_strength".to_string()));
    }
}
