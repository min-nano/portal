//! フォーム入力の正規化と、画面・計算書 PDF が共有する計算結果の組み立て。
//!
//! 「入力欄の文字列をどう釘座標として読むか」「計算できない入力をどう説明
//! するか」「結果を何桁で見せるか」まで含めてここに置く。画面（wasm）と
//! サーバ（同じ .wasm）は同じ関数を呼ぶので、編集中に見ている数値と計算書
//! PDF に刷られる数値が食い違うことがない。
//!
//! 入力の単位は **壁 1 枚**（グレー本 3.3 の面材張り大壁）で、釘配列諸定数
//! （同 3.2）はその壁を構成する面材ごとの計算として中に入る。実際の設計では
//! 面材の種類と釘が先に決まっていて、面材の配置・釘の間隔・へりあきで耐力を
//! 調整するので、釘配列だけを先に決めて使い回す形にはしていない。
//!
//! 移植元は GAS 版 gas-timber-panel-shear-calculator と、その Python 移植
//! （backend/app/panel_shear.py の計算部分）。

use crate::format::{format_dimension, format_int, significant, SIGNIFICANT_DIGITS};
use crate::json::Value;
use crate::layout::{self, Arrangement, Layout, DEFAULT_EDGE_DISTANCE};
use crate::nail_array::{self, Nail};
use crate::wall;

/// 面材 1 枚あたりの釘の上限。実務の面材 1 枚では 100 本程度なので十分に
/// 余裕がある。桁を間違えた入力（釘ピッチに 1 mm と書くなど）で計算と
/// ページ描画が止まらないようにするための歯止め。
pub const MAX_NAILS: usize = 2000;
/// 1 物件あたりの壁の上限と、壁 1 枚を構成する面材の上限。
pub const MAX_WALLS: usize = 50;
pub const MAX_WALL_PANELS: usize = 20;

/// 釘配列図に添える座標値の有効桁数（図は小さいので本文より粗くする）。
const DIAGRAM_AXIS_DIGITS: usize = 4;

/// 壁を構成する面材 1 枚分の入力（釘配列とその寸法）。
///
/// 釘配列の入れ方は 3 通り:
///   - `layout`: 割り付け（型・間柱ピッチ・釘ピッチ・へりあき）から座標を作る
///   - `grid`  : X と Y の座標リストの全組合せ
///   - `coords`: 「x, y」を 1 行に 1 本ずつ
#[derive(Debug, Clone, PartialEq)]
pub struct PanelInput {
    pub panel_id: String,
    pub panel_name: String,
    /// 面材の幅 W [mm]。
    pub width: f64,
    /// 面材の高さ H [mm]。
    pub height: f64,
    pub mode: String,
    /// 配列の型（川型・山型・ロ型・日型）。
    pub arrangement: String,
    /// 間柱・根太ピッチ [mm]。
    pub stud_pitch: f64,
    /// 釘ピッチ [mm]。
    pub nail_pitch: f64,
    /// へりあき（面材の縁から釘の中心までの距離）[mm]。
    ///
    /// 面材の種類・釘の呼び径に合わせて面材ごとに決められるよう、割り付けの
    /// 入力欄にしてある（未入力なら既定の 10 mm）。
    pub edge_distance: f64,
    pub grid_x: String,
    pub grid_y: String,
    pub coords: String,
    /// 面材の繊維方向（"" は長辺方向）。せん断座屈の a・b の取り方を決める。
    pub grain: String,
}

/// 壁 1 枚分の入力（グレー本 3.3 の面材張り大壁）。
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
    pub panels: Vec<PanelInput>,
}

/// フォーム全体の入力（1 ファイル = 1 物件）。
#[derive(Debug, Clone, PartialEq)]
pub struct FormData {
    pub project_name: String,
    pub issued_on: String,
    pub walls: Vec<WallInput>,
}

impl PanelInput {
    pub fn panel_area(&self) -> f64 {
        self.width * self.height
    }

    /// 割り付け（mode = "layout"）としての読み方。
    pub fn layout(&self) -> Layout {
        Layout {
            width: self.width,
            height: self.height,
            stud_pitch: self.stud_pitch,
            nail_pitch: self.nail_pitch,
            edge_distance: self.edge_distance,
            arrangement: Arrangement::from_id(&self.arrangement),
        }
    }

    pub fn to_value(&self) -> Value {
        Value::obj([
            ("panelId", self.panel_id.clone().into()),
            ("panelName", self.panel_name.clone().into()),
            ("width", self.width.into()),
            ("height", self.height.into()),
            ("mode", self.mode.clone().into()),
            ("arrangement", self.arrangement.clone().into()),
            ("studPitch", self.stud_pitch.into()),
            ("nailPitch", self.nail_pitch.into()),
            ("edgeDistance", self.edge_distance.into()),
            ("gridX", self.grid_x.clone().into()),
            ("gridY", self.grid_y.clone().into()),
            ("coords", self.coords.clone().into()),
            ("grain", self.grain.clone().into()),
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
                Value::Arr(self.panels.iter().map(PanelInput::to_value).collect()),
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
                "walls",
                Value::Arr(self.walls.iter().map(WallInput::to_value).collect()),
            ),
        ])
    }
}

