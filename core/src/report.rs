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
//! 面材と釘の仕様（厚さ・GB・k・δv・δu・ΔPv・τmax・E1・E2）は **面材
//! 1 枚ごとの入力**で、1 枚の壁の中で混在してよい（上半分は N50、下半分は
//! CN50 のような張り分け）。壁が持つのは階高・幅と中間材の有無だけ。
//!
//! 移植元は GAS 版 gas-timber-panel-shear-calculator と、その Python 移植
//! （backend/app/panel_shear.py の計算部分）。

use crate::format::{format_dimension, format_int, significant, SIGNIFICANT_DIGITS};
use crate::json::Value;
use crate::layout::{self, Arrangement, Layout, DEFAULT_EDGE_DISTANCE};
use crate::nail_array::{self, Nail};
use crate::wall;
use crate::wall_layout::{self, Piece, Side};

/// 面材 1 枚あたりの釘の上限。実務の面材 1 枚では 100 本程度なので十分に
/// 余裕がある。桁を間違えた入力（釘ピッチに 1 mm と書くなど）で計算と
/// ページ描画が止まらないようにするための歯止め。
pub const MAX_NAILS: usize = 2000;
/// 1 物件あたりの壁の上限と、壁 1 枚を構成する面材の上限。
pub const MAX_WALLS: usize = 50;
pub const MAX_WALL_PANELS: usize = 20;

/// 釘配列図に添える座標値の有効桁数（図は小さいので本文より粗くする）。
const DIAGRAM_AXIS_DIGITS: usize = 4;

/// 壁を構成する面材 1 枚分の入力（面材と釘の仕様・寸法・釘配列）。
///
/// 面材と釘の仕様は面材ごとに持つ。1 枚の壁でも面材ごとに違う仕様を使う
/// ことがあるため（上半分は N50、下半分は CN50 のような張り分け）。
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
    /// この面材を張る面（"front" 表面 / "back" 裏面）。両面張りの壁を
    /// 配列図で描き分け、重なりの判定も同じ面の中だけで行うために持つ。
    pub side: String,
    /// 壁の中でのこの面材の位置（壁の左下を原点とした、面材の左下）[mm]。
    ///
    /// 計算（3.3）は面材ごとの値の和なので、位置は数値に影響しない。
    /// 「どう張る前提の計算か」を計算書に残し、配置と計算の食い違い
    /// （はみ出し・重なり・配置漏れ）を拾うための任意入力で、未入力は None。
    pub origin_x: Option<f64>,
    pub origin_y: Option<f64>,
}

/// 壁 1 枚分の入力（グレー本 3.3 の面材張り大壁）。
///
/// 面材と釘の仕様は面材ごと（`PanelInput`）なので、壁が持つのは階高・幅と
/// 中間材の有無だけ。
#[derive(Debug, Clone, PartialEq)]
pub struct WallInput {
    pub wall_id: String,
    pub wall_name: String,
    /// 階高 H [mm]。
    pub height: f64,
    /// 壁の幅 W [mm]。
    pub width: f64,
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

    /// この面材そのものの諸元（3.3 の計算に使う値）。
    pub fn sheathing(&self) -> wall::Sheathing {
        wall::Sheathing {
            thickness: self.thickness,
            shear_modulus: self.shear_modulus,
            tau_max: self.tau_max,
            e1: self.e1,
            e2: self.e2,
        }
    }

    /// この面材を張る面（表面 / 裏面）。
    pub fn side(&self) -> Side {
        Side::from_id(&self.side)
    }

    /// 壁の中でのこの面材の左下の位置 [mm]（配置を書いていなければ None）。
    ///
    /// X と Y の片方だけを入れたときは、もう一方を 0 とみなす（壁の左端・
    /// 下端に寄せた面材は、その側の欄が 0 になるため）。
    pub fn origin(&self) -> Option<(f64, f64)> {
        match (self.origin_x, self.origin_y) {
            (None, None) => None,
            (x, y) => Some((x.unwrap_or(0.0), y.unwrap_or(0.0))),
        }
    }

    /// 配列図に並べる 1 枚として見た、この面材。
    pub fn piece(&self, label: String) -> Piece {
        Piece {
            label,
            width: self.width,
            height: self.height,
            side: self.side(),
            origin: self.origin(),
        }
    }

    /// この面材を留める釘 1 本あたりの一面せん断。
    pub fn nail(&self) -> wall::NailShear {
        wall::NailShear {
            k: self.k,
            delta_v: self.delta_v,
            delta_u: self.delta_u,
            delta_pv: self.delta_pv,
        }
    }

    pub fn to_value(&self) -> Value {
        Value::obj([
            ("panelId", self.panel_id.clone().into()),
            ("panelName", self.panel_name.clone().into()),
            ("width", self.width.into()),
            ("height", self.height.into()),
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
            ("mode", self.mode.clone().into()),
            ("arrangement", self.arrangement.clone().into()),
            ("studPitch", self.stud_pitch.into()),
            ("nailPitch", self.nail_pitch.into()),
            ("edgeDistance", self.edge_distance.into()),
            ("gridX", self.grid_x.clone().into()),
            ("gridY", self.grid_y.clone().into()),
            ("coords", self.coords.clone().into()),
            ("grain", self.grain.clone().into()),
            ("side", self.side.clone().into()),
            // 未入力は null で返す（0 と「書いていない」を取り違えないため）。
            ("originX", optional_value(self.origin_x)),
            ("originY", optional_value(self.origin_y)),
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
            ("hasIntermediateStud", self.has_intermediate_stud.into()),
            (
                "panels",
                Value::Arr(self.panels.iter().map(PanelInput::to_value).collect()),
            ),
        ])
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
        // 面材と釘の仕様を壁が持っていた版の入力は、ここで面材へ移し替える。
        panels.push(normalize_panel(&with_wall_spec(panel, item), &wall_id, position)?);
    }

    Ok(WallInput {
        wall_id,
        wall_name: text_of(item.get("wallName")),
        height: float_of(item.get("height"), "階高 H")?,
        width: float_of(item.get("width"), "壁の幅 W")?,
        has_intermediate_stud: matches!(item.get("hasIntermediateStud"), Some(Value::Bool(true))),
        panels,
    })
}

/// 面材と釘の仕様のキー（面材 1 枚ごとの入力。前の版では壁が持っていた）。
const SPEC_KEYS: [&str; 11] = [
    "materialId",
    "thickness",
    "shearModulus",
    "k",
    "deltaV",
    "deltaU",
    "deltaPv",
    "gradeId",
    "tauMax",
    "e1",
    "e2",
];

/// 面材が仕様を持たないときに、その壁が持っている仕様を継がせる。
///
/// 面材と釘の仕様は面材ごとの入力だが、前の版は壁 1 枚に 1 組だけ持っていた。
/// 計算書 PDF が保存形式なので、その版で保存したファイルを開いたときは、
/// 壁の仕様をそのまま全ての面材へ配って今の形にする（壁の中で仕様が混在
/// していなかった、という当時の入力の意味がそのまま保たれる）。
fn with_wall_spec(panel: &Value, wall: &Value) -> Value {
    let missing: Vec<(String, Value)> = SPEC_KEYS
        .iter()
        .filter(|key| is_blank(panel.get(**key)))
        .filter_map(|key| {
            let value = wall.get(*key)?;
            if is_blank(Some(value)) {
                return None;
            }
            Some((key.to_string(), value.clone()))
        })
        .collect();
    if missing.is_empty() {
        return panel.clone();
    }

    let mut entries: Vec<(String, Value)> = match panel {
        Value::Obj(entries) => entries.clone(),
        _ => Vec::new(),
    };
    entries.extend(missing);
    Value::Obj(entries)
}