// --- 入力の正規化 ------------------------------------------------------------

/// 受け取った本文を、このツールが扱う形へ整える。
///
/// 未知のキーは捨て、壁は 1 枚以上に整える（空のフォームでも「壁が 1 枚
/// ある」状態から編集を始められるようにする）。釘配列だけを先に登録して
/// 使い回していた古い形の入力（`patterns`）も、ここで今の形へ移し替える。
pub fn normalize_data(data: &Value) -> Result<FormData, String> {
    if !matches!(data, Value::Obj(_)) {
        return Err("入力データがありません。".to_string());
    }

    let migrated = walls_of_legacy_patterns(data);
    let raw_walls: &[Value] = match (&migrated, data.get("walls")) {
        (Some(walls), _) => walls.as_slice(),
        (None, Some(Value::Arr(items))) => items.as_slice(),
        _ => &[],
    };
    if raw_walls.len() > MAX_WALLS {
        return Err(format!("壁は {MAX_WALLS} 枚までです。"));
    }

    let mut walls = Vec::with_capacity(raw_walls.len().max(1));
    for (index, item) in raw_walls.iter().enumerate() {
        walls.push(normalize_wall(item, index)?);
    }
    if walls.is_empty() {
        walls.push(normalize_wall(&Value::Null, 0)?);
    }

    Ok(FormData {
        project_name: text_of(data.get("projectName")),
        issued_on: text_of(data.get("issuedOn")),
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
            "1 枚の壁に置ける面材は {MAX_WALL_PANELS} 枚までです。"
        ));
    }
    let mut panels = Vec::with_capacity(raw_panels.len());
    for (position, panel) in raw_panels.iter().enumerate() {
        panels.push(normalize_panel(panel, &wall_id, position)?);
    }

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

pub fn normalize_panel(panel: &Value, wall_id: &str, index: usize) -> Result<PanelInput, String> {
    let panel_id = match text_of(panel.get("panelId")) {
        id if id.is_empty() => format!("{wall_id}-p{}", index + 1),
        id => id,
    };
    let mode = match text_of(panel.get("mode")).as_str() {
        "coords" => "coords".to_string(),
        "grid" => "grid".to_string(),
        _ => "layout".to_string(),
    };
    Ok(PanelInput {
        panel_id,
        panel_name: text_of(panel.get("panelName")),
        width: float_of(panel.get("width"), "面材の幅 W")?,
        height: float_of(panel.get("height"), "面材の高さ H")?,
        mode,
        arrangement: Arrangement::from_id(&text_of(panel.get("arrangement")))
            .id()
            .to_string(),
        stud_pitch: float_of(panel.get("studPitch"), "間柱・根太ピッチ")?,
        nail_pitch: float_of(panel.get("nailPitch"), "釘ピッチ")?,
        // 未入力のへりあきは、表 3.2.1 の配列が前提とする 10 mm とみなす。
        edge_distance: float_or(panel.get("edgeDistance"), "へりあき", DEFAULT_EDGE_DISTANCE)?,
        grid_x: text_of(panel.get("gridX")),
        grid_y: text_of(panel.get("gridY")),
        coords: text_of(panel.get("coords")),
        grain: wall::Grain::from_id(&text_of(panel.get("grain")))
            .id()
            .to_string(),
    })
}

/// 古い形（釘配列パターンを別に登録し、壁から patternId で指す）の入力を、
/// 今の形（壁が面材そのものを持つ）の壁の並びへ移し替える。
///
/// 計算書 PDF が保存形式なので、前の版で保存したファイルも開けるようにする。
/// どの壁からも参照されていないパターンは、面材 1 枚だけの壁として残す
/// （入力を黙って捨てない。面材と釘の数値は空なので、開いた人が埋める）。
fn walls_of_legacy_patterns(data: &Value) -> Option<Vec<Value>> {
    let patterns = match data.get("patterns") {
        Some(Value::Arr(items)) if !items.is_empty() => items,
        _ => return None,
    };
    // 古い正規化は、patternId が空なら "p1", "p2", … を割り当てていた。
    let identified: Vec<(String, &Value)> = patterns
        .iter()
        .enumerate()
        .map(|(index, pattern)| {
            let id = match text_of(pattern.get("patternId")) {
                id if id.is_empty() => format!("p{}", index + 1),
                id => id,
            };
            (id, pattern)
        })
        .collect();

    let mut used: Vec<String> = Vec::new();
    let mut walls: Vec<Value> = Vec::new();
    if let Some(Value::Arr(items)) = data.get("walls") {
        for item in items {
            let panels = match item.get("panels") {
                Some(Value::Arr(panels)) => panels
                    .iter()
                    .filter_map(|panel| {
                        let pattern_id = text_of(panel.get("patternId"));
                        if pattern_id.is_empty() {
                            return None;
                        }
                        let (_, pattern) = identified
                            .iter()
                            .find(|(id, _)| *id == pattern_id)?;
                        used.push(pattern_id);
                        Some(panel_of_legacy_pattern(
                            pattern,
                            text_of(panel.get("grain")),
                        ))
                    })
                    .collect(),
                _ => Vec::new(),
            };
            walls.push(with_panels(item, panels));
        }
    }

    for (id, pattern) in &identified {
        if used.contains(id) {
            continue;
        }
        walls.push(Value::obj([
            ("wallName", text_of(pattern.get("patternName")).into()),
            (
                "panels",
                Value::Arr(vec![panel_of_legacy_pattern(pattern, String::new())]),
            ),
        ]));
    }
    Some(walls)
}

/// 古い形の釘配列パターン 1 つを、面材 1 枚分の入力にする。
fn panel_of_legacy_pattern(pattern: &Value, grain: String) -> Value {
    let mode = if text_of(pattern.get("mode")) == "coords" {
        "coords"
    } else {
        "grid"
    };
    Value::obj([
        ("panelName", text_of(pattern.get("patternName")).into()),
        (
            "width",
            pattern.get("width").cloned().unwrap_or(Value::Null),
        ),
        (
            "height",
            pattern.get("height").cloned().unwrap_or(Value::Null),
        ),
        ("mode", mode.into()),
        ("gridX", text_of(pattern.get("gridX")).into()),
        ("gridY", text_of(pattern.get("gridY")).into()),
        ("coords", text_of(pattern.get("coords")).into()),
        ("grain", grain.into()),
    ])
}

/// 壁の入力から panels だけを差し替えた値を作る（他のキーはそのまま）。
fn with_panels(wall: &Value, panels: Vec<Value>) -> Value {
    let mut entries: Vec<(String, Value)> = match wall {
        Value::Obj(entries) => entries
            .iter()
            .filter(|(key, _)| key != "panels")
            .cloned()
            .collect(),
        _ => Vec::new(),
    };
    entries.push(("panels".to_string(), Value::Arr(panels)));
    Value::Obj(entries)
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
    float_or(value, label, 0.0)
}