/// 未入力（欠落・null・空文字）か。
fn is_blank(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::Str(text)) => text.trim().is_empty(),
        _ => false,
    }
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
        material_id: text_of(panel.get("materialId")),
        thickness: float_of(panel.get("thickness"), "面材の厚さ t")?,
        shear_modulus: float_of(panel.get("shearModulus"), "面材のせん断弾性係数 GB")?,
        k: float_of(panel.get("k"), "釘のせん断剛性 k")?,
        delta_v: float_of(panel.get("deltaV"), "釘の降伏点変位 δv")?,
        delta_u: float_of(panel.get("deltaU"), "釘の終局変位 δu")?,
        delta_pv: float_of(panel.get("deltaPv"), "釘の降伏耐力 ΔPv")?,
        grade_id: text_of(panel.get("gradeId")),
        tau_max: float_of(panel.get("tauMax"), "面材のせん断強度 τmax")?,
        e1: float_of(panel.get("e1"), "曲げヤング係数 E1")?,
        e2: float_of(panel.get("e2"), "曲げヤング係数 E2")?,
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
        side: Side::from_id(&text_of(panel.get("side"))).id().to_string(),
        origin_x: optional_float_of(panel.get("originX"), "壁内の位置 X")?,
        origin_y: optional_float_of(panel.get("originY"), "壁内の位置 Y")?,
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

/// 数値として読む。未入力（欠落・null・空文字）は「書いていない」として返す。
///
/// 0 を入れたのか何も書いていないのかを区別する入力欄（壁内の位置）で使う。
fn optional_float_of(value: Option<&Value>, label: &str) -> Result<Option<f64>, String> {
    if is_blank(value) {
        return Ok(None);
    }
    float_of(value, label).map(Some)
}

/// 「書いていない」を null として書き出す。
fn optional_value(value: Option<f64>) -> Value {
    value.map_or(Value::Null, Value::from)
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

/// 面材 1 枚の「壁のどこに張るか」を、そのまま読める 1 行にする。
///
/// 位置は任意入力なので、書いていなければ「書いていない」とはっきり出す
/// （0 と取り違えられないように）。裏面に張ることだけを決めてある面材は、
/// 位置が無くてもその面を残す（両面張りかどうかは読む人に要る情報）。
fn placement_text(panel: &PanelInput) -> String {
    match panel.origin() {
        Some((x, y)) => format!(
            "{}　左下 (X, Y) = ({}, {}) mm",
            panel.side().label(),
            format_dimension(x),
            format_dimension(y)
        ),
        None if panel.side() == Side::Front => "未指定（面材の枚数で計算）".to_string(),
        None => format!("{}（壁内の位置は未指定）", panel.side().label()),
    }
}

/// 壁を構成する面材が、どれも同じ面材と釘の仕様か。
///
/// 同じなら壁の控えに 1 行で書けるし、違えば「面材ごとに異なる」と書いて
/// 面材ごとの表へ誘導する（1 枚の壁に違う仕様を張り分けることがあるため）。
fn uniform_spec(panels: &[PanelInput]) -> bool {
    match panels.split_first() {
        Some((first, rest)) => rest.iter().all(|panel| {
            panel.material_id == first.material_id
                && panel.grade_id == first.grade_id
                && panel.sheathing() == first.sheathing()
                && panel.nail() == first.nail()
        }),
        None => true,
    }
}

/// 面材と釘の組合せ（表 3.3.1）の名前。読み込んでいなければその旨を返す。
fn material_text(panel: &PanelInput) -> String {
    match wall::find_material(&panel.material_id) {
        Some(material) => format!(
            "{}（釘の呼び径 φ{} mm）",
            material.label(),
            format_dimension(material.nail_diameter)
        ),
        None => "表 3.3.1 から読み込まず、数値を直接入力".to_string(),
    }
}

/// 面材 1 枚の「面材と釘」の入力を、そのまま読める行にする。
///
/// 面材ごとに違う仕様を使えるので、どの面材がどの仕様なのかは面材の側に
/// 書いておく（壁の計算のページには、面材ごとの数値を表にして並べる）。
fn spec_rows(panel: &PanelInput) -> Vec<Value> {
    // 面材と釘の数値は打ち込まれた（表 3.3.1 から読み込んだ）ものなので、
    // 有効桁で丸めずそのままの見た目で出す（12 を「12.0000」にしない）。
    let typed = format_dimension;
    let row = |label: &str, value: String| {
        Value::obj([("label", label.into()), ("value", value.into())])
    };

    let mut rows = Vec::with_capacity(6);
    if let Some(material) = wall::find_material(&panel.material_id) {
        rows.push(row(
            "面材と釘の組合せ",
            format!(
                "{}（釘の呼び径 φ{} mm）",
                material.label(),
                format_dimension(material.nail_diameter)
            ),
        ));
    }
    rows.push(row("面材の厚さ t", format!("{} mm", typed(panel.thickness))));
    rows.push(row(
        "面材のせん断弾性係数 GB",
        format!("{} kN/mm²", typed(panel.shear_modulus)),
    ));
    rows.push(row(
        "釘 1 本あたりの一面せん断",
        format!(
            "k = {} kN/mm　δv = {} mm　δu = {} mm　ΔPv = {} kN",
            typed(panel.k),
            typed(panel.delta_v),
            typed(panel.delta_u),
            typed(panel.delta_pv)
        ),
    ));
    if let Some(grade) = wall::find_grade(&panel.grade_id) {
        rows.push(row("面材の規格", grade.label()));
    }
    rows.push(row(
        "面材のせん断強度・曲げヤング係数",
        format!(
            "τmax = {} N/mm²　E1 = {} N/mm²　E2 = {} N/mm²",
            typed(panel.tau_max),
            typed(panel.e1),
            typed(panel.e2)
        ),
    ));
    rows
}

// --- 壁内の面材配列（配列図と、配置・計算の突き合わせ） ----------------------

/// 壁内の面材配列としてまとめたもの（画面・計算書がそのまま並べられる形）。
struct WallLayoutReport {
    /// 壁の入力の控えに出す 1 行。
    summary: String,
    /// 壁の面材配列図（配置が 1 枚も無ければ Null）。
    diagram: Value,
    /// 面材の一覧（面材・張る面・寸法・位置・面積）。配置が無ければ空。
    rows: Vec<Value>,
    /// 判定の 1 行（配置が 1 枚も無ければ None ＝ 判定に出さない）。
    check: Option<Value>,
}

/// 壁内の面材配列を組み立てる。
///
/// 配置は面材ごとの任意入力なので、**1 枚も入っていない壁は今までどおり**
/// 枚数だけで計算する（配列図も判定の行も出さない）。1 枚でも入っていれば、
/// 「この壁をどう張る前提の計算か」を図と表で残し、配置と計算の食い違い
/// （はみ出し・重なり・配置漏れ）を判定に出す。
fn build_wall_layout(input: &WallInput) -> WallLayoutReport {
    let pieces: Vec<Piece> = input
        .panels
        .iter()
        .enumerate()
        .map(|(position, panel)| panel.piece(panel_label(panel, position)))
        .collect();
    let inspection = wall_layout::inspect(input.width, input.height, &pieces);

    if inspection.placed == 0 {
        return WallLayoutReport {
            summary: "未指定（面材の枚数で計算）".to_string(),
            diagram: Value::Null,
            rows: Vec::new(),
            check: None,
        };
    }

    let placement: Vec<String> = inspection
        .sides
        .iter()
        .map(|(side, count, _)| format!("{} {} 枚", side.label(), count))
        .collect();
    let mut summary = format!(
        "壁の面材配列図のとおり（{}{}）",
        placement.join("・"),
        if inspection.sides.len() > 1 {
            " ＝ 両面張り"
        } else {
            ""
        }
    );
    if !inspection.unplaced.is_empty() {
        summary.push_str(&format!(
            "　※ 位置を書いていない面材が {} 枚あります",
            inspection.unplaced.len()
        ));
    }

    WallLayoutReport {
        summary,
        diagram: layout_diagram(input, &pieces, &inspection),
        rows: layout_rows(&pieces, &inspection),
        check: Some(Value::obj([
            ("label", "面材の配置（壁の面材配列図との整合）".into()),
            ("value", layout_check_text(input, &pieces, &inspection).into()),
            ("ok", inspection.ok.into()),
        ])),
    }
}

/// 壁の面材配列図に要る幾何（描画範囲と、面ごとの面材の矩形）。
///
/// 縮尺は画面（SVG）と計算書 PDF がそれぞれ決めるが、「どこからどこまでを
/// 描くか」「どの面材に注意の印を付けるか」はここで決めた 1 つを両方が読む。
///
/// 描画範囲は表面・裏面をまとめた 1 つにする。両面張りの壁は面ごとに枠を
/// 描き分けるが、範囲（＝縮尺）が面ごとに違うと、同じ寸法の面材が表と裏で
/// 違う大きさに見えてしまうため。
fn layout_diagram(
    input: &WallInput,
    pieces: &[Piece],
    inspection: &wall_layout::Inspection,
) -> Value {
    let placed: Vec<Piece> = pieces
        .iter()
        .filter(|piece| piece.origin.is_some())
        .cloned()
        .collect();
    let (min_x, min_y, max_x, max_y) = wall_layout::bounds(input.width, input.height, &placed);

    let sides: Vec<Value> = inspection
        .sides
        .iter()
        .map(|(side, count, area)| {
            let on_side: Vec<(usize, &Piece)> = pieces
                .iter()
                .enumerate()
                .filter(|(_, piece)| piece.side == *side && piece.origin.is_some())
                .collect();
            Value::obj([
                ("id", side.id().into()),
                ("label", side.label().into()),
                ("count", (*count as f64).into()),
                ("area", (*area).into()),
                (
                    "panels",
                    Value::Arr(
                        on_side
                            .iter()
                            .map(|(index, piece)| {
                                let (x, y) = piece.origin.expect("配置のある面材だけを並べる");
                                Value::obj([
                                    ("label", piece.label.clone().into()),
                                    ("x", x.into()),
                                    ("y", y.into()),
                                    ("width", piece.width.into()),
                                    ("height", piece.height.into()),
                                    ("sizeLabel", size_text(piece).into()),
                                    ("note", placement_note(inspection, *index).into()),
                                    (
                                        "ok",
                                        (!inspection.outside[*index]
                                            && !inspection.overlapping[*index])
                                            .into(),
                                    ),
                                ])
                            })
                            .collect(),
                    ),
                ),
            ])
        })
        .collect();

    Value::obj([
        ("wallWidth", input.width.into()),
        ("wallHeight", input.height.into()),
        // 壁枠と、置いた全ての面材の外接矩形。はみ出した面材も切り取らず、
        // はみ出していることが図で見えるようにする。
        ("minX", min_x.into()),
        ("minY", min_y.into()),
        ("maxX", max_x.into()),
        ("maxY", max_y.into()),
        ("sides", Value::Arr(sides)),
        (
            "unplaced",
            Value::Arr(
                inspection
                    .unplaced
                    .iter()
                    .map(|label| label.clone().into())
                    .collect(),
            ),
        ),
    ])
}

/// 面材の寸法の見出し（「910 × 1,820 mm」）。
fn size_text(piece: &Piece) -> String {
    format!(
        "{} × {} mm",
        format_int(piece.width),
        format_int(piece.height)
    )
}

/// この面材の配置に付ける注意（無ければ空文字）。
fn placement_note(inspection: &wall_layout::Inspection, index: usize) -> String {
    match (inspection.outside[index], inspection.overlapping[index]) {
        (true, true) => "はみ出し・重なり".to_string(),
        (true, false) => "はみ出し".to_string(),
        (false, true) => "重なり".to_string(),
        (false, false) => String::new(),
    }
}

/// 面材の一覧（面材・張る面・寸法・左下の位置・面積・配置の判定）。
///
/// 配置を書いていない面材も 1 行として並べる。図に描けない面材が計算には
/// 入っている、という食い違いが表の上でも見えるようにするため。
fn layout_rows(pieces: &[Piece], inspection: &wall_layout::Inspection) -> Vec<Value> {
    pieces
        .iter()
        .enumerate()
        .map(|(index, piece)| {
            let note = placement_note(inspection, index);
            let (position, verdict) = match piece.origin {
                Some((x, y)) => (
                    format!("({}, {})", format_dimension(x), format_dimension(y)),
                    if note.is_empty() { "OK".to_string() } else { note },
                ),
                None => ("-".to_string(), "未指定".to_string()),
            };
            Value::obj([
                ("label", piece.label.clone().into()),
                ("ok", (piece.origin.is_some() && verdict == "OK").into()),
                (
                    "cells",
                    Value::Arr(
                        [
                            piece.side.label().to_string(),
                            size_text(piece),
                            position,
                            format_int(piece.area()),
                            verdict,
                        ]
                        .into_iter()
                        .map(Value::from)
                        .collect(),
                    ),
                ),
            ])
        })
        .collect()
}

/// 配置と計算の食い違いを、そのまま読める文にする。
fn layout_check_text(
    input: &WallInput,
    pieces: &[Piece],
    inspection: &wall_layout::Inspection,
) -> String {
    let names = |labels: &[String]| {
        labels
            .iter()
            .map(|label| format!("「{label}」"))
            .collect::<Vec<_>>()
            .join("")
    };

    let mut problems: Vec<String> = Vec::new();
    let outside: Vec<String> = inspection
        .outside
        .iter()
        .enumerate()
        .filter(|(_, flag)| **flag)
        .map(|(index, _)| pieces[index].label.clone())
        .collect();
    if !outside.is_empty() {
        problems.push(format!(
            "面材{}が壁（{} × {} mm）からはみ出しています",
            names(&outside),
            format_int(input.width),
            format_int(input.height)
        ));
    }
    for (left, right) in &inspection.overlaps {
        problems.push(format!("面材「{left}」と「{right}」が同じ面で重なっています"));
    }
    if !inspection.unplaced.is_empty() {
        problems.push(format!(
            "面材{}の壁内の位置が未指定です（配列図に描けません）",
            names(&inspection.unplaced)
        ));
    }
    if !problems.is_empty() {
        return problems.join("／");
    }

    let wall_area = input.width * input.height;
    let covered: Vec<String> = inspection
        .sides
        .iter()
        .map(|(side, _, area)| {
            format!(
                "{} {} mm²（壁面積の {}%）",
                side.label(),
                format_int(*area),
                format_int(area / wall_area * 100.0)
            )
        })
        .collect();
    format!(
        "はみ出し・重なりなし　張った面積 {}　壁面積 {} × {} = {} mm²",
        covered.join("・"),
        format_int(input.width),
        format_int(input.height),
        format_int(wall_area)
    )
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

    // 釘配列諸定数（3.2）そのものには面材と釘の仕様は要らないが、この面材が
    // 壁の計算（3.3）へ何を持ち込むのかが 1 ページで分かるように控えを添える。
    let mut inputs = vec![
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
            ("label", "壁内の配置".into()),
            ("value", placement_text(panel).into()),
        ]),
        Value::obj([
            ("label", "釘配列".into()),
            ("value", nail_arrangement_text(panel, nails).into()),
        ]),
        Value::obj([
            // 実際に置かれた釘の座標から測る（どの入力方式でも同じ）。
            ("label", "へりあき（面材の縁から釘まで）".into()),
            (
                "value",
                format!(
                    "{} mm",
                    format_dimension(layout::min_edge_clearance(nails, panel.width, panel.height))
                )
                .into(),
            ),
        ]),
        Value::obj([
            ("label", "釘本数 n".into()),
            ("value", format!("{} 本", format_int(result.n as f64)).into()),
        ]),
    ];
    inputs.extend(spec_rows(panel));

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
        ("inputs", Value::Arr(inputs)),
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
    // 適用範囲 3.3(1)④ の検定に使う、面材ごとのへりあき（実測の最小値）。
    let mut clearances = Vec::with_capacity(input.panels.len());
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
        clearances.push(layout::min_edge_clearance(&nails, panel.width, panel.height));
        panel_reports.push(with_ok(build_panel_report(panel, &nails, position)?));
        specs.push(wall::PanelSpec::new(
            &panel_label(panel, position),
            &constants,
            panel.width,
            panel.height,
            wall::Grain::from_id(&panel.grain),
            panel.sheathing(),
            panel.nail(),
        ));
    }

    let result = wall::compute(&wall::Wall {
        height: input.height,
        width: input.width,
        has_intermediate_stud: input.has_intermediate_stud,
        panels: specs,
    })
    .map_err(|error| error.0)?;

    // 壁内の面材配列（配列図・面材の一覧・配置と計算の突き合わせ）。計算その
    // ものには効かないが、「どう張る前提の計算か」を計算書に残し、配置と
    // 計算の食い違いをその場で拾う。
    let arrangement = build_wall_layout(input);

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

    // 適用範囲 3.3(1)④「面材の釘列に対するへりあきは、10mm 以上かつ接合具径
    // d ×5 以上」。d は面材ごとに選んだ釘で決まるので、面材 1 枚ずつ確かめて、
    // いちばん余裕の少ない面材で壁の判定にする。表 3.3.1 から読み込んでいない
    // （4.5 の試験値を直接入力した）面材は、10mm の側だけを確かめる。
    let edges: Vec<(usize, f64, f64)> = input
        .panels
        .iter()
        .enumerate()
        .map(|(position, panel)| {
            let required = match wall::find_material(&panel.material_id) {
                Some(material) => material.min_edge_distance(),
                None => wall::MIN_EDGE_DISTANCE,
            };
            (position, clearances[position], required)
        })
        .collect();
    let (worst_position, worst_edge, required_edge) = edges
        .iter()
        .copied()
        .fold(edges[0], |worst, edge| {
            if edge.1 - edge.2 < worst.1 - worst.2 {
                edge
            } else {
                worst
            }
        });
    let edge_basis = match wall::find_material(&input.panels[worst_position].material_id) {
        Some(material) => format!(
            "10 mm かつ 釘の呼び径 φ{} mm × {} 以上",
            format_dimension(material.nail_diameter),
            format_dimension(wall::EDGE_DISTANCE_DIAMETER_FACTOR)
        ),
        None => "釘の呼び径が分からないため 10 mm のみで確認".to_string(),
    };
    // 表示の桁で切り上がって「足りているのに NG」に見えないよう、丸めの幅だけ
    // 許す（へりあきは mm 単位の入力なので、この幅で判定が変わることはない）。
    let edge_ok = edges
        .iter()
        .all(|(_, clearance, required)| *clearance >= *required - 1e-9);

    let mut inputs = vec![
        row("階高 H", format!("{} mm", format_int(input.height))),
        row("壁の幅 W", format!("{} mm", format_int(input.width))),
    ];
    // 面材と釘は面材ごとの入力なので、壁の控えには「全面材で同じかどうか」を
    // 書き、数値は下の面材ごとの表に並べる（混在した壁でも読み違えない）。
    if uniform_spec(&input.panels) {
        inputs.push(row("面材と釘", material_text(&input.panels[0])));
    } else {
        inputs.push(row(
            "面材と釘",
            "面材ごとに異なる（下の「面材ごとの面材と釘」を参照）".to_string(),
        ));
        for (position, panel) in input.panels.iter().enumerate() {
            if wall::find_material(&panel.material_id).is_some() {
                inputs.push(row(
                    &format!("　面材「{}」", panel_label(panel, position)),
                    material_text(panel),
                ));
            }
        }
    }
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
    inputs.push(row("面材の配置", arrangement.summary.clone()));

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
    // τmax も τcr も面材ごとに違うので、どちらも比でいちばん厳しい面材を採る。
    let worst_shear = worst(|panel| panel.tau_n / panel.spec.sheathing.tau_max);
    let worst_buckling = worst(|panel| panel.tau_n / panel.tau_cr);

    // 判定は、まず「計算した面材の並びが、想定した張り方と合っているか」から
    // 始める（配置を書いていない壁では、この行そのものが出ない）。そのあとに
    // 適用範囲と面材の検定が続く。
    let mut checks: Vec<Value> = Vec::with_capacity(5);
    checks.extend(arrangement.check.clone());
    checks.extend([
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
            ("label", "適用範囲 3.3(1)④ 面材のへりあき".into()),
            (
                "value",
                // 必要なへりあきは面材ごとに選んだ釘で決まるので、
                // いちばん余裕の少ない面材を名前で示す。
                format!(
                    "最小 へりあき {} mm {} {} mm（面材「{}」／ {}）",
                    format_dimension(worst_edge),
                    if edge_ok { "≧" } else { "<" },
                    format_dimension(required_edge),
                    panel_label(&input.panels[worst_position], worst_position),
                    edge_basis
                )
                .into(),
            ),
            ("ok", edge_ok.into()),
        ]),
        Value::obj([
            ("label", "面材のせん断破壊 τN < τmax（3.3.8）".into()),
            (
                "value",
                // どの面材の値かは、上の面材ごとの表で分かる。ここは
                // いちばん余裕の少ない面材の値だけを短く出す（τmax は
                // 面材ごとに違うので、比がいちばん大きい面材を採る）。
                format!(
                    "最大 τN/τmax の面材で τN = {} {} τmax = {} N/mm²",
                    six(worst_shear.tau_n),
                    if result.shear_ok { "<" } else { "≧" },
                    six(worst_shear.spec.sheathing.tau_max)
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
    ]);

    Ok(Value::obj([
        ("wallId", input.wall_id.clone().into()),
        ("wallName", wall_label(input, index).into()),
        ("panelReports", Value::Arr(panel_reports)),
        ("inputs", Value::Arr(inputs)),
        // 壁内の面材配列。図（wallDiagram）と、その凡例になる面材の一覧
        // （layoutColumns / layout）。配置を書いていない壁では図が null・
        // 一覧が空になり、画面も計算書もこの節ごと出さない。
        ("wallDiagram", arrangement.diagram),
        (
            "layoutColumns",
            Value::Arr(
                [
                    "面材",
                    "張る面",
                    "寸法 W × H",
                    "左下 (X, Y) [mm]",
                    "面積 Aw [mm²]",
                    "配置",
                ]
                .into_iter()
                .map(Value::from)
                .collect(),
            ),
        ),
        ("layout", Value::Arr(arrangement.rows)),
        // 面材ごとの面材と釘（面材ごとに違う仕様を張り分けられるので、どの
        // 面材がどの数値で計算されたのかを壁のページにも残す）。
        (
            "specColumns",
            Value::Arr(
                [
                    "面材",
                    "t [mm]",
                    "GB [kN/mm²]",
                    "k [kN/mm]",
                    "δv [mm]",
                    "δu [mm]",
                    "ΔPv [kN]",
                    "τmax [N/mm²]",
                    "E1 [N/mm²]",
                    "E2 [N/mm²]",
                ]
                .into_iter()
                .map(Value::from)
                .collect(),
            ),
        ),
        (
            "specs",
            Value::Arr(
                result
                    .panels
                    .iter()
                    .map(|panel| {
                        let sheathing = panel.spec.sheathing;
                        let nail = panel.spec.nail;
                        Value::obj([
                            ("label", panel.spec.label.clone().into()),
                            (
                                "cells",
                                Value::Arr(
                                    // 打ち込まれた数値をそのままの見た目で並べる。
                                    [
                                        format_dimension(sheathing.thickness),
                                        format_dimension(sheathing.shear_modulus),
                                        format_dimension(nail.k),
                                        format_dimension(nail.delta_v),
                                        format_dimension(nail.delta_u),
                                        format_dimension(nail.delta_pv),
                                        format_dimension(sheathing.tau_max),
                                        format_dimension(sheathing.e1),
                                        format_dimension(sheathing.e2),
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
                                        six(panel.spec.sheathing.tau_max),
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
        ("checks", Value::Arr(checks)),
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
        ("edgeDistanceOk", edge_ok.into()),
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
    ///
    /// 面材と釘は 3.3(3) の計算例と同じ（構造用合板 12mm ＋ 鉄丸釘 N-65）。
    /// 釘配列諸定数（3.2）そのものには効かないが、面材ごとの入力なので
    /// 面材 1 枚を作るたびに付いてくる。
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
            ..example_spec()
        }
    }

    /// 3.3(3) の計算例の面材と釘（表 3.3.1 の構造用合板 12mm ＋ 鉄丸釘 N-65。
    /// N-65 / CN65 の入れ替わりについては wall.rs の TABLE のコメント）。
    fn example_spec() -> PanelInput {
        PanelInput {
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
            ..empty_panel()
        }
    }

    /// 何も入力していない面材（`..` で必要な欄だけを埋めるための土台）。
    fn empty_panel() -> PanelInput {
        normalize_panel(&Value::Null, "w1", 0).expect("空の面材は正規化できる")
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

    /// 面材と釘の仕様も面材ごとに変えられる（1 枚の壁での張り分け）。
    #[test]
    fn the_specification_is_per_panel() {
        let data = normalize(
            r#"{"walls": [{"panels": [
                 {"materialId": "plywood12-n50", "thickness": 12, "k": "0.43"},
                 {"materialId": "plywood12-cn50", "thickness": "9", "k": 0.467}
               ]}]}"#,
        )
        .unwrap();

        let panels = &data.walls[0].panels;
        assert_eq!(panels[0].material_id, "plywood12-n50");
        assert_eq!(panels[0].k, 0.43);
        assert_eq!(panels[1].material_id, "plywood12-cn50");
        assert_eq!(panels[1].thickness, 9.0);
        // 書き出した入力にも、面材ごとの仕様がそのまま残る。
        let stored = panels[1].to_value();
        assert_eq!(stored.get("materialId").unwrap().as_str(), Some("plywood12-cn50"));
        assert_eq!(stored.get("k").unwrap().as_f64(), Some(0.467));
    }

    /// 面材と釘を壁が 1 組だけ持っていた版の入力は、全ての面材へ配る。
    ///
    /// 計算書 PDF が保存形式なので、前の版で保存したファイルを開いたときも
    /// 同じ計算になる（当時は壁の中で仕様が混在しえなかった）。
    #[test]
    fn a_wall_level_specification_moves_onto_every_panel() {
        let data = normalize(
            r#"{"walls": [{"materialId": "plywood12-n65", "thickness": 12,
                           "shearModulus": 0.4, "k": 0.483, "deltaV": 2.3,
                           "deltaU": 17, "deltaPv": 1.13, "gradeId": "plywood-jas1",
                           "tauMax": 3.6, "e1": 3500, "e2": 5500,
                           "panels": [{"width": 910}, {"width": 910, "thickness": 24}]}]}"#,
        )
        .unwrap();

        let panels = &data.walls[0].panels;
        assert_eq!(panels[0].material_id, "plywood12-n65");
        assert_eq!(panels[0].thickness, 12.0);
        assert_eq!(panels[0].tau_max, 3.6);
        assert_eq!(panels[1].k, 0.483);
        // 面材が自分で持っている値は、壁の値で上書きしない。
        assert_eq!(panels[1].thickness, 24.0);
        // 壁の側にはもう仕様を残さない（今の形は面材ごとの入力だけ）。
        let stored = data.walls[0].to_value();
        assert_eq!(stored.get("thickness"), None);
        assert_eq!(stored.get("materialId"), None);
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

    /// 面材と釘は面材ごとの入力なので、その控えも面材ごとの計算に付く
    /// （どの面材がどの仕様で壁の計算に入ったのかが 1 ページで分かる）。
    #[test]
    fn the_inputs_section_carries_the_specification_of_this_panel() {
        let report = compute_panel(&example_panel(), 0).unwrap();
        let inputs = labelled(&report, "inputs", "label");

        assert!(inputs.contains(&(
            "面材と釘の組合せ".to_string(),
            "構造用合板 12mm + 鉄丸釘 N-65（釘の呼び径 φ3.05 mm）".to_string()
        )));
        // 打ち込んだ数値は、有効桁で丸めずそのままの見た目で出す。
        assert!(inputs.contains(&("面材の厚さ t".to_string(), "12 mm".to_string())));
        assert!(inputs.contains(&(
            "面材の規格".to_string(),
            "構造用合板 JAS 1 級".to_string()
        )));
        let nail = inputs
            .iter()
            .find(|(label, _)| label == "釘 1 本あたりの一面せん断")
            .map(|(_, value)| value.clone())
            .unwrap();
        assert!(nail.contains("k = 0.483 kN/mm"), "{nail}");
        assert!(nail.contains("ΔPv = 1.13 kN"), "{nail}");

        // 表 3.3.1 から読み込んでいない面材は、名前の行が出ない（数値だけ）。
        let typed = compute_panel(
            &PanelInput {
                material_id: String::new(),
                grade_id: String::new(),
                ..example_panel()
            },
            0,
        )
        .unwrap();
        let labels: Vec<String> = labelled(&typed, "inputs", "label")
            .into_iter()
            .map(|(label, _)| label)
            .collect();
        assert!(!labels.contains(&"面材と釘の組合せ".to_string()), "{labels:?}");
        assert!(labels.contains(&"面材の厚さ t".to_string()), "{labels:?}");
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
    /// 面材は表 3.2.1 の配列をそのまま割り付けの欄へ入れ、面材と釘は
    /// 2 枚とも計算例の組合せにする（本文が計算に使っている数値。表 3.3.1 の
    /// N-65 / CN65 の入れ替わりについては wall.rs のコメント）。
    fn wall_example_form() -> FormData {
        FormData {
            project_name: "グレー本 3.3 の計算例".to_string(),
            issued_on: String::new(),
            walls: vec![WallInput {
                wall_id: "w1".to_string(),
                wall_name: "計算例の大壁".to_string(),
                height: 3000.0,
                width: 910.0,
                has_intermediate_stud: true,
                panels: vec![
                    example_preset_panel(0, "910x1820-s455-n75-hi"),
                    example_preset_panel(1, "910x910-s455-n75-ro"),
                ],
            }],
        }
    }

    /// 表 3.2.1 の配列に、計算例の面材と釘を組み合わせた面材 1 枚。
    fn example_preset_panel(index: usize, id: &str) -> PanelInput {
        let preset = crate::presets::find(id).expect("表 3.2.1 にある配列");
        let layout = normalize_panel(&preset.to_panel_value(), "w1", index).unwrap();
        PanelInput {
            panel_id: layout.panel_id,
            panel_name: layout.panel_name,
            width: layout.width,
            height: layout.height,
            mode: layout.mode,
            arrangement: layout.arrangement,
            stud_pitch: layout.stud_pitch,
            nail_pitch: layout.nail_pitch,
            edge_distance: layout.edge_distance,
            grid_x: layout.grid_x,
            grid_y: layout.grid_y,
            coords: layout.coords,
            grain: layout.grain,
            ..example_spec()
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

    /// 入力欄の控えには、階高・壁幅・中間材と、面材と釘が共通かどうかが並ぶ。
    #[test]
    fn the_wall_inputs_section_repeats_what_was_typed() {
        let inputs = labelled(&only_wall(&wall_example_form()), "inputs", "label");

        assert!(inputs.contains(&("階高 H".to_string(), "3,000 mm".to_string())));
        assert!(inputs.contains(&("壁の幅 W".to_string(), "910 mm".to_string())));
        // 面材と釘は面材ごとの入力。全ての面材で同じなら 1 行で書く
        //（釘の呼び径は、へりあきを決めるときの手がかりとして添える）。
        assert!(inputs.contains(&(
            "面材と釘".to_string(),
            "構造用合板 12mm + 鉄丸釘 N-65（釘の呼び径 φ3.05 mm）".to_string()
        )));
        assert!(inputs.contains(&(
            "中間材（間柱等）".to_string(),
            "あり（せん断座屈の ξ = 2）".to_string()
        )));
        assert!(inputs.contains(&("面材の枚数".to_string(), "2 枚".to_string())));
    }

    /// 面材と釘の仕様は面材ごとなので、数値は面材ごとの表に並ぶ。
    #[test]
    fn the_wall_report_lists_the_specification_of_every_panel() {
        let report = only_wall(&wall_example_form());

        let columns = report.get("specColumns").unwrap().as_array().unwrap();
        assert_eq!(columns.len(), 10);
        assert_eq!(columns[0].as_str(), Some("面材"));
        assert_eq!(columns[1].as_str(), Some("t [mm]"));

        let specs = report.get("specs").unwrap().as_array().unwrap();
        assert_eq!(specs.len(), 2);
        let cells = specs[0].get("cells").unwrap().as_array().unwrap();
        // t・GB・k・δv・δu・ΔPv・τmax・E1・E2 の 9 つ（見出しの 10 列 − 面材名）。
        assert_eq!(cells.len(), 9);
        assert_eq!(cells[0].as_str(), Some("12"));
        assert_eq!(cells[2].as_str(), Some("0.483"));
        assert_eq!(cells[6].as_str(), Some("3.6"));
        assert_eq!(cells[7].as_str(), Some("3,500"));
        // 表の面材名は、面材ごとの計算と同じ名前で並ぶ。
        assert_eq!(
            specs[0].get("label"),
            report.get("panels").unwrap().as_array().unwrap()[0].get("label")
        );
    }

    /// 1 枚の壁でも、面材ごとに違う面材と釘を張り分けられる
    /// （上半分は N-50、下半分は CN-50 のような使い方）。
    ///
    /// 面材ごとの計算は、その面材の仕様だけで決まる（隣の面材の仕様に
    /// 引きずられない）ことを、仕様をそろえた壁と突き合わせて確かめる。
    #[test]
    fn a_wall_can_mix_the_specification_of_its_panels() {
        let with_material = |id: &str| {
            let material = wall::find_material(id).expect("表 3.3.1 にある組合せ");
            let sheathing = material.sheathing();
            move |panel: &PanelInput| PanelInput {
                material_id: material.id.to_string(),
                thickness: material.thickness,
                shear_modulus: material.shear_modulus,
                k: material.nail.k,
                delta_v: material.nail.delta_v,
                delta_u: material.nail.delta_u,
                delta_pv: material.nail.delta_pv,
                grade_id: material.grade_id.to_string(),
                tau_max: sheathing.tau_max,
                e1: sheathing.e1,
                e2: sheathing.e2,
                ..panel.clone()
            }
        };
        let n50 = with_material("plywood12-n50");
        let cn50 = with_material("plywood12-cn50");

        let wall_of = |panels: Vec<PanelInput>| {
            let mut data = wall_example_form();
            data.walls[0].panels = panels;
            only_wall(&data)
        };
        let panels = wall_example_form().walls[0].panels.clone();
        let mixed = wall_of(vec![n50(&panels[0]), cn50(&panels[1])]);
        let all_n50 = wall_of(vec![n50(&panels[0]), n50(&panels[1])]);
        let all_cn50 = wall_of(vec![cn50(&panels[0]), cn50(&panels[1])]);

        assert_eq!(mixed.get("ok"), Some(&Value::Bool(true)));
        let k0 = |report: &Value, index: usize| {
            report.get("panels").unwrap().as_array().unwrap()[index]
                .get("cells")
                .unwrap()
                .as_array()
                .unwrap()[4]
                .as_str()
                .unwrap()
                .to_string()
        };
        assert_eq!(k0(&mixed, 0), k0(&all_n50, 0));
        assert_eq!(k0(&mixed, 1), k0(&all_cn50, 1));
        assert_ne!(k0(&all_n50, 1), k0(&all_cn50, 1));

        // 混在しているときは、壁の控えが面材ごとの表と面材の名前で案内する。
        let inputs = labelled(&mixed, "inputs", "label");
        let (_, summary) = inputs
            .iter()
            .find(|(label, _)| label == "面材と釘")
            .expect("面材と釘の行");
        assert!(summary.contains("面材ごとに異なる"), "{summary}");
        assert!(
            inputs.iter().any(|(label, value)| label.contains("面材「")
                && value.contains("太め鉄丸釘(CN 釘)50")),
            "{inputs:?}"
        );
    }

    /// 3.3(1)④ のへりあき（10mm 以上かつ釘の呼び径 ×5 以上）を検定する。
    ///
    /// 計算例の釘は N-65（呼び径 φ3.05）なので、必要なへりあきは 15.25 mm。
    /// 表 3.2.1 の配列が前提とする 10 mm のままだと足りない。
    #[test]
    fn the_wall_report_checks_the_edge_distance_against_the_nail_diameter() {
        let data = wall_example_form();
        let report = only_wall(&data);

        assert_eq!(report.get("edgeDistanceOk"), Some(&Value::Bool(false)));
        let check = report
            .get("checks")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .find(|check| check.get("label").unwrap().as_str().unwrap().contains("へりあき"))
            .unwrap()
            .clone();
        let value = check.get("value").unwrap().as_str().unwrap();
        assert!(value.contains("最小 へりあき 10 mm < 15.25 mm"), "{value}");
        assert!(value.contains("φ3.05 mm × 5 以上"), "{value}");

        // へりあきを必要な値まで広げれば通る。
        let mut widened = data;
        for panel in &mut widened.walls[0].panels {
            panel.edge_distance = 15.25;
        }
        let report = only_wall(&widened);
        assert_eq!(report.get("edgeDistanceOk"), Some(&Value::Bool(true)));
    }

    /// 必要なへりあきは面材ごとの釘で決まるので、いちばん余裕の少ない面材で
    /// 壁の判定にし、その面材の名前を添える。
    #[test]
    fn the_edge_distance_check_names_the_panel_with_the_least_margin() {
        let mut data = wall_example_form();
        {
            let panels = &mut data.walls[0].panels;
            // 太い釘（CN75、呼び径 φ3.76 → 18.8 mm 必要）を上段だけに使う。
            panels[0].edge_distance = 20.0;
            panels[1].panel_name = "上段".to_string();
            panels[1].edge_distance = 16.0;
            panels[1].material_id = "plywood24-cn75".to_string();
        }
        let report = only_wall(&data);

        assert_eq!(report.get("edgeDistanceOk"), Some(&Value::Bool(false)));
        let value = labelled(&report, "checks", "label")
            .into_iter()
            .find(|(label, _)| label.contains("へりあき"))
            .map(|(_, value)| value)
            .unwrap();
        assert!(value.contains("最小 へりあき 16 mm < 18.8 mm"), "{value}");
        assert!(value.contains("面材「上段」"), "{value}");
        assert!(value.contains("φ3.76 mm × 5 以上"), "{value}");
    }

    /// 面材と釘を表 3.3.1 から読み込んでいない（4.5 の試験値を直接入力した）
    /// ときは、呼び径が分からないので 10mm の側だけを確かめる。
    #[test]
    fn the_edge_distance_falls_back_to_ten_millimetres_without_a_material() {
        let mut data = wall_example_form();
        for panel in &mut data.walls[0].panels {
            panel.material_id = String::new();
        }
        let report = only_wall(&data);

        assert_eq!(report.get("edgeDistanceOk"), Some(&Value::Bool(true)));
        let checks = report.get("checks").unwrap().as_array().unwrap();
        let value = checks
            .iter()
            .find(|check| check.get("label").unwrap().as_str().unwrap().contains("へりあき"))
            .unwrap()
            .get("value")
            .unwrap()
            .as_str()
            .unwrap()
            .to_string();
        assert!(value.contains("呼び径が分からないため"), "{value}");
    }

    /// へりあきは、割り付け・格子・座標のどの入力方式でも釘の座標から測る。
    #[test]
    fn the_edge_clearance_is_reported_for_every_input_mode() {
        let coords = PanelInput {
            mode: "coords".to_string(),
            coords: "12, 12\n898, 12\n12, 598\n898, 598".to_string(),
            ..example_panel()
        };
        let report = compute_panel(&coords, 0).unwrap();
        let inputs = labelled(&report, "inputs", "label");
        assert!(inputs.contains(&(
            "へりあき（面材の縁から釘まで）".to_string(),
            "12 mm".to_string()
        )));
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

    // --- 壁内の面材配列（配列図と、配置・計算の突き合わせ） ------------------

    /// グレー本 3.3(3) の計算例を、実際の張り方（下から 1820、その上に 910）
    /// として配置した壁。
    fn placed_wall_example() -> FormData {
        let mut data = wall_example_form();
        {
            let panels = &mut data.walls[0].panels;
            panels[0].panel_name = "下段".to_string();
            panels[0].origin_x = Some(0.0);
            panels[0].origin_y = Some(0.0);
            panels[1].panel_name = "上段".to_string();
            panels[1].origin_x = Some(0.0);
            panels[1].origin_y = Some(1820.0);
        }
        data
    }

    fn layout_check(report: &Value) -> (String, bool) {
        report
            .get("checks")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .find(|check| {
                check
                    .get("label")
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .contains("面材の配置")
            })
            .map(|check| {
                (
                    check.get("value").unwrap().as_str().unwrap().to_string(),
                    check.get("ok") == Some(&Value::Bool(true)),
                )
            })
            .expect("配置の判定")
    }

    /// 配置を書かない壁は、今までどおり枚数だけで計算する（図も判定も出ない）。
    #[test]
    fn a_wall_without_positions_keeps_counting_panels_only() {
        let report = only_wall(&wall_example_form());

        assert_eq!(report.get("wallDiagram"), Some(&Value::Null));
        assert!(report.get("layout").unwrap().as_array().unwrap().is_empty());
        assert!(!labelled(&report, "checks", "label")
            .iter()
            .any(|(label, _)| label.contains("面材の配置")));
        // 控えには「書いていない」ことをはっきり出す。
        assert!(labelled(&report, "inputs", "label").contains(&(
            "面材の配置".to_string(),
            "未指定（面材の枚数で計算）".to_string()
        )));
    }

    /// 配置を書いた壁には、壁の面材配列図と面材の一覧が付く。
    #[test]
    fn a_placed_wall_carries_the_arrangement_drawing() {
        let report = only_wall(&placed_wall_example());

        let diagram = report.get("wallDiagram").unwrap();
        assert_eq!(diagram.get("wallWidth").unwrap().as_f64(), Some(910.0));
        assert_eq!(diagram.get("wallHeight").unwrap().as_f64(), Some(3000.0));
        // 片面張りなので、描く面は 1 つだけ。
        let sides = diagram.get("sides").unwrap().as_array().unwrap();
        assert_eq!(sides.len(), 1);
        assert_eq!(sides[0].get("label").unwrap().as_str(), Some("表面"));
        // 範囲は壁そのもの（面材はどれも壁の中に収まっている）。
        assert_eq!(diagram.get("maxY").unwrap().as_f64(), Some(3000.0));

        let panels = sides[0].get("panels").unwrap().as_array().unwrap();
        assert_eq!(panels.len(), 2);
        assert_eq!(panels[1].get("label").unwrap().as_str(), Some("上段"));
        assert_eq!(panels[1].get("y").unwrap().as_f64(), Some(1820.0));
        assert_eq!(
            panels[1].get("sizeLabel").unwrap().as_str(),
            Some("910 × 910 mm")
        );
        assert_eq!(panels[1].get("ok"), Some(&Value::Bool(true)));

        // 図の凡例になる面材の一覧。
        assert_eq!(
            report.get("layoutColumns").unwrap().as_array().unwrap().len(),
            6
        );
        let rows = report.get("layout").unwrap().as_array().unwrap();
        assert_eq!(rows.len(), 2);
        let cells = rows[1].get("cells").unwrap().as_array().unwrap();
        assert_eq!(cells[0].as_str(), Some("表面"));
        assert_eq!(cells[2].as_str(), Some("(0, 1,820)"));
        assert_eq!(cells[4].as_str(), Some("OK"));

        // 控えと判定にも、想定した張り方が出る。
        assert!(labelled(&report, "inputs", "label").contains(&(
            "面材の配置".to_string(),
            "壁の面材配列図のとおり（表面 2 枚）".to_string()
        )));
        let (value, ok) = layout_check(&report);
        assert!(ok, "{value}");
        assert!(value.contains("はみ出し・重なりなし"), "{value}");
        // 張り残し（準耐力壁形式なので、上に 270 mm 残る）も読み取れる。
        assert!(value.contains("2,484,300 mm²（壁面積の 91%）"), "{value}");
        assert!(value.contains("壁面積 910 × 3,000 = 2,730,000 mm²"), "{value}");
    }

    /// 面材 1 枚ごとの計算にも、その面材を壁のどこに張るかを残す。
    #[test]
    fn every_panel_repeats_where_it_is_placed() {
        let report = only_wall(&placed_wall_example());
        let panels = report.get("panelReports").unwrap().as_array().unwrap();

        assert!(labelled(&panels[1], "inputs", "label").contains(&(
            "壁内の配置".to_string(),
            "表面　左下 (X, Y) = (0, 1,820) mm".to_string()
        )));
    }

    /// 壁に収まらない面材は、図でも判定でも「はみ出し」として出す。
    #[test]
    fn a_panel_outside_the_wall_is_reported() {
        let mut data = placed_wall_example();
        data.walls[0].panels[1].origin_y = Some(2500.0); // 2500 + 910 > 3000

        let report = only_wall(&data);

        let (value, ok) = layout_check(&report);
        assert!(!ok, "{value}");
        assert!(
            value.contains("面材「上段」が壁（910 × 3,000 mm）からはみ出しています"),
            "{value}"
        );
        // 図は切り取らず、はみ出したまま描けるようにする。
        let diagram = report.get("wallDiagram").unwrap();
        assert_eq!(diagram.get("maxY").unwrap().as_f64(), Some(3410.0));
        let side = &diagram.get("sides").unwrap().as_array().unwrap()[0];
        let panels = side.get("panels").unwrap().as_array().unwrap();
        assert_eq!(panels[1].get("ok"), Some(&Value::Bool(false)));
        assert_eq!(panels[1].get("note").unwrap().as_str(), Some("はみ出し"));
        // 一覧の判定の欄にも同じ言葉が並ぶ。
        let rows = report.get("layout").unwrap().as_array().unwrap();
        assert_eq!(
            rows[1].get("cells").unwrap().as_array().unwrap()[4].as_str(),
            Some("はみ出し")
        );
    }

    /// 同じ面で重なる配置は、枚数を二重に数えている印なので NG にする。
    #[test]
    fn panels_overlapping_on_the_same_side_are_reported() {
        let mut data = placed_wall_example();
        data.walls[0].panels[1].origin_y = Some(1000.0);

        let (value, ok) = layout_check(&only_wall(&data));

        assert!(!ok, "{value}");
        assert!(
            value.contains("面材「下段」と「上段」が同じ面で重なっています"),
            "{value}"
        );
    }

    /// 両面張り（表と裏の同じ場所）は重なりではなく、面ごとに描き分ける。
    #[test]
    fn both_sides_of_a_wall_are_drawn_separately() {
        let mut data = placed_wall_example();
        let back: Vec<PanelInput> = data.walls[0]
            .panels
            .iter()
            .enumerate()
            .map(|(index, panel)| PanelInput {
                panel_id: format!("w1-b{index}"),
                panel_name: format!("裏 {}", panel.panel_name),
                side: "back".to_string(),
                ..panel.clone()
            })
            .collect();
        data.walls[0].panels.extend(back);

        let report = only_wall(&data);

        let (value, ok) = layout_check(&report);
        assert!(ok, "{value}");
        let sides = report
            .get("wallDiagram")
            .unwrap()
            .get("sides")
            .unwrap()
            .as_array()
            .unwrap()
            .to_vec();
        assert_eq!(sides.len(), 2);
        assert_eq!(sides[1].get("label").unwrap().as_str(), Some("裏面"));
        assert_eq!(sides[1].get("count").unwrap().as_f64(), Some(2.0));
        assert!(labelled(&report, "inputs", "label").contains(&(
            "面材の配置".to_string(),
            "壁の面材配列図のとおり（表面 2 枚・裏面 2 枚 ＝ 両面張り）".to_string()
        )));
    }

    /// 配置を書いた面材と書いていない面材が混ざると、図が計算より少なくなる。
    #[test]
    fn a_panel_left_out_of_the_arrangement_is_reported() {
        let mut data = placed_wall_example();
        data.walls[0].panels[1].origin_x = None;
        data.walls[0].panels[1].origin_y = None;

        let report = only_wall(&data);

        let (value, ok) = layout_check(&report);
        assert!(!ok, "{value}");
        assert!(value.contains("面材「上段」の壁内の位置が未指定です"), "{value}");
        // 一覧には、図に描けない面材も 1 行として残る。
        let rows = report.get("layout").unwrap().as_array().unwrap();
        assert_eq!(rows.len(), 2);
        let cells = rows[1].get("cells").unwrap().as_array().unwrap();
        assert_eq!(cells[2].as_str(), Some("-"));
        assert_eq!(cells[4].as_str(), Some("未指定"));
        assert!(labelled(&report, "inputs", "label").iter().any(
            |(label, value)| label == "面材の配置" && value.contains("位置を書いていない面材が 1 枚")
        ));
    }

    /// X と Y の片方だけを入れたら、もう一方は壁の端（0）とみなす。
    #[test]
    fn a_single_coordinate_places_the_panel_against_the_edge() {
        let mut data = placed_wall_example();
        data.walls[0].panels[1].origin_x = None;

        let report = only_wall(&data);

        let (value, ok) = layout_check(&report);
        assert!(ok, "{value}");
        let rows = report.get("layout").unwrap().as_array().unwrap();
        assert_eq!(
            rows[1].get("cells").unwrap().as_array().unwrap()[2].as_str(),
            Some("(0, 1,820)")
        );
    }

    /// 配置は保存する入力にそのまま残る（0 と「書いていない」を混ぜない）。
    #[test]
    fn the_position_is_stored_as_typed() {
        let data = normalize(
            r#"{"walls": [{"panels": [
                 {"side": "back", "originX": 0, "originY": "1820"},
                 {"originX": "", "originY": null}
               ]}]}"#,
        )
        .unwrap();

        let panels = &data.walls[0].panels;
        assert_eq!(panels[0].origin(), Some((0.0, 1820.0)));
        assert_eq!(panels[0].side, "back");
        assert_eq!(panels[1].origin(), None);
        assert_eq!(panels[1].side, "front");

        let stored = panels[0].to_value();
        assert_eq!(stored.get("originX").unwrap().as_f64(), Some(0.0));
        assert_eq!(stored.get("side").unwrap().as_str(), Some("back"));
        // 書いていない欄は null のまま（読み戻しても 0 にならない）。
        assert_eq!(panels[1].to_value().get("originX"), Some(&Value::Null));
    }

    #[test]
    fn a_non_numeric_position_is_refused() {
        let error = normalize(r#"{"walls": [{"panels": [{"originY": "上のほう"}]}]}"#).unwrap_err();
        assert!(error.contains("壁内の位置 Y"), "{error}");
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