/// 数値として読む。未入力（欠落・null・空文字）は default とみなす。
fn float_or(value: Option<&Value>, label: &str, default: f64) -> Result<f64, String> {
    let number = match value {
        None | Some(Value::Null) => return Ok(default),
        Some(Value::Num(number)) => *number,
        Some(Value::Str(text)) => {
            let text = text.trim();
            if text.is_empty() {
                return Ok(default);
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

/// この面材を計算できない理由を返す（計算できるなら None）。
///
/// nail_array 側にも同じ状況を弾く guard があるが、あちらは計算式が壊れた
/// 入力を受け取らないための最終防衛線で、文言も式の言葉（「Ix + Iy が 0」）で
/// 書かれている。画面に出すのは、入力欄の言葉で書いたこちらの理由。
///
/// ここで挙げるものが、入力から到達しうる計算不能のすべて:
///   - 釘が無い / 面積が 0     … nail_array::validate_input
///   - 釘が 1 点に集中している … Ix + Iy = 0
///   - 釘が 1 直線上に並ぶ     … Zx もしくは Zy が 0 → Zxy = 0
fn unusable_reason(panel: &PanelInput, nails: &[Nail]) -> Option<String> {
    if nails.is_empty() {
        return Some("釘座標が入力されていません。少なくとも 1 本の釘が必要です。".to_string());
    }
    if !(panel.panel_area() > 0.0) {
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

/// 割り付け（mode = "layout"）が釘を置けない理由を返す。
fn unusable_layout_reason(panel: &PanelInput) -> Option<String> {
    if !(panel.panel_area() > 0.0) {
        return Some("面材の幅 W と高さ H に正の数値を入力してください。".to_string());
    }
    if !(panel.nail_pitch > 0.0) {
        return Some("釘ピッチには正の数値を入力してください。".to_string());
    }
    if panel.edge_distance < 0.0 {
        return Some("へりあきには 0 以上の数値を入力してください。".to_string());
    }
    let span_x = panel.width - panel.edge_distance * 2.0;
    let span_y = panel.height - panel.edge_distance * 2.0;
    if !(span_x > 0.0) || !(span_y > 0.0) {
        return Some(
            "へりあきが面材の寸法に対して大きすぎます。面材の内側に釘を置けません。".to_string(),
        );
    }
    // 間柱の位置は数え上げで作るので、桁違いに小さいピッチは先に止める。
    if panel.stud_pitch > 0.0 && panel.width / panel.stud_pitch > MAX_NAILS as f64 {
        return Some(format!(
            "間柱・根太ピッチが小さすぎます（面材の幅 {} mm に対して釘の列が {} 本を超えます）。",
            format_int(panel.width),
            MAX_NAILS
        ));
    }
    None
}

/// 釘リストと、計算できない理由（計算できるなら None）を返す。
///
/// 理由をエラーではなく戻り値にしているのは、入力途中の面材を画面へ
/// そのまま出すため。
fn nails_and_reason(panel: &PanelInput) -> (Vec<Nail>, Option<String>) {
    let too_many = |count: usize| {
        format!(
            "釘の本数が多すぎます（{count} 本）。面材 1 枚あたり {MAX_NAILS} 本までにしてください。"
        )
    };
    let nails = match panel.mode.as_str() {
        "layout" => {
            if let Some(reason) = unusable_layout_reason(panel) {
                return (Vec::new(), Some(reason));
            }
            let layout = panel.layout();
            // 割り付けは本数が寸法とピッチで決まるので、作る前に数える。
            let count = layout.nail_count();
            if count > MAX_NAILS {
                return (Vec::new(), Some(too_many(count)));
            }
            layout.nails()
        }
        "grid" => {
            let xs = parse_number_list(&panel.grid_x);
            let ys = parse_number_list(&panel.grid_y);
            // 格子は組み合わせの数で増えるので、作る前に本数を確かめる。
            if xs.len() * ys.len() > MAX_NAILS {
                return (
                    Vec::new(),
                    Some(format!(
                        "釘の本数が多すぎます（{} × {} 本）。面材 1 枚あたり {} 本までにしてください。",
                        xs.len(),
                        ys.len(),
                        MAX_NAILS
                    )),
                );
            }
            nail_array::build_rectangular_grid(&xs, &ys)
        }
        _ => {
            let nails = parse_coord_lines(&panel.coords);
            if nails.len() > MAX_NAILS {
                return (Vec::new(), Some(too_many(nails.len())));
            }
            nails
        }
    };
    let reason = unusable_reason(panel, &nails);
    (nails, reason)
}

/// 面材の入力方式に応じて釘リストを組み立てる（計算できない入力はエラー）。
pub fn nails_of(panel: &PanelInput) -> Result<Vec<Nail>, String> {
    let (nails, reason) = nails_and_reason(panel);
    match reason {
        Some(reason) => Err(reason),
        None => Ok(nails),
    }
}

// --- 計算（画面と PDF が共有する表示用データ） ------------------------------

/// 全ての壁を計算する。計算できない壁は ok: false で返す。
///
/// 入力途中でも画面に出せるよう、1 枚の壁の不備で他の壁の結果まで
/// 失わせない（保存時は validate_walls() で改めて全件を確かめる）。
pub fn compute_all_walls(data: &FormData) -> Value {
    Value::Arr(
        data.walls
            .iter()
            .enumerate()
            .map(|(index, input)| match build_wall_report(input, index) {
                Ok(report) => with_ok(report),
                Err(error) => Value::obj([
                    ("ok", false.into()),
                    ("wallId", input.wall_id.clone().into()),
                    ("wallName", wall_label(input, index).into()),
                    ("error", error.into()),
                    // 壁として計算できなくても、面材ごとの釘配列は出せるところ
                    // まで出す（入力の途中でも図と諸定数を見ながら直せる）。
                    ("panelReports", compute_all_panels(input)),
                ]),
            })
            .collect(),
    )
}

/// 計算できた結果に ok: true を先頭へ付ける（画面が成否で分岐できるように）。
fn with_ok(report: Value) -> Value {
    match report {
        Value::Obj(mut entries) => {
            entries.insert(0, ("ok".to_string(), true.into()));
            Value::Obj(entries)
        }
        other => other,
    }
}

/// 壁を構成する面材の釘配列諸定数（グレー本 3.2）を、1 枚ずつ計算する。
/// 計算できない面材は ok: false で返す。
fn compute_all_panels(input: &WallInput) -> Value {
    Value::Arr(
        input
            .panels
            .iter()
            .enumerate()
            .map(|(index, panel)| {
                let (nails, reason) = nails_and_reason(panel);
                let report = match reason {
                    Some(reason) => Err(reason),
                    None => build_panel_report(panel, &nails, index),
                };
                match report {
                    Ok(report) => with_ok(report),
                    Err(error) => Value::obj([
                        ("ok", false.into()),
                        ("panelId", panel.panel_id.clone().into()),
                        ("panelName", panel_label(panel, index).into()),
                        ("error", error.into()),
                    ]),
                }
            })
            .collect(),
    )
}

/// 保存できる状態か確かめ、全ての壁の計算結果を返す。
pub fn validate_walls(data: &FormData) -> Result<Vec<Value>, String> {
    let mut reports = Vec::with_capacity(data.walls.len());
    for (index, input) in data.walls.iter().enumerate() {
        reports.push(build_wall_report(input, index).map_err(|error| {
            format!("「{}」を計算できません: {error}", wall_label(input, index))
        })?);
    }
    Ok(reports)
}

/// 面材 1 枚を計算し、画面表示にも PDF にも使える形で返す。
///
/// 表示用の文字列（有効桁・単位）まで組み立てて返すことで、画面と計算書で
/// 桁の丸め方が食い違わないようにしている。
pub fn compute_panel(panel: &PanelInput, index: usize) -> Result<Value, String> {
    let nails = nails_of(panel)?;
    build_panel_report(panel, &nails, index)
}

/// 面材の見出しに使う名前（未入力なら通し番号で代替する）。
pub fn panel_label(panel: &PanelInput, index: usize) -> String {
    if panel.panel_name.is_empty() {
        format!("面材{}", index + 1)
    } else {
        panel.panel_name.clone()
    }
}

/// 壁の見出しに使う名前（未入力なら通し番号で代替する）。
pub fn wall_label(input: &WallInput, index: usize) -> String {
    if input.wall_name.is_empty() {
        format!("壁{}", index + 1)
    } else {
        input.wall_name.clone()
    }
}

fn nail_arrangement_text(panel: &PanelInput, nails: &[Nail]) -> String {
    match panel.mode.as_str() {
        "layout" => format!(
            "割り付け　{}　／　間柱・根太 @{}　／　釘 @{}　／　へりあき {} mm",
            Arrangement::from_id(&panel.arrangement).label(),
            format_dimension(panel.stud_pitch),
            format_dimension(panel.nail_pitch),
            format_dimension(panel.edge_distance),
        ),
        "grid" => format!("格子　X: {}　／　Y: {}", panel.grid_x, panel.grid_y),
        _ => format!("座標を直接入力（{} 点）", nails.len()),
    }
}

/// 計算できると分かっている面材の結果を組み立てる。
fn build_panel_report(panel: &PanelInput, nails: &[Nail], index: usize) -> Result<Value, String> {
    let area = panel.panel_area();
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
        ("panelId", panel.panel_id.clone().into()),
        ("panelName", panel_label(panel, index).into()),
        ("width", panel.width.into()),
        ("height", panel.height.into()),
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
                            format_int(panel.width),
                            format_int(panel.height)
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
                    ("value", nail_arrangement_text(panel, nails).into()),
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
        ("diagram", build_diagram(panel, nails, &result)),
    ]))
}

// --- 壁の計算（グレー本 3.3） -----------------------------------------------

/// 壁 1 枚の結果を、画面表示にも PDF にも使える形で組み立てる。
///
/// 面材ごとの釘配列諸定数（グレー本 3.2）も、この壁の計算の一部として
/// `panelReports` に入れて返す。壁の計算の根拠がその場でそろう。
fn build_wall_report(input: &WallInput, index: usize) -> Result<Value, String> {
    if input.panels.is_empty() {
        return Err(
            "壁を構成する面材がありません。面材を 1 枚以上追加してください。".to_string(),
        );
    }

    let mut panel_reports = Vec::with_capacity(input.panels.len());
    let mut specs = Vec::with_capacity(input.panels.len());
    for (position, panel) in input.panels.iter().enumerate() {
        let named = |error: String| {
            format!(
                "面材「{}」を計算できません: {error}",
                panel_label(panel, position)
            )
        };
        let nails = nails_of(panel).map_err(named)?;
        let constants =
            nail_array::compute(&nails, panel.panel_area()).map_err(|error| named(error.0))?;
        panel_reports.push(with_ok(build_panel_report(panel, &nails, position)?));
        specs.push(wall::PanelSpec::new(
            &panel_label(panel, position),
            &constants,
            panel.width,
            panel.height,
            wall::Grain::from_id(&panel.grain),
        ));
    }

    let result = wall::compute(&wall::Wall {
        height: input.height,
        width: input.width,
        sheathing: input.sheathing(),
        nail: input.nail(),
        has_intermediate_stud: input.has_intermediate_stud,
        panels: specs,
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
        inputs.push(row(
            "面材と釘の組合せ",
            format!(
                "{}（釘の呼び径 φ{} mm）",
                material.label(),
                format_dimension(material.nail_diameter)
            ),
        ));
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
        ("panelReports", Value::Arr(panel_reports)),
        ("inputs", Value::Arr(inputs)),
        (
            "panelColumns",
            Value::Arr(
                [
                    "面材",
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
                    "面材",
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
fn build_diagram(panel: &PanelInput, nails: &[Nail], result: &nail_array::Constants) -> Value {
    let mut min_x = 0.0_f64;
    let mut max_x = panel.width;
    let mut min_y = 0.0_f64;
    let mut max_y = panel.height;
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
        ("panelWidth", panel.width.into()),
        ("panelHeight", panel.height.into()),
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

/// 割り付けの型（画面の選択肢）。
pub fn arrangements() -> Value {
    Value::Arr(
        layout::ARRANGEMENTS
            .iter()
            .map(|arrangement| {
                Value::obj([
                    ("id", arrangement.id().into()),
                    ("label", arrangement.label().into()),
                    ("note", arrangement.description().into()),
                ])
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json;

    /// グレー本 解説の計算例（図 3.2.2）。W 910 × H 610 の横置きで、
    /// へりあき 10 mm を見込んだ配列（本は左下の釘を (0, 0) として書いている）。
    fn example_panel() -> PanelInput {
        PanelInput {
            panel_id: "w1-p1".to_string(),
            panel_name: "グレー本の計算例".to_string(),
            width: 910.0,
            height: 610.0,
            mode: "layout".to_string(),
            arrangement: "kawa".to_string(),
            stud_pitch: 455.0,
            nail_pitch: 150.0,
            edge_distance: 10.0,
            grid_x: String::new(),
            grid_y: String::new(),
            coords: String::new(),
            grain: String::new(),
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
        let data = normalize(
            r#"{"projectName": " 邸 ", "unknown": 1,
                "walls": [{"height": "2900", "junk": 2, "panels": [{"width": "610"}]}]}"#,
        )
        .unwrap();
        assert_eq!(data.project_name, "邸");
        assert_eq!(data.walls[0].height, 2900.0);
        assert_eq!(data.walls[0].panels[0].width, 610.0);
        assert_eq!(data.to_value().get("unknown"), None);
        assert_eq!(data.to_value().get("patterns"), None);
    }

    /// 壁が 1 枚も無い入力でも、画面が編集を始められる形にする。
    #[test]
    fn gives_an_empty_form_one_wall() {
        let data = normalize("{}").unwrap();
        assert_eq!(data.walls.len(), 1);
        assert_eq!(data.walls[0].wall_id, "w1");
        assert!(data.walls[0].panels.is_empty());
    }

    /// 面材の既定は「割り付け・日型（四周打ち）・へりあき 10 mm」。
    #[test]
    fn a_panel_defaults_to_a_four_sided_layout() {
        let data = normalize(r#"{"walls": [{"panels": [{"width": 910}]}]}"#).unwrap();
        let panel = &data.walls[0].panels[0];
        assert_eq!(panel.panel_id, "w1-p1");
        assert_eq!(panel.mode, "layout");
        assert_eq!(panel.arrangement, "hi");
        assert_eq!(panel.edge_distance, DEFAULT_EDGE_DISTANCE);
    }

    /// へりあきは面材ごとに変えられる（釘・面材の種類に合わせるため）。
    #[test]
    fn the_edge_distance_is_per_panel() {
        let data = normalize(
            r#"{"walls": [{"panels": [{"edgeDistance": 15}, {"edgeDistance": "0"}]}]}"#,
        )
        .unwrap();
        assert_eq!(data.walls[0].panels[0].edge_distance, 15.0);
        assert_eq!(data.walls[0].panels[1].edge_distance, 0.0);
    }

    #[test]
    fn rejects_a_non_numeric_dimension() {
        let error = normalize(r#"{"walls": [{"panels": [{"width": "ろく"}]}]}"#).unwrap_err();
        assert!(error.contains("面材の幅 W"), "{error}");
    }

    #[test]
    fn rejects_too_many_walls_and_panels() {
        let walls = vec![r#"{"height": 1}"#; MAX_WALLS + 1].join(",");
        let error = normalize(&format!(r#"{{"walls": [{walls}]}}"#)).unwrap_err();
        assert!(error.contains("壁は"), "{error}");

        let panels = vec![r#"{"width": 910}"#; MAX_WALL_PANELS + 1].join(",");
        let error = normalize(&format!(r#"{{"walls": [{{"panels": [{panels}]}}]}}"#)).unwrap_err();
        assert!(error.contains("面材は"), "{error}");
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

    // --- 古い形（釘配列パターン）の読み込み ----------------------------------

    /// 前の版で保存した PDF（パターンを別に登録し、壁が patternId で指す形）は、
    /// 壁が面材そのものを持つ今の形へ移して読む。
    #[test]
    fn reads_the_legacy_pattern_form() {
        let data = normalize(
            r#"{"patterns": [
                 {"patternId": "p1", "patternName": "南面 下", "width": 910, "height": 610,
                  "mode": "grid", "gridX": "10, 455, 900", "gridY": "10, 155, 305, 455, 600"}],
               "walls": [{"wallName": "南面", "height": 2900, "width": 910,
                          "panels": [{"patternId": "p1", "grain": "width"}]}]}"#,
        )
        .unwrap();

        assert_eq!(data.walls.len(), 1);
        let panel = &data.walls[0].panels[0];
        assert_eq!(panel.panel_name, "南面 下");
        assert_eq!(panel.width, 910.0);
        assert_eq!(panel.mode, "grid");
        assert_eq!(panel.grid_x, "10, 455, 900");
        assert_eq!(panel.grain, "width");
        assert_eq!(data.walls[0].wall_name, "南面");
        assert_eq!(data.walls[0].height, 2900.0);
    }

    /// どの壁からも使われていない古いパターンも捨てない（壁 1 枚として残す）。
    #[test]
    fn keeps_legacy_patterns_that_no_wall_used() {
        let data = normalize(
            r#"{"patterns": [
                 {"patternId": "p1", "patternName": "使う", "width": 910, "height": 610,
                  "mode": "coords", "coords": "10, 10"},
                 {"patternId": "p2", "patternName": "余り", "width": 910, "height": 910}],
               "walls": [{"wallName": "南面", "panels": [{"patternId": "p1"}]}]}"#,
        )
        .unwrap();

        assert_eq!(data.walls.len(), 2);
        assert_eq!(data.walls[0].panels[0].panel_name, "使う");
        assert_eq!(data.walls[0].panels[0].mode, "coords");
        assert_eq!(data.walls[1].wall_name, "余り");
        assert_eq!(data.walls[1].panels[0].width, 910.0);
    }

    // --- 面材 1 枚の計算（グレー本 3.2） -------------------------------------

    #[test]
    fn the_reference_example_matches_the_book() {
        let report = compute_panel(&example_panel(), 0).unwrap();

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
        let report = compute_panel(&example_panel(), 0).unwrap();
        let inputs = labelled(&report, "inputs", "label");
        assert!(inputs.contains(&("面材寸法 W × H".to_string(), "910 × 610 mm".to_string())));
        assert!(inputs.contains(&("面材面積 Aw".to_string(), "555,100 mm²".to_string())));
        assert!(inputs.contains(&("釘本数 n".to_string(), "15 本".to_string())));
        // 割り付けの入力は、型・ピッチ・へりあきがそのまま読める形で残す。
        let arrangement = inputs
            .iter()
            .find(|(label, _)| label == "釘配列")
            .map(|(_, value)| value.clone())
            .unwrap();
        assert!(arrangement.contains("川型"), "{arrangement}");
        assert!(arrangement.contains("釘 @150"), "{arrangement}");
        assert!(arrangement.contains("へりあき 10 mm"), "{arrangement}");
    }

    /// へりあきを広げると釘が内側に寄り、諸定数が小さくなる。
    #[test]
    fn a_wider_edge_distance_lowers_the_constants() {
        let narrow = compute_panel(&example_panel(), 0).unwrap();
        let wide = compute_panel(
            &PanelInput {
                edge_distance: 30.0,
                ..example_panel()
            },
            0,
        )
        .unwrap();
        let ixy = |report: &Value| report.get("result").unwrap().get("Ixy").unwrap().as_f64();
        assert!(ixy(&wide) < ixy(&narrow));
    }

    #[test]
    fn a_grid_is_every_combination() {
        let panel = PanelInput {
            mode: "grid".to_string(),
            grid_x: "10, 455, 900".to_string(),
            grid_y: "10, 155, 305, 455, 600".to_string(),
            ..example_panel()
        };
        assert_eq!(nails_of(&panel).unwrap().len(), 15);
    }

    #[test]
    fn coordinate_mode_reads_the_text_area() {
        let panel = PanelInput {
            mode: "coords".to_string(),
            coords: "0, 0\n0, 455\n455, 910".to_string(),
            ..example_panel()
        };
        let report = compute_panel(&panel, 0).unwrap();
        assert_eq!(report.get("nails").unwrap().as_array().unwrap().len(), 3);
        let inputs = labelled(&report, "inputs", "label");
        assert!(inputs.contains(&("釘配列".to_string(), "座標を直接入力（3 点）".to_string())));
    }

    /// 桁を間違えた入力で計算とページ描画が止まらないようにする。
    #[test]
    fn rejects_an_absurd_number_of_nails() {
        // 割り付け: 釘ピッチ 1 mm。
        let dense = PanelInput {
            nail_pitch: 0.5,
            ..example_panel()
        };
        assert!(nails_of(&dense).unwrap_err().contains("釘の本数が多すぎます"));

        // 格子: 100 × 100 の組合せ。
        let axis = (0..100).map(|i| i.to_string()).collect::<Vec<_>>().join(",");
        let grid = PanelInput {
            mode: "grid".to_string(),
            grid_x: axis.clone(),
            grid_y: axis,
            ..example_panel()
        };
        assert!(nails_of(&grid).unwrap_err().contains("釘の本数が多すぎます"));
    }

    /// 計算できない理由は、式の言葉ではなく入力欄の言葉で伝える。
    #[test]
    fn unusable_panels_are_explained_in_the_words_of_the_form() {
        let coords = |text: &str| PanelInput {
            mode: "coords".to_string(),
            coords: text.to_string(),
            ..example_panel()
        };
        let cases = [
            // 釘が無い / 面材の寸法が入っていない。
            (coords(""), "釘座標が入力されていません"),
            (
                PanelInput {
                    width: 0.0,
                    ..coords("0, 0\n445, 295")
                },
                "面材の幅 W と高さ H に正の数値",
            ),
            // 釘が 1 点に集中している（Ix + Iy = 0）。
            (coords("100, 200"), "1 点に集中している"),
            // 釘が 1 直線上に並ぶ（Zx もしくは Zy が 0 → Zxy = 0）。
            (coords("0, 295\n445, 295"), "1 直線上に並んでいる"),
            // 割り付けの入力が足りない。
            (
                PanelInput {
                    nail_pitch: 0.0,
                    ..example_panel()
                },
                "釘ピッチには正の数値",
            ),
            (
                PanelInput {
                    edge_distance: 400.0,
                    ..example_panel()
                },
                "へりあきが面材の寸法に対して大きすぎます",
            ),
        ];
        for (panel, expected) in cases {
            let error = compute_panel(&panel, 0).unwrap_err();
            assert!(error.contains(expected), "{error} should mention {expected}");
        }
    }

    // --- 壁の計算（グレー本 3.3） -------------------------------------------

    /// グレー本 3.3(3) の計算例（図 3.3.10）を、フォームの入力の形で組み立てる。
    ///
    /// 面材は表 3.2.1 の配列をそのまま割り付けの欄へ入れる。釘 1 本あたりの
    /// 数値は、本文が計算に使っているものをそのまま置く（表 3.3.1 の
    /// N-65 / CN65 の入れ替わりについては wall.rs のコメント）。
    fn wall_example_form() -> FormData {
        let panel = |index: usize, id: &str| {
            let preset = crate::presets::find(id).expect("表 3.2.1 にある配列");
            normalize_panel(&preset.to_panel_value(), "w1", index).unwrap()
        };
        FormData {
            project_name: "グレー本 3.3 の計算例".to_string(),
            issued_on: String::new(),
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
                panels: vec![
                    panel(0, "910x1820-s455-n75-hi"),
                    panel(1, "910x910-s455-n75-ro"),
                ],
            }],
        }
    }

    fn only_wall(data: &FormData) -> Value {
        compute_all_walls(data).as_array().unwrap()[0].clone()
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

    /// 壁の計算には、その根拠である面材ごとの釘配列諸定数が必ず付いてくる。
    #[test]
    fn the_wall_report_carries_the_nail_array_of_every_panel() {
        let report = only_wall(&wall_example_form());
        let panels = report.get("panelReports").unwrap().as_array().unwrap();

        assert_eq!(panels.len(), 2);
        assert_eq!(panels[0].get("ok"), Some(&Value::Bool(true)));
        assert_eq!(
            panels[0].get("panelName").unwrap().as_str(),
            Some("1820×910 縦置・日型（間柱・根太 @455 / 釘 @75）")
        );
        // 3.2 の途中経過と釘配列図が、そのまま壁の計算の中にある。
        assert_eq!(panels[0].get("steps").unwrap().as_array().unwrap().len(), 14);
        assert_eq!(
            panels[0]
                .get("diagram")
                .unwrap()
                .get("panelWidth")
                .unwrap()
                .as_f64(),
            Some(910.0)
        );
        // 壁の表の面材名は、面材ごとの計算と同じ名前で並ぶ。
        let rows = report.get("panels").unwrap().as_array().unwrap();
        assert_eq!(rows[0].get("label"), panels[0].get("panelName"));
    }

    /// 面材ごとの表には、面材の名前と諸定数が並ぶ。
    #[test]
    fn the_wall_report_lists_every_panel_it_is_made_of() {
        let report = only_wall(&wall_example_form());

        assert_eq!(report.get("panelColumns").unwrap().as_array().unwrap().len(), 9);
        let panels = report.get("panels").unwrap().as_array().unwrap();
        assert_eq!(panels.len(), 2);
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
        // 釘の呼び径は、へりあきを決めるときの手がかりとして添える。
        assert!(inputs.contains(&(
            "面材と釘の組合せ".to_string(),
            "構造用合板 12mm + 鉄丸釘 N-65（釘の呼び径 φ3.05 mm）".to_string()
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

    /// 面材が 1 枚も無い壁は、その理由を返す。
    #[test]
    fn a_wall_without_panels_is_explained() {
        let mut data = wall_example_form();
        data.walls[0].panels = Vec::new();
        let report = only_wall(&data);
        assert_eq!(report.get("ok"), Some(&Value::Bool(false)));
        assert!(report
            .get("error")
            .unwrap()
            .as_str()
            .unwrap()
            .contains("面材がありません"));
    }

    /// 計算できない面材があるときは、その面材の名前で伝える。
    /// 壁として計算できなくても、他の面材の釘配列は出せるところまで出す。
    #[test]
    fn a_wall_reports_the_panel_that_cannot_be_calculated() {
        let mut data = wall_example_form();
        data.walls[0].panels[0].panel_name = "南面 下".to_string();
        data.walls[0].panels[0].nail_pitch = 0.0;

        let report = only_wall(&data);
        assert_eq!(report.get("ok"), Some(&Value::Bool(false)));
        let error = report.get("error").unwrap().as_str().unwrap();
        assert!(error.contains("面材「南面 下」"), "{error}");

        let panels = report.get("panelReports").unwrap().as_array().unwrap();
        assert_eq!(panels[0].get("ok"), Some(&Value::Bool(false)));
        assert_eq!(panels[1].get("ok"), Some(&Value::Bool(true)));
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

    #[test]
    fn arrangements_are_offered_as_choices() {
        let choices = arrangements();
        let choices = choices.as_array().unwrap();
        assert_eq!(choices.len(), 4);
        assert_eq!(choices[0].get("id").unwrap().as_str(), Some("kawa"));
        assert_eq!(choices[3].get("label").unwrap().as_str(), Some("日型"));
    }
}
