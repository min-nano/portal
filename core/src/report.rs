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
//! CN50 のような張り分け）。壁が持つのは、面材を張る**軸組**（階高・幅・
//! 間柱ピッチと、軸組材の見付け幅）だけ。軸組材の見付け幅からは、釘が刺さる
//! 材の縁端距離（適用範囲 3.3(1)④ の軸材側）が決まる。
//!
//! 移植元は GAS 版 gas-timber-panel-shear-calculator と、その Python 移植
//! （backend/app/panel_shear.py の計算部分）。

use crate::format::{format_dimension, format_int, significant, SIGNIFICANT_DIGITS};
use crate::frame::{self, Frame};
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

/// 間柱・根太ピッチの既定値 [mm]（尺モジュール）。
pub const DEFAULT_STUD_PITCH: f64 = 455.0;

/// 釘配列図に添える座標値の有効桁数（図は小さいので本文より粗くする）。
const DIAGRAM_AXIS_DIGITS: usize = 4;

/// 壁を構成する面材 1 枚分の入力。
///
/// **面材は「壁の中で占める領域」で表す**。左下 (left, bottom) と右上
/// (right, top) を壁の左下を原点として入れると、面材の寸法 W・H も面積 Aw も
/// そこから決まる。実際の設計でも決めているのは「どの面材を壁のどこに張るか」
/// なので、寸法を別に入力させない（入力と図が食い違いようがない）。
///
/// **釘配列も配置から決まる**。釘を打つ線は
///
///   - 縦線: 面材の左右の縁と、その面材にかかる間柱（壁の左端から等間隔）
///   - 横線: 面材の上下の縁（面材張り大壁は適用範囲 3.3(1)⑤ で四周打ち）
///
/// なので、壁の間柱ピッチと面材の占有領域が分かれば釘座標が組み立てられる。
/// 面材ごとに残る釘の入力は、釘ピッチとへりあきだけ。
///
/// 面材と釘の仕様は面材ごとに持つ。1 枚の壁でも面材ごとに違う仕様を使う
/// ことがあるため（上半分は N50、下半分は CN50 のような張り分け）。
#[derive(Debug, Clone, PartialEq)]
pub struct PanelInput {
    pub panel_id: String,
    pub panel_name: String,
    /// この面材を張る面（"front" 表面 / "back" 裏面）。両面張りの壁を
    /// 配列図で描き分け、重なりの判定も同じ面の中だけで行うために持つ。
    pub side: String,
    /// 壁の中でこの面材が占める領域 [mm]（壁の左下が原点）。
    ///
    /// left < right・bottom < top であることが、この面材を計算できる条件。
    /// 面材の寸法 W = right − left、H = top − bottom はここから決まる。
    pub left: f64,
    pub bottom: f64,
    pub right: f64,
    pub top: f64,
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
    /// 釘ピッチ [mm]。
    pub nail_pitch: f64,
    /// へりあき（面材の縁から釘の中心までの距離）[mm]。
    ///
    /// 面材の種類・釘の呼び径に合わせて面材ごとに決められる（未入力なら
    /// 既定の 10 mm）。
    pub edge_distance: f64,
    /// 面材の繊維方向（"" は長辺方向）。せん断座屈の a・b の取り方を決める。
    pub grain: String,
}

/// 壁 1 枚分の入力（グレー本 3.3 の面材張り大壁）。
///
/// 壁は**面材を張る軸組**として持つ: 階高・幅と、間柱ピッチ。面材の釘配列は
/// この軸組と面材の占有領域から決まるので、間柱ピッチは面材ごとではなく壁の
/// 入力になる（1 枚の壁の中で間柱の間隔が面材ごとに変わることはない）。
///
/// 面材と釘の仕様は面材ごと（`PanelInput`）。
#[derive(Debug, Clone, PartialEq)]
pub struct WallInput {
    pub wall_id: String,
    pub wall_name: String,
    /// 階高 H [mm]。
    pub height: f64,
    /// 壁の幅 W [mm]。
    pub width: f64,
    /// 軸組材（柱・間柱・横架材・受け材）。1 本ずつ自由な位置に入れる。
    ///
    /// 釘の縦列の位置（面材の内側を通る縦材）も、せん断座屈の ξ（中間材の
    /// 有無）も、適用範囲 3.3(1)④ の軸材の縁端距離も、ここから決まる。
    pub frame: Frame,
    /// 壁を構成する面材。
    pub panels: Vec<PanelInput>,
}

impl WallInput {
    /// 中間材（間柱等）があるか。せん断座屈の ξ になる（式 3.3.11e の下）。
    ///
    /// 「間柱を設けるかどうか」を別の入力にすると、軸組材と食い違ったまま
    /// 計算できてしまう（釘は間柱に打っているのに ξ = 1、など）。壁の幅の
    /// 内側に縦材が 1 本でも立つかどうかで決める。
    pub fn has_intermediate_stud(&self) -> bool {
        self.frame.has_intermediate_stud(self.width)
    }
}

/// フォーム全体の入力（1 ファイル = 1 物件）。
#[derive(Debug, Clone, PartialEq)]
pub struct FormData {
    pub project_name: String,
    pub issued_on: String,
    pub walls: Vec<WallInput>,
}

impl PanelInput {
    /// 面材の幅 W [mm]（占有領域の横の長さ）。
    pub fn width(&self) -> f64 {
        self.right - self.left
    }

    /// 面材の高さ H [mm]（占有領域の縦の長さ）。
    pub fn height(&self) -> f64 {
        self.top - self.bottom
    }

    pub fn panel_area(&self) -> f64 {
        self.width() * self.height()
    }

    /// 壁の軸組材と、この面材の占有領域から決まる釘の割り付け。
    ///
    /// 面材張り大壁は適用範囲 3.3(1)⑤ で面材の四周を釘打ちすると定められて
    /// いるので、型は常に日型（四周打ち）。中間の縦線は、この面材の内側を
    /// 通る縦材の位置に入る（軸組材は 1 本ずつ自由な位置に入れるので、
    /// 等間隔とは限らない）。
    pub fn layout(&self, frame: &Frame) -> Layout {
        Layout {
            width: self.width(),
            height: self.height(),
            // 壁の座標で拾った縦材を、面材の左下を原点とした位置へ直す。
            studs: frame
                .studs_between(self.left, self.right)
                .into_iter()
                .map(|position| position - self.left)
                .collect(),
            nail_pitch: self.nail_pitch,
            edge_distance: self.edge_distance,
            arrangement: Arrangement::Hi,
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

    /// 配列図に並べる 1 枚として見た、この面材。
    pub fn piece(&self, label: String) -> Piece {
        Piece {
            label,
            width: self.width(),
            height: self.height(),
            side: self.side(),
            origin: (self.left, self.bottom),
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
            ("side", self.side.clone().into()),
            // 面材は壁の中で占める領域そのもの（寸法はここから決まる）。
            ("left", self.left.into()),
            ("bottom", self.bottom.into()),
            ("right", self.right.into()),
            ("top", self.top.into()),
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
            ("nailPitch", self.nail_pitch.into()),
            ("edgeDistance", self.edge_distance.into()),
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
            ("frame", self.frame.to_value()),
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
    // 面材ごとに寸法・型・間柱ピッチを持っていた版の入力は、ここで
    // 「壁の軸組 ＋ 面材の占有領域」へ移し替える。
    let raw_panels = placed_panels(raw_panels);
    let mut panels = Vec::with_capacity(raw_panels.len());
    for (position, panel) in raw_panels.iter().enumerate() {
        // 面材と釘の仕様を壁が持っていた版の入力は、ここで面材へ移し替える。
        panels.push(normalize_panel(&with_wall_spec(panel, item), &wall_id, position)?);
    }

    // 軸組材を持たない版の入力を読み替えるのに、壁の寸法が要る（両端の柱と
    // 上下の横架材は、壁の幅・階高の位置に立つ）。
    let height = float_of(item.get("height"), "階高 H")?;
    let width = float_of(item.get("width"), "壁の幅 W")?;

    Ok(WallInput {
        wall_id,
        wall_name: text_of(item.get("wallName")),
        height,
        width,
        frame: wall_frame(item, &raw_panels, width, height)?,
        panels,
    })
}

/// 壁の軸組材（柱・間柱・横架材・受け材）。
///
/// 一覧が入っていればそれを読む。軸組材を持たない前の版の入力（間柱ピッチ
/// だけを持っていた形）は、当時の前提をそのまま形にして読み替える:
///
///   - 壁の両端に柱、その間に間柱をピッチで等間隔（`from_stud_pitch`）
///   - 壁の上下に横架材
///   - 面材の継目（壁の内側に来る面材の縁）に継目の材
///
/// 当時は「面材の継目には材がある」ものとして計算していたので、そこまで
/// 含めて読み替えると、開き直したときの判定が前の版と変わらない。実際の
/// 納まりに合わせて、開いたあとに 1 本ずつ直せる。
fn wall_frame(
    wall: &Value,
    panels: &[Value],
    width: f64,
    height: f64,
) -> Result<Frame, String> {
    if let Some(Value::Arr(items)) = wall.get("frame") {
        if items.len() > frame::MAX_MEMBERS {
            return Err(format!(
                "1 枚の壁に入れられる軸組材は {} 本までです。",
                frame::MAX_MEMBERS
            ));
        }
        let mut members = Vec::with_capacity(items.len());
        for item in items {
            members.push(normalize_member(item)?);
        }
        return Ok(Frame::new(members));
    }

    let mut migrated = Frame::from_stud_pitch(width, height, wall_stud_pitch(wall, panels)?);
    for panel in panels {
        let edge = |key: &str| float_of(panel.get(key), "壁の中で面材が占める領域");
        let (left, bottom) = (edge("left")?, edge("bottom")?);
        let (right, top) = (edge("right")?, edge("top")?);
        for position in [left, right] {
            if position > 0.0 && position < width {
                migrated.add_joint(frame::Direction::Vertical, position);
            }
        }
        for position in [bottom, top] {
            if position > 0.0 && position < height {
                migrated.add_joint(frame::Direction::Horizontal, position);
            }
        }
    }
    Ok(migrated)
}

/// 軸組材 1 本の入力を読む。
///
/// 種別（柱・間柱・横架材・継目の材）は、図の勝ち負けと足すときの既定を
/// 決める。種別を持たない入力（種別を入れる前の版・手で組み立てた入力）は、
/// 名前が既定の名前と同じならその種別、違えば向きから決める（縦材は間柱、
/// 横材は継目の材＝どちらも勝ち負けのいちばん弱い側）。向きを書いていなければ
/// 種別のふつうの向きを使う。
fn normalize_member(item: &Value) -> Result<frame::Member, String> {
    let label = text_of(item.get("label"));
    let kind = match item.get("kind") {
        Some(value) if !is_blank(Some(value)) => frame::Kind::from_id(&text_of(Some(value))),
        _ => kind_of_label(&label, item.get("direction")),
    };
    let direction = match item.get("direction") {
        Some(value) if !is_blank(Some(value)) => {
            frame::Direction::from_id(&text_of(Some(value)))
        }
        _ => kind.default_direction(),
    };
    Ok(frame::Member {
        kind,
        direction,
        label: match label.is_empty() {
            true => kind.label().to_string(),
            false => label,
        },
        position: float_of(item.get("position"), "軸組材の位置")?,
        width: float_of(item.get("width"), "軸組材の見付け幅")?,
    })
}

/// 種別を持たない入力の種別。名前が既定の名前と同じならその種別にする。
fn kind_of_label(label: &str, direction: Option<&Value>) -> frame::Kind {
    if let Some(kind) = frame::KINDS
        .iter()
        .find(|kind| kind.label() == label)
        .copied()
    {
        return kind;
    }
    match frame::Direction::from_id(&text_of(direction)) {
        frame::Direction::Horizontal => frame::Kind::Joint,
        frame::Direction::Vertical => frame::Kind::Stud,
    }
}

/// 壁の間柱ピッチ [mm]（軸組材を持たない前の版の入力を読み替えるときだけ使う）。
///
/// 間柱ピッチは壁の入力だったが、その前の版では面材ごとの割り付けの欄にあった。
/// 壁が持っていなければ、面材が持っていた値のうち最初の 1 つを採る（1 枚の
/// 壁の中で間柱の間隔が面材ごとに変わることはないので、これで当時の入力の
/// 意味がそのまま保たれる）。どこにも無ければ尺モジュールの 455 mm。
fn wall_stud_pitch(wall: &Value, panels: &[Value]) -> Result<f64, String> {
    if !is_blank(wall.get("studPitch")) {
        return float_of(wall.get("studPitch"), "間柱・根太ピッチ");
    }
    for panel in panels {
        if !is_blank(panel.get("studPitch")) {
            return float_of(panel.get("studPitch"), "間柱・根太ピッチ");
        }
    }
    Ok(DEFAULT_STUD_PITCH)
}

/// 面材の並びを、どれも「壁の中で占める領域」を持つ形にそろえる。
///
/// 面材が left/right/bottom/top を持っていればそのまま。持っていない前の版の
/// 入力（面材ごとに width・height を持ち、壁の中の位置は持たないか、左下だけを
/// 持っていた形）は、
///
///   - 左下が分かるならそこへ、
///   - 分からないなら**張る面ごとに下から順に積んで**、
///
/// 領域に直す。積むのは、壁は下から段を重ねて張るのがふつうで、面材が重なった
/// 状態（＝枚数を二重に数えている、と判定が出る状態）を作らないため。壁より
/// 高く積み上がれば、そのぶんは「はみ出し」として判定に出る。
fn placed_panels(panels: &[Value]) -> Vec<Value> {
    let mut stacked_front = 0.0_f64;
    let mut stacked_back = 0.0_f64;
    panels
        .iter()
        .map(|panel| {
            if !is_blank(panel.get("right")) || !is_blank(panel.get("top")) {
                return panel.clone();
            }
            let width = float_of(panel.get("width"), "面材の幅 W").unwrap_or(0.0);
            let height = float_of(panel.get("height"), "面材の高さ H").unwrap_or(0.0);
            let stacked = if Side::from_id(&text_of(panel.get("side"))) == Side::Back {
                &mut stacked_back
            } else {
                &mut stacked_front
            };
            // 前の版で左下だけを入れていた入力は、その位置をそのまま使う。
            let left = float_of(panel.get("originX"), "壁内の位置 X").unwrap_or(0.0);
            let bottom = match is_blank(panel.get("originY")) {
                true => *stacked,
                false => float_of(panel.get("originY"), "壁内の位置 Y").unwrap_or(0.0),
            };
            *stacked = bottom + height;

            let mut entries: Vec<(String, Value)> = match panel {
                Value::Obj(entries) => entries.clone(),
                _ => Vec::new(),
            };
            entries.extend([
                ("left".to_string(), left.into()),
                ("bottom".to_string(), bottom.into()),
                ("right".to_string(), (left + width).into()),
                ("top".to_string(), (bottom + height).into()),
            ]);
            Value::Obj(entries)
        })
        .collect()
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
    Ok(PanelInput {
        panel_id,
        panel_name: text_of(panel.get("panelName")),
        side: Side::from_id(&text_of(panel.get("side"))).id().to_string(),
        left: float_of(panel.get("left"), "面材の左端 X")?,
        bottom: float_of(panel.get("bottom"), "面材の下端 Y")?,
        right: float_of(panel.get("right"), "面材の右端 X")?,
        top: float_of(panel.get("top"), "面材の上端 Y")?,
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
        nail_pitch: float_of(panel.get("nailPitch"), "釘ピッチ")?,
        // 未入力のへりあきは、表 3.2.1 の配列が前提とする 10 mm とみなす。
        edge_distance: float_or(panel.get("edgeDistance"), "へりあき", DEFAULT_EDGE_DISTANCE)?,
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

/// この面材の釘座標を組み立てられない理由を返す（組み立てられるなら None）。
///
/// 面材の占有領域と壁の軸組材から釘座標を作るので、止まるのは
///
///   - 領域が矩形になっていない（右端が左端より左にある、など）
///   - 釘ピッチ・へりあきが釘を置けない値
///
/// のいずれか。文面は入力欄の言葉で書く（nail_array 側にも同じ状況を弾く
/// guard があるが、あちらは式の言葉で書かれた最終防衛線）。釘の列が増え
/// すぎることは、軸組材の本数の上限（frame::MAX_MEMBERS）で先に止まる。
fn unusable_reason(panel: &PanelInput) -> Option<String> {
    if !(panel.width() > 0.0) || !(panel.height() > 0.0) {
        return Some(
            "壁の中で面材が占める領域を入力してください（右端は左端より右、上端は下端より上）。"
                .to_string(),
        );
    }
    if !(panel.nail_pitch > 0.0) {
        return Some("釘ピッチには正の数値を入力してください。".to_string());
    }
    if panel.edge_distance < 0.0 {
        return Some("へりあきには 0 以上の数値を入力してください。".to_string());
    }
    let span_x = panel.width() - panel.edge_distance * 2.0;
    let span_y = panel.height() - panel.edge_distance * 2.0;
    if !(span_x > 0.0) || !(span_y > 0.0) {
        return Some(
            "へりあきが面材の寸法に対して大きすぎます。面材の内側に釘を置けません。".to_string(),
        );
    }
    None
}

/// 釘リストと、組み立てられない理由（組み立てられるなら None）を返す。
///
/// 理由をエラーではなく戻り値にしているのは、入力途中の面材を画面へ
/// そのまま出すため。
fn nails_and_reason(panel: &PanelInput, frame: &Frame) -> (Vec<Nail>, Option<String>) {
    if let Some(reason) = unusable_reason(panel) {
        return (Vec::new(), Some(reason));
    }
    let layout = panel.layout(frame);
    // 本数は寸法とピッチで決まるので、座標を作る前に数える。
    let count = layout.nail_count();
    if count > MAX_NAILS {
        return (
            Vec::new(),
            Some(format!(
                "釘の本数が多すぎます（{count} 本）。面材 1 枚あたり {MAX_NAILS} 本までにしてください。"
            )),
        );
    }
    (layout.nails(), None)
}

/// 面材の占有領域と壁の軸組から釘リストを組み立てる（作れない入力はエラー）。
pub fn nails_of(panel: &PanelInput, frame: &Frame) -> Result<Vec<Nail>, String> {
    let (nails, reason) = nails_and_reason(panel, frame);
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
                let (nails, reason) = nails_and_reason(panel, &input.frame);
                let report = match reason {
                    Some(reason) => Err(reason),
                    None => build_panel_report(panel, &nails, input, index),
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
pub fn compute_panel(panel: &PanelInput, wall: &WallInput, index: usize) -> Result<Value, String> {
    let nails = nails_of(panel, &wall.frame)?;
    build_panel_report(panel, &nails, wall, index)
}

/// この面材の釘列を、刺さる軸組材ごとの縁端距離にする（適用範囲 3.3(1)④）。
///
/// 中間の縦列は、釘配列計算に入れた列だけを数える（3.3(1)⑧ で外した縦列は
/// 釘そのものを置いていないので、へりあきと同じ物差しで測れる）。
fn frame_lines(panel: &PanelInput, wall: &WallInput) -> Vec<frame::Clearance> {
    let layout = panel.layout(&wall.frame);
    // 釘を打った中間の縦列だけを、壁の座標へ戻して渡す（面材の左右の縁の
    // 釘列は面材の側で決まるので、frame が別に見る）。3.3(1)⑧ で釘配列
    // 計算から外した縦列は、そもそも釘を置いていないのでここにも来ない。
    let studs: Vec<f64> = if layout.uses_intermediate_studs() {
        layout
            .studs
            .iter()
            .map(|position| position + panel.left)
            .filter(|position| *position > panel.left && *position < panel.right)
            .collect()
    } else {
        Vec::new()
    };
    frame::clearances(
        &frame::Placement {
            left: panel.left,
            bottom: panel.bottom,
            right: panel.right,
            top: panel.top,
            edge_distance: panel.edge_distance,
        },
        &wall.frame,
        &studs,
    )
}

/// この面材の釘で必要な、軸材の釘列に対する縁端距離 [mm]（3.3(1)④）。
fn required_frame_clearance(panel: &PanelInput) -> f64 {
    frame::required_clearance(
        wall::find_material(&panel.material_id).map(|material| material.nail_diameter),
    )
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

/// 釘配列が何から決まったのかを、そのまま読める 1 行にする。
///
/// 釘座標は入力せず、壁の軸組（間柱ピッチ）と面材の占有領域から組み立てる。
/// その根拠が計算書の上で追えるように、決め手になった値をそのまま並べる。
fn nail_arrangement_text(panel: &PanelInput, columns: usize) -> String {
    format!(
        "四周打ち ＋ 中間の縦材（この面材にかかる縦列 {} 本）　／　釘 @{}　／　へりあき {} mm",
        format_int(columns as f64),
        format_dimension(panel.nail_pitch),
        format_dimension(panel.edge_distance),
    )
}

/// 面材 1 枚が壁の中で占める領域を、そのまま読める 1 行にする。
fn placement_text(panel: &PanelInput) -> String {
    format!(
        "{}　左下 ({}, {}) 〜 右上 ({}, {}) mm",
        panel.side().label(),
        format_dimension(panel.left),
        format_dimension(panel.bottom),
        format_dimension(panel.right),
        format_dimension(panel.top),
    )
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
    /// 壁の面材配列図。
    diagram: Value,
    /// 面材の一覧（面材・張る面・寸法・位置・面積）。
    rows: Vec<Value>,
    /// 判定の 1 行。
    check: Value,
}

/// 壁内の面材配列を組み立てる。
///
/// 面材は「壁の中で占める領域」そのものなので、配列図は必ず描ける。図と表で
/// 「この壁をどう張る前提の計算か」を残し、配置と計算の食い違い（はみ出し・
/// 重なり）を判定に出す。
fn build_wall_layout(input: &WallInput) -> WallLayoutReport {
    let pieces: Vec<Piece> = input
        .panels
        .iter()
        .enumerate()
        .map(|(position, panel)| panel.piece(panel_label(panel, position)))
        .collect();
    let inspection = wall_layout::inspect(input.width, input.height, &pieces);

    let placement: Vec<String> = inspection
        .sides
        .iter()
        .map(|(side, count, _)| format!("{} {} 枚", side.label(), count))
        .collect();

    WallLayoutReport {
        summary: format!(
            "壁の面材配列図のとおり（{}{}）",
            placement.join("・"),
            if inspection.sides.len() > 1 {
                " ＝ 両面張り"
            } else {
                ""
            }
        ),
        diagram: layout_diagram(input, &pieces, &inspection),
        rows: layout_rows(&pieces, &inspection),
        check: Value::obj([
            ("label", "面材の配置（壁の面材配列図との整合）".into()),
            ("value", layout_check_text(input, &pieces, &inspection).into()),
            ("ok", inspection.ok.into()),
        ]),
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
    // 軸組材も図に描くので、描く範囲に入れる（壁の両端の柱・上下の横架材は
    // 見付け幅の半分が壁の外へ出る）。交わるところは種別の勝ち負けで切る。
    let members = frame::shapes(&input.frame, (0.0, 0.0, input.width, input.height));
    let (min_x, min_y, max_x, max_y) = wall_layout::bounds(
        input.width,
        input.height,
        pieces,
        &members
            .iter()
            .map(|shape| (shape.x, shape.y, shape.x + shape.width, shape.y + shape.height))
            .collect::<Vec<(f64, f64, f64, f64)>>(),
    );

    let sides: Vec<Value> = inspection
        .sides
        .iter()
        .map(|(side, count, area)| {
            let on_side: Vec<(usize, &Piece)> = pieces
                .iter()
                .enumerate()
                .filter(|(_, piece)| piece.side == *side)
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
                                let (x, y) = piece.origin;
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
        // 軸組材。面材に重ねて描くので、面材の縁がどの材に載っているのか
        // （＝釘がどこに刺さるのか）が図で分かる。
        (
            "members",
            Value::Arr(members.iter().map(frame::Shape::to_value).collect()),
        ),
        ("sides", Value::Arr(sides)),
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
fn layout_rows(pieces: &[Piece], inspection: &wall_layout::Inspection) -> Vec<Value> {
    pieces
        .iter()
        .enumerate()
        .map(|(index, piece)| {
            let note = placement_note(inspection, index);
            let (x, y) = piece.origin;
            let position = format!("({}, {})", format_dimension(x), format_dimension(y));
            let verdict = if note.is_empty() {
                "OK".to_string()
            } else {
                note
            };
            Value::obj([
                ("label", piece.label.clone().into()),
                ("ok", (verdict == "OK").into()),
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
fn build_panel_report(
    panel: &PanelInput,
    nails: &[Nail],
    wall: &WallInput,
    index: usize,
) -> Result<Value, String> {
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

    // この面材にかかった釘の縦列の本数（面材の左右の縁 ＋ 中間の縦材）。
    // 釘配列が壁の軸組材から決まったことを、計算書の上で追えるようにする。
    let columns = panel.layout(&wall.frame).stud_positions().len();

    // 釘配列諸定数（3.2）そのものには面材と釘の仕様は要らないが、この面材が
    // 壁の計算（3.3）へ何を持ち込むのかが 1 ページで分かるように控えを添える。
    let mut inputs = vec![
        Value::obj([
            ("label", "面材寸法 W × H".into()),
            (
                "value",
                format!(
                    "{} × {} mm",
                    format_int(panel.width()),
                    format_int(panel.height())
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
            (
                "value",
                nail_arrangement_text(panel, columns).into(),
            ),
        ]),
        Value::obj([
            // 実際に置かれた釘の座標から測る（どの入力方式でも同じ）。
            ("label", "へりあき（面材の縁から釘まで）".into()),
            (
                "value",
                format!(
                    "{} mm",
                    format_dimension(layout::min_edge_clearance(
                        nails,
                        panel.width(),
                        panel.height()
                    ))
                )
                .into(),
            ),
        ]),
        Value::obj([
            // 釘が刺さる軸組材の縁まで（適用範囲 3.3(1)④ の軸材側）。どの
            // 釘列がいちばん厳しいのかまで出す（壁の判定はこの値で決まる）。
            ("label", "軸材の縁端距離（釘から軸組材の縁まで）".into()),
            (
                "value",
                {
                    let worst = frame::worst(
                        &frame_lines(panel, wall),
                        required_frame_clearance(panel),
                    );
                    format!("最小 {}（{}）", worst.value(), worst.label())
                }
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
        ("width", panel.width().into()),
        ("height", panel.height().into()),
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
        ("diagram", build_diagram(panel, nails, &result, &wall.frame)),
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
        let nails = nails_of(panel, &input.frame).map_err(named)?;
        let constants =
            nail_array::compute(&nails, panel.panel_area()).map_err(|error| named(error.0))?;
        clearances.push(layout::min_edge_clearance(
            &nails,
            panel.width(),
            panel.height(),
        ));
        panel_reports.push(with_ok(build_panel_report(panel, &nails, input, position)?));
        specs.push(wall::PanelSpec::new(
            &panel_label(panel, position),
            &constants,
            panel.width(),
            panel.height(),
            wall::Grain::from_id(&panel.grain),
            panel.sheathing(),
            panel.nail(),
        ));
    }

    let result = wall::compute(&wall::Wall {
        height: input.height,
        width: input.width,
        has_intermediate_stud: input.has_intermediate_stud(),
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

    // 適用範囲 3.3(1)④「軸材の釘列に対する縁端距離は、20mm 以上かつ接合具径
    // d ×5 以上」。どの釘列がどの軸組材に来るかは、軸組材の位置と面材の
    // 張られ方で決まるので、面材 1 枚ずつ釘列を並べ、いちばん余裕の少ない
    // 釘列を壁の判定にする。釘列を受ける材が無い（面材の継目に受け材が入って
    // いない）ときは、その釘列がいちばん厳しい。
    let frames: Vec<(usize, frame::Clearance, f64)> = input
        .panels
        .iter()
        .enumerate()
        .map(|(position, panel)| {
            let required = required_frame_clearance(panel);
            (
                position,
                frame::worst(&frame_lines(panel, input), required),
                required,
            )
        })
        .collect();
    let (frame_position, frame_worst, frame_required) =
        frames.iter().fold(frames[0].clone(), |worst, line| {
            if line.1.margin(line.2) < worst.1.margin(worst.2) {
                line.clone()
            } else {
                worst
            }
        });
    let frame_ok = frames.iter().all(|(_, line, required)| line.ok(*required));
    let frame_basis = match wall::find_material(&input.panels[frame_position].material_id) {
        Some(material) => format!(
            "20 mm かつ 釘の呼び径 φ{} mm × {} 以上",
            format_dimension(material.nail_diameter),
            format_dimension(wall::EDGE_DISTANCE_DIAMETER_FACTOR)
        ),
        None => "釘の呼び径が分からないため 20 mm のみで確認".to_string(),
    };

    let mut inputs = vec![
        row("階高 H", format!("{} mm", format_int(input.height))),
        row("壁の幅 W", format!("{} mm", format_int(input.width))),
        // 軸組材は 1 本ずつ自由な位置に入れるので、控えには本数だけを書き、
        // 位置と見付け幅は下の「軸組材」の表に並べる。釘の縦列の位置も、
        // 釘がどの材のどこに刺さるか（＝軸材の縁端距離）も、ここで決まる。
        row(
            "軸組材",
            format!(
                "縦材 {} 本 ／ 横材 {} 本（下の「軸組材」を参照）",
                format_int(input.frame.of(frame::Direction::Vertical).len() as f64),
                format_int(input.frame.of(frame::Direction::Horizontal).len() as f64)
            ),
        ),
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
            // 「設けるか」は別入力ではなく、壁の中に立つ縦材で決まる
            //（釘は間柱に打っているのに ξ = 1、という食い違いを作らない）。
            "{}（壁の中に立つ縦材による／せん断座屈の ξ = {}）",
            if input.has_intermediate_stud() {
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
    let mut checks: Vec<Value> = Vec::with_capacity(6);
    checks.push(arrangement.check.clone());
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
            ("label", "適用範囲 3.3(1)④ 軸材の縁端距離".into()),
            (
                "value",
                // どの面材のどの釘列がいちばん厳しいのか（＋その材の見付け
                // 幅）まで出す。広げるべきなのが面材のへりあきなのか、材の
                // 見付けなのかが、この 1 行で分かる。
                format!(
                    "最小 縁端距離 {} {} {} mm（面材「{}」の{} ／ {}）",
                    frame_worst.value(),
                    if frame_ok { "≧" } else { "<" },
                    format_dimension(frame_required),
                    panel_label(&input.panels[frame_position], frame_position),
                    frame_worst.label(),
                    frame_basis
                )
                .into(),
            ),
            ("ok", frame_ok.into()),
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
        // 壁の軸組材（1 本ずつ自由な位置に入れる）。釘の縦列の位置も、釘が
        // どの材のどこに刺さるか（＝軸材の縁端距離）も、ここで決まるので、
        // 位置と見付け幅をそのまま表に残す。
        (
            "frameColumns",
            Value::Arr(
                ["軸組材", "種別", "向き", "材心の位置 [mm]", "見付け幅 [mm]"]
                    .into_iter()
                    .map(Value::from)
                    .collect(),
            ),
        ),
        ("frame", Value::Arr(frame::rows(&input.frame))),
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
        ("frameClearanceOk", frame_ok.into()),
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
fn build_diagram(
    panel: &PanelInput,
    nails: &[Nail],
    result: &nail_array::Constants,
    frame: &Frame,
) -> Value {
    let mut min_x = 0.0_f64;
    let mut max_x = panel.width();
    let mut min_y = 0.0_f64;
    let mut max_y = panel.height();
    for nail in nails {
        min_x = min_x.min(nail.x);
        max_x = max_x.max(nail.x);
        min_y = min_y.min(nail.y);
        max_y = max_y.max(nail.y);
    }
    // この面材にかかる軸組材（釘がどこに刺さるのかを、図の上で確かめられる
    // ようにする）。材が面材の外へ出るぶんも範囲に入れて、図の縁で切らない。
    let members = frame::shapes(
        frame,
        (panel.left, panel.bottom, panel.right, panel.top),
    );
    for shape in &members {
        min_x = min_x.min(shape.x);
        max_x = max_x.max(shape.x + shape.width);
        min_y = min_y.min(shape.y);
        max_y = max_y.max(shape.y + shape.height);
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
        ("panelWidth", panel.width().into()),
        ("panelHeight", panel.height().into()),
        ("minX", min_x.into()),
        ("maxX", max_x.into()),
        ("minY", min_y.into()),
        ("maxY", max_y.into()),
        ("xTicks", ticks(&xs)),
        ("yTicks", ticks(&ys)),
        // 軸組材（面材の左下を原点とした矩形）。釘との位置関係が図で見える
        // ので、へりあき（面材の縁から釘まで）と軸材の縁端距離（釘から材の
        // 縁まで）を、数値と図の両方で確かめられる。
        (
            "members",
            Value::Arr(members.iter().map(frame::Shape::to_value).collect()),
        ),
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
    /// へりあき 10 mm を見込んだ配列（本は左下の釘を (0, 0) として書いている）。
    ///
    /// 本の図は川型（縦線だけ）だが、面材張り大壁は適用範囲 3.3(1)⑤ により
    /// 四周打ちなので、この形の入力から出てくる釘配列は日型になる。川型・
    /// 山型・ロ型を含む表 3.2.1 の全 106 通りとの突き合わせは presets.rs に
    /// あり、割り付け規則そのものはそちらで検証している。
    ///
    /// 面材と釘は 3.3(3) の計算例と同じ（構造用合板 12mm ＋ 鉄丸釘 N-65）。
    /// 釘配列諸定数（3.2）そのものには効かないが、面材ごとの入力なので
    /// 面材 1 枚を作るたびに付いてくる。
    fn example_panel() -> PanelInput {
        PanelInput {
            panel_id: "w1-p1".to_string(),
            panel_name: "グレー本の計算例".to_string(),
            side: "front".to_string(),
            left: 0.0,
            bottom: 0.0,
            right: 910.0,
            top: 610.0,
            nail_pitch: 150.0,
            edge_distance: 10.0,
            grain: String::new(),
            ..example_spec()
        }
    }

    /// 面材 1 枚だけの壁（軸組は尺モジュールの @455 で組み立て、面材の縁を
    /// 受ける材まで入れたもの）。
    fn example_wall_of(panel: PanelInput) -> WallInput {
        let mut frame = Frame::from_stud_pitch(910.0, 2900.0, DEFAULT_STUD_PITCH);
        frame.add_joint(frame::Direction::Horizontal, panel.top);
        WallInput {
            wall_id: "w1".to_string(),
            wall_name: String::new(),
            height: 2900.0,
            width: 910.0,
            frame,
            panels: vec![panel],
        }
    }

    /// 面材 1 枚を単独で計算するときの、その面材を張る壁。
    fn example_wall() -> WallInput {
        example_wall_of(example_panel())
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
                "walls": [{"height": "2900", "junk": 2,
                           "panels": [{"right": "610", "top": "910"}]}]}"#,
        )
        .unwrap();
        assert_eq!(data.project_name, "邸");
        assert_eq!(data.walls[0].height, 2900.0);
        assert_eq!(data.walls[0].panels[0].width(), 610.0);
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

    /// 面材の既定は「表面・へりあき 10 mm」。
    #[test]
    fn a_panel_defaults_to_the_front_side_and_ten_millimetres() {
        let data = normalize(r#"{"walls": [{"panels": [{"right": 910, "top": 1820}]}]}"#).unwrap();
        let panel = &data.walls[0].panels[0];
        assert_eq!(panel.panel_id, "w1-p1");
        assert_eq!(panel.side, "front");
        assert_eq!(panel.edge_distance, DEFAULT_EDGE_DISTANCE);
    }

    /// 面材の寸法は、壁の中で占める領域から決まる（別に入力しない）。
    #[test]
    fn the_size_of_a_panel_comes_from_the_area_it_covers() {
        let data = normalize(
            r#"{"walls": [{"panels": [
                 {"left": 0, "bottom": 0, "right": 910, "top": 1820},
                 {"left": 910, "bottom": 1820, "right": 1820, "top": 2730}
               ]}]}"#,
        )
        .unwrap();

        let panels = &data.walls[0].panels;
        assert_eq!((panels[0].width(), panels[0].height()), (910.0, 1820.0));
        assert_eq!(panels[0].panel_area(), 1_656_200.0);
        assert_eq!((panels[1].width(), panels[1].height()), (910.0, 910.0));
    }

    /// 領域が矩形になっていない面材は計算できない（配置が必須ということ）。
    #[test]
    fn a_panel_without_an_area_cannot_be_calculated() {
        let panel = PanelInput {
            right: 0.0,
            top: 0.0,
            ..example_panel()
        };
        let error = nails_of(&panel, &example_wall().frame).unwrap_err();
        assert!(error.contains("壁の中で面材が占める領域"), "{error}");
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

    /// 軸組材は壁の入力で、1 本ずつ自由な位置に入れる。
    #[test]
    fn the_frame_members_are_read_as_they_are_typed() {
        let data = normalize(
            r#"{"walls":[{"height":2900,"width":910,"frame":[
                 {"direction":"vertical","label":"柱","position":0,"width":120},
                 {"direction":"vertical","label":"間柱","position":600,"width":45},
                 {"direction":"horizontal","label":"まぐさ","position":2000,"width":105}
               ]}]}"#,
        )
        .unwrap();

        let members = &data.walls[0].frame.members;
        assert_eq!(members.len(), 3);
        assert_eq!(members[1].label, "間柱");
        assert_eq!(members[1].position, 600.0);
        assert_eq!(members[2].direction, frame::Direction::Horizontal);
        // 等間隔でない位置もそのまま（釘の縦列はこの位置に入る）。
        assert_eq!(data.walls[0].frame.studs_between(0.0, 910.0), vec![600.0]);
        // 書き戻した JSON（計算書 PDF に埋める形）から同じ軸組材が読める。
        let round_trip = normalize_data(&data.to_value()).unwrap();
        assert_eq!(round_trip.walls[0].frame, data.walls[0].frame);
    }

    /// 名前も種別も書かなかった軸組材は、向きから決めた種別の名前で呼ぶ
    /// （縦材なら間柱・横材なら継目の材＝どちらも勝ち負けのいちばん弱い側）。
    #[test]
    fn a_frame_member_without_a_name_takes_the_name_of_its_kind() {
        let data = normalize(
            r#"{"walls":[{"height":2900,"width":910,
                 "frame":[{"direction":"horizontal","position":2000,"width":105}]}]}"#,
        )
        .unwrap();
        assert_eq!(data.walls[0].frame.members[0].label, "継目の材");
        assert_eq!(data.walls[0].frame.members[0].kind, frame::Kind::Joint);

        // 名前が既定の名前と同じなら、その種別として読む（種別を入れる前の
        // 版で保存した入力も、同じ勝ち負けで描ける）。
        let named = normalize(
            r#"{"walls":[{"height":2900,"width":910,"frame":[
                 {"direction":"vertical","label":"柱","position":0,"width":105}]}]}"#,
        )
        .unwrap();
        assert_eq!(named.walls[0].frame.members[0].kind, frame::Kind::Column);
    }

    #[test]
    fn rejects_a_non_numeric_frame_member() {
        let error = normalize(
            r#"{"walls":[{"height":2900,"width":910,
                 "frame":[{"label":"柱","position":"はしら","width":105}]}]}"#,
        )
        .unwrap_err();
        assert!(error.contains("軸組材の位置"), "{error}");
    }

    #[test]
    fn rejects_too_many_frame_members() {
        let members =
            vec![r#"{"position":1,"width":45}"#; frame::MAX_MEMBERS + 1].join(",");
        let error =
            normalize(&format!(r#"{{"walls":[{{"frame":[{members}]}}]}}"#)).unwrap_err();
        assert!(error.contains("軸組材は"), "{error}");
    }

    #[test]
    fn rejects_a_non_numeric_dimension() {
        let error = normalize(r#"{"walls": [{"panels": [{"right": "ろく"}]}]}"#).unwrap_err();
        assert!(error.contains("面材の右端 X"), "{error}");
    }

    #[test]
    fn rejects_too_many_walls_and_panels() {
        let walls = vec![r#"{"height": 1}"#; MAX_WALLS + 1].join(",");
        let error = normalize(&format!(r#"{{"walls": [{walls}]}}"#)).unwrap_err();
        assert!(error.contains("壁は"), "{error}");

        let panels = vec![r#"{"right": 910, "top": 910}"#; MAX_WALL_PANELS + 1].join(",");
        let error = normalize(&format!(r#"{{"walls": [{{"panels": [{panels}]}}]}}"#)).unwrap_err();
        assert!(error.contains("面材は"), "{error}");
    }

    // --- 前の版で保存した計算書 PDF の読み込み --------------------------------

    /// 釘配列パターンを別に登録し、壁が patternId で指していた形。
    ///
    /// 面材ごとの寸法は「壁の中で占める領域」へ移し替える（位置が無いので
    /// 下から順に積む）。釘配列は壁の軸組から作り直すので、当時 格子・座標で
    /// 入れていた釘そのものは引き継がない。
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
        assert_eq!((panel.left, panel.bottom), (0.0, 0.0));
        assert_eq!((panel.right, panel.top), (910.0, 610.0));
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
        assert_eq!(data.walls[1].wall_name, "余り");
        assert_eq!(data.walls[1].panels[0].width(), 910.0);
    }

    /// 面材ごとに寸法を持ち、壁の中の位置を持たなかった版の入力は、
    /// 張る面ごとに下から順に積んで領域に直す（重ならないように）。
    #[test]
    fn panels_without_a_position_are_stacked_from_the_bottom() {
        let data = normalize(
            r#"{"walls": [{"height": 3000, "width": 910, "panels": [
                 {"width": 910, "height": 1820},
                 {"width": 910, "height": 910},
                 {"width": 910, "height": 1820, "side": "back"}
               ]}]}"#,
        )
        .unwrap();

        let panels = &data.walls[0].panels;
        assert_eq!((panels[0].bottom, panels[0].top), (0.0, 1820.0));
        assert_eq!((panels[1].bottom, panels[1].top), (1820.0, 2730.0));
        // 裏面は裏面で下から積む（表面の上には乗らない）。
        assert_eq!((panels[2].bottom, panels[2].top), (0.0, 1820.0));
        assert_eq!(panels[2].side, "back");
    }

    /// 左下だけを入れていた版（配置が任意入力だったころ）の入力も読む。
    #[test]
    fn panels_with_only_a_lower_left_corner_keep_that_position() {
        let data = normalize(
            r#"{"walls": [{"panels": [
                 {"width": 910, "height": 910, "originX": 455, "originY": 1820}]}]}"#,
        )
        .unwrap();

        let panel = &data.walls[0].panels[0];
        assert_eq!((panel.left, panel.bottom), (455.0, 1820.0));
        assert_eq!((panel.right, panel.top), (1365.0, 2730.0));
    }

    /// 軸組材を持たない前の版の入力（間柱ピッチだけ）は、当時の前提のまま
    /// 軸組材へ読み替える（壁の両端に柱・ピッチで間柱・上下に横架材）。
    #[test]
    fn the_stud_pitch_of_an_older_form_becomes_frame_members() {
        let data = normalize(
            r#"{"walls": [{"width": 1820, "height": 2900, "studPitch": 910,
                 "panels": [{"left": 0, "bottom": 0, "right": 1820, "top": 910}]}]}"#,
        )
        .unwrap();

        let frame = &data.walls[0].frame;
        let verticals: Vec<(String, f64, f64)> = frame
            .of(frame::Direction::Vertical)
            .iter()
            .map(|member| (member.label.clone(), member.position, member.width))
            .collect();
        assert_eq!(
            verticals,
            vec![
                ("柱".to_string(), 0.0, 105.0),
                ("間柱".to_string(), 910.0, 45.0),
                ("柱".to_string(), 1820.0, 105.0),
            ]
        );
        // 面材の継目（壁の内側に来る面材の縁）には、当時の前提どおり材が立つ。
        let joint = frame
            .carrying(frame::Direction::Horizontal, 910.0)
            .expect("継目の材");
        assert_eq!(joint.label, "継目の材");
        assert_eq!((joint.position, joint.width), (910.0, 105.0));

        // 間柱ピッチを面材ごとに持っていた、さらに前の版も同じように読める。
        let older = normalize(
            r#"{"walls": [{"width": 1820, "height": 2900, "panels": [
                 {"width": 1820, "height": 910, "studPitch": 910}]}]}"#,
        )
        .unwrap();
        assert_eq!(
            older.walls[0].frame.studs_between(0.0, 1820.0),
            vec![910.0]
        );
    }

    // --- 面材 1 枚の計算（グレー本 3.2） -------------------------------------

    /// 釘配列は、壁の軸組（間柱ピッチ）と面材の占有領域から組み立てる。
    ///
    /// 910 × 610 を壁の左下に張り、間柱 @455・釘 @150。四周打ちなので
    /// 縦線は 0・455・910、横線は上下端。表 3.2.1 の「910×610 横置・日型
    /// （@455 / 釘 @150）」と同じ配列になる。
    #[test]
    fn the_nail_array_comes_from_the_wall_frame() {
        let report = compute_panel(&example_panel(), &example_wall(), 0).unwrap();

        assert_eq!(report.get("panelArea").unwrap().as_f64(), Some(555_100.0));
        // 表 3.2.1 の同じ欄（Ixy 1.56 / Zxy 0.0063 / Cxy 1.23）と合う。
        let preset = crate::presets::find("910x610-s455-n150-hi").unwrap();
        assert_eq!(
            report.get("nails").unwrap().as_array().unwrap().len(),
            preset.nails().len()
        );
        let ixy = report.get("result").unwrap().get("Ixy").unwrap().as_f64().unwrap();
        assert!((ixy - 1.56).abs() <= 0.02, "{ixy}");
    }

    /// 同じ面材でも、壁の中で置く場所が変われば釘の縦列が変わる。
    #[test]
    fn moving_a_panel_along_the_wall_changes_its_nail_columns() {
        // 幅 455 の面材を、間柱と間柱のあいだ（455〜910）に張ると中間の
        // 縦列が無くなり、壁の左端（0〜455）に張ったときと同じ 2 列になる。
        let between = PanelInput {
            left: 455.0,
            right: 910.0,
            ..example_panel()
        };
        let at_edge = PanelInput {
            left: 0.0,
            right: 455.0,
            ..example_panel()
        };
        let frame = example_wall().frame;
        let columns = |panel: &PanelInput| panel.layout(&frame).stud_positions().len();
        assert_eq!(columns(&between), 2);
        assert_eq!(columns(&at_edge), 2);

        // 間柱をまたぐ位置（0〜910）なら 3 列。
        assert_eq!(columns(&example_panel()), 3);
    }

    /// 3.3(1)⑧ により、面材の長辺方向に走る間柱の釘列は計算に含めない。
    #[test]
    fn a_portrait_panel_drops_the_intermediate_columns() {
        let portrait = PanelInput {
            right: 910.0,
            top: 1820.0,
            ..example_panel()
        };
        assert_eq!(
            portrait.layout(&example_wall().frame).stud_positions().len(),
            2
        );
    }

    #[test]
    fn the_inputs_section_repeats_what_was_typed() {
        let report = compute_panel(&example_panel(), &example_wall(), 0).unwrap();
        let inputs = labelled(&report, "inputs", "label");

        assert!(inputs.contains(&("面材寸法 W × H".to_string(), "910 × 610 mm".to_string())));
        assert!(inputs.contains(&("面材面積 Aw".to_string(), "555,100 mm²".to_string())));
        assert!(inputs.contains(&(
            "壁内の配置".to_string(),
            "表面　左下 (0, 0) 〜 右上 (910, 610) mm".to_string()
        )));
        // 釘配列は入力ではなく導出なので、何から決まったのかを控えに残す。
        let arrangement = inputs
            .iter()
            .find(|(label, _)| label == "釘配列")
            .map(|(_, value)| value.clone())
            .unwrap();
        assert!(arrangement.contains("四周打ち"), "{arrangement}");
        assert!(arrangement.contains("中間の縦材"), "{arrangement}");
        assert!(arrangement.contains("縦列 3 本"), "{arrangement}");
        assert!(arrangement.contains("釘 @150"), "{arrangement}");
        assert!(arrangement.contains("へりあき 10 mm"), "{arrangement}");
    }

    /// 面材と釘は面材ごとの入力なので、その控えも面材ごとの計算に付く
    /// （どの面材がどの仕様で壁の計算に入ったのかが 1 ページで分かる）。
    #[test]
    fn the_inputs_section_carries_the_specification_of_this_panel() {
        let report = compute_panel(&example_panel(), &example_wall(), 0).unwrap();
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
            &example_wall(),
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
        let narrow = compute_panel(&example_panel(), &example_wall(), 0).unwrap();
        let wide = compute_panel(
            &PanelInput {
                edge_distance: 30.0,
                ..example_panel()
            },
            &example_wall(),
            0,
        )
        .unwrap();
        let ixy = |report: &Value| report.get("result").unwrap().get("Ixy").unwrap().as_f64();
        assert!(ixy(&wide) < ixy(&narrow));
    }

    /// 桁を間違えた入力で計算とページ描画が止まらないようにする。
    #[test]
    fn rejects_an_absurd_number_of_nails() {
        let dense = PanelInput {
            nail_pitch: 0.5,
            ..example_panel()
        };
        assert!(nails_of(&dense, &example_wall().frame)
            .unwrap_err()
            .contains("釘の本数が多すぎます"));
    }

    /// 計算できない理由は、式の言葉ではなく入力欄の言葉で伝える。
    #[test]
    fn unusable_panels_are_explained_in_the_words_of_the_form() {
        let cases = [
            (
                PanelInput {
                    right: 0.0,
                    ..example_panel()
                },
                "壁の中で面材が占める領域",
            ),
            (
                PanelInput {
                    top: 0.0,
                    ..example_panel()
                },
                "壁の中で面材が占める領域",
            ),
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
            let error = compute_panel(&panel, &example_wall(), 0).unwrap_err();
            assert!(error.contains(expected), "{error} should mention {expected}");
        }
    }

    // --- 壁の計算（グレー本 3.3） -------------------------------------------

    /// グレー本 3.3(3) の計算例（図 3.3.10）を、フォームの入力の形で組み立てる。
    ///
    /// 階高 3000・幅 910 の準耐力壁形式の大壁に、下から 910 × 1820、その上に
    /// 910 × 910 を張る。間柱は 30 × 105 を @455。面材と釘は 2 枚とも計算例の
    /// 組合せ（本文が計算に使っている数値。表 3.3.1 の N-65 / CN65 の
    /// 入れ替わりについては wall.rs のコメント）。
    ///
    /// **本と 1 か所だけ違う**: 本は上側の 910 × 910 を表 3.2.1 の「ロ型」
    /// （中間の間柱に釘を打たない配列）として計算している。釘配列を壁の軸組から
    /// 導くこのツールでは、@455 の間柱が正方形の面材の内側に来るので、その列にも
    /// 釘が入る（表 3.2.1 の「日型」の欄にあたる）。本より釘が多くなるぶん
    /// 上側の面材の K0・My・Mu は大きく出る。下側の 910 × 1820 は 3.3(1)⑧ に
    /// より中間の間柱を含めないので、本とまったく同じ配列になる。
    fn wall_example_form() -> FormData {
        FormData {
            project_name: "グレー本 3.3 の計算例".to_string(),
            issued_on: String::new(),
            walls: vec![WallInput {
                wall_id: "w1".to_string(),
                wall_name: "計算例の大壁".to_string(),
                height: 3000.0,
                width: 910.0,
                // 間柱 30 × 105 を @455（図 3.3.10）。面材の横の継目
                //（Y = 1820）には受け材を入れてある。
                frame: {
                    let mut frame = Frame::from_stud_pitch(910.0, 3000.0, 455.0);
                    frame.members.iter_mut().for_each(|member| {
                        if member.label == frame::STUD_LABEL {
                            member.width = 30.0;
                        }
                    });
                    // 面材の横の継目（Y = 1820）と、上段の上の縁（Y = 2730）
                    // を受ける材（四周打ちなので、面材の縁には必ず材が要る）。
                    frame.add_joint(frame::Direction::Horizontal, 1820.0);
                    frame.add_joint(frame::Direction::Horizontal, 2730.0);
                    frame
                },
                panels: vec![
                    example_placed_panel(0, "下段", 0.0, 0.0, 910.0, 1820.0),
                    example_placed_panel(1, "上段", 0.0, 1820.0, 910.0, 2730.0),
                ],
            }],
        }
    }

    /// 計算例の面材と釘（釘 @75）を、壁の中の領域に置いた面材 1 枚。
    fn example_placed_panel(
        index: usize,
        name: &str,
        left: f64,
        bottom: f64,
        right: f64,
        top: f64,
    ) -> PanelInput {
        PanelInput {
            panel_id: format!("w1-p{}", index + 1),
            panel_name: name.to_string(),
            side: "front".to_string(),
            left,
            bottom,
            right,
            top,
            nail_pitch: 75.0,
            edge_distance: 10.0,
            grain: String::new(),
            ..example_spec()
        }
    }

    fn only_wall(data: &FormData) -> Value {
        compute_all_walls(data).as_array().unwrap()[0].clone()
    }

    /// 本: Pa = 8.37 kN、ΔPa = 9.20 kN/m（決めているのは K0/150）。
    ///
    /// このツールの答えは本より数 % 大きい（Pa +1.2%、K0 +1.2%、My +1.7%、
    /// Mu +2.8%）。上側の 910 × 910 に、本には無い間柱の釘列が入るため
    /// （`wall_example_form` のコメント参照）。決めている項（K0/150）も
    /// 塑性率 μ も本と同じで、違いは釘の本数だけ。
    #[test]
    fn the_wall_example_matches_the_book() {
        let report = only_wall(&wall_example_form());

        assert_eq!(report.get("ok"), Some(&Value::Bool(true)));
        assert_eq!(report.get("governing").unwrap().as_str(), Some("drift"));
        assert_eq!(report.get("withinLimit"), Some(&Value::Bool(true)));

        let result = report.get("result").unwrap();
        let value = |key: &str| result.get(key).unwrap().as_f64().unwrap();
        // 塑性率 μ は下側の面材（本と同じ配列）で決まるので、本と一致する。
        assert!((value("mu") - 5.25).abs() <= 0.01, "{}", value("mu"));
        // 残りは本より大きく、その差は 1.5% 以内に収まる。
        for (key, book) in [
            ("Pa", 8.37),
            ("dPa", 9.20),
            ("K0", 3_765_224.0),
            ("My", 34_623.0),
            ("Mu", 41_312.0),
        ] {
            let got = value(key);
            assert!(got > book, "{key}: {got} は本の {book} より大きいはず");
            assert!(
                (got - book) / book <= 0.03,
                "{key}: {got} と本の {book} の差が大きすぎます"
            );
        }
    }

    /// 下側の 910 × 1820 は、本の配列（表 3.2.1 の「1820×910 縦置・日型」）と
    /// まったく同じ釘配列になる（3.3(1)⑧ で中間の間柱を含めないため）。
    #[test]
    fn the_lower_panel_of_the_example_matches_the_book_exactly() {
        let form = wall_example_form();
        let panel = &form.walls[0].panels[0];
        let nails = nails_of(panel, &form.walls[0].frame).unwrap();
        let preset = crate::presets::find("910x1820-s455-n75-hi").unwrap();

        assert_eq!(nails, preset.nails());
    }

    /// 壁の計算には、その根拠である面材ごとの釘配列諸定数が必ず付いてくる。
    #[test]
    fn the_wall_report_carries_the_nail_array_of_every_panel() {
        let report = only_wall(&wall_example_form());
        let panels = report.get("panelReports").unwrap().as_array().unwrap();

        assert_eq!(panels.len(), 2);
        assert_eq!(panels[0].get("ok"), Some(&Value::Bool(true)));
        assert_eq!(panels[0].get("panelName").unwrap().as_str(), Some("下段"));
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
            "軸組材".to_string(),
            "縦材 3 本 ／ 横材 4 本（下の「軸組材」を参照）".to_string()
        )));
        assert!(inputs.contains(&(
            "中間材（間柱等）".to_string(),
            "あり（壁の中に立つ縦材による／せん断座屈の ξ = 2）".to_string()
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

    /// 3.3(1)④ の軸材の縁端距離（20mm 以上かつ釘の呼び径 ×5 以上）を検定する。
    ///
    /// 計算例の壁は、下段の上の縁（＝面材の横の継目）を受け材が受けている。
    /// 見付け 105 mm なら 52.5 − 10 = 42.5 mm で足りるが、45 mm の材に
    /// 替えると 22.5 − 10 = 12.5 mm しか残らず、20 mm に届かない。
    #[test]
    fn the_wall_report_checks_the_frame_clearance_against_the_member_width() {
        let mut data = wall_example_form();
        // 図 3.3.10 の 30 mm の間柱では中間の縦列が 15 mm しか取れないので、
        // ここでは継目の材だけを見るために 45 mm の間柱にしておく。
        widen_studs(&mut data, 45.0);
        let report = only_wall(&data);
        assert_eq!(report.get("frameClearanceOk"), Some(&Value::Bool(true)));

        let mut narrow = data;
        narrow.walls[0]
            .frame
            .members
            .iter_mut()
            .filter(|member| member.label == frame::JOINT_LABEL)
            .for_each(|member| member.width = 45.0);
        let report = only_wall(&narrow);

        assert_eq!(report.get("frameClearanceOk"), Some(&Value::Bool(false)));
        let value = labelled(&report, "checks", "label")
            .into_iter()
            .find(|(label, _)| label.contains("縁端距離"))
            .map(|(_, value)| value)
            .unwrap();
        assert!(value.contains("最小 縁端距離 12.5 mm < 20 mm"), "{value}");
        assert!(value.contains("継目の材（見付け 45 mm）"), "{value}");
        assert!(value.contains("φ3.05 mm × 5 以上"), "{value}");
    }

    /// 面材の縁を受ける軸組材が無ければ、そこには釘を打てない。
    #[test]
    fn a_nail_line_without_a_member_is_reported() {
        let mut data = wall_example_form();
        // 面材の横の継目（Y = 1820）から受け材を外す。
        data.walls[0]
            .frame
            .members
            .retain(|member| member.label != frame::JOINT_LABEL);
        let report = only_wall(&data);

        assert_eq!(report.get("frameClearanceOk"), Some(&Value::Bool(false)));
        let value = labelled(&report, "checks", "label")
            .into_iter()
            .find(|(label, _)| label.contains("縁端距離"))
            .map(|(_, value)| value)
            .unwrap();
        assert!(value.contains("最小 縁端距離 — < 20 mm"), "{value}");
        assert!(value.contains("軸組材なし"), "{value}");
    }

    /// 中間の縦材に打つ釘は材心の上に来るので、縁端距離は見付けの半分。
    /// へりあきをいくら広げても増えない（広げるべきなのは材の見付け）。
    #[test]
    fn a_nail_on_an_intermediate_stud_is_judged_against_half_the_stud() {
        // 計算例の間柱は 30 × 105（図 3.3.10）。上段の 910 × 910 にはその
        // 間柱がかかる（縦長の下段は 3.3(1)⑧ で中間の縦列を持たない）。
        let data = wall_example_form();
        let report = only_wall(&data);

        assert_eq!(report.get("frameClearanceOk"), Some(&Value::Bool(false)));
        let value = labelled(&report, "checks", "label")
            .into_iter()
            .find(|(label, _)| label.contains("縁端距離"))
            .map(|(_, value)| value)
            .unwrap();
        assert!(value.contains("最小 縁端距離 15 mm < 20 mm"), "{value}");
        assert!(
            value.contains("中間の縦材（X = 455 mm） ／ 間柱（見付け 30 mm）"),
            "{value}"
        );
    }

    /// 計算例の間柱（30 × 105）を、縁端距離の足りる 45 mm に太らせる。
    fn widen_studs(data: &mut FormData, width: f64) {
        data.walls[0]
            .frame
            .members
            .iter_mut()
            .filter(|member| member.label == frame::STUD_LABEL)
            .for_each(|member| member.width = width);
    }

    /// 面材と釘を表 3.3.1 から読み込んでいないときは、呼び径が分からないので
    /// 20mm の側だけを確かめる。
    #[test]
    fn the_frame_clearance_falls_back_to_twenty_millimetres_without_a_material() {
        let mut data = wall_example_form();
        for panel in &mut data.walls[0].panels {
            panel.material_id = String::new();
        }
        let value = labelled(&only_wall(&data), "checks", "label")
            .into_iter()
            .find(|(label, _)| label.contains("縁端距離"))
            .map(|(_, value)| value)
            .unwrap();
        assert!(value.contains("呼び径が分からないため 20 mm"), "{value}");
    }

    /// 釘配列図にも、その面材にかかる軸組材を描く（釘との位置関係が見える）。
    #[test]
    fn the_nail_drawing_carries_the_frame_members() {
        let report = compute_panel(&example_panel(), &example_wall(), 0).unwrap();
        let diagram = report.get("diagram").unwrap();
        let members = diagram.get("members").unwrap().as_array().unwrap();
        let number = |index: usize, key: &str| {
            members[index].get(key).unwrap().as_f64().unwrap()
        };

        // 910 × 610 を壁（W 910 × H 2900）の左下に張った面材。かかるのは
        // 両端の柱・@455 の間柱・下の横架材・上の縁の受け材。
        let labels: Vec<&str> = members
            .iter()
            .map(|member| member.get("label").unwrap().as_str().unwrap())
            .collect();
        assert_eq!(labels, vec!["柱", "間柱", "柱", "横架材", "継目の材"]);
        // 面材の左下が原点。左端の柱は材心が X = 0 なので、半分が外へ出る。
        assert_eq!((number(0, "x"), number(0, "width")), (-52.5, 105.0));
        assert_eq!((number(1, "x"), number(1, "width")), (432.5, 45.0));
        // 縦材は面材の下から上まで、横材は左から右まで。ただし交わるところは
        // 種別の勝ち負けで切る（間柱は下の横架材にも上の継目の材にも負ける
        // ので、そのあいだだけになる）。
        assert_eq!((number(1, "y"), number(1, "height")), (52.5, 505.0));
        assert_eq!((number(3, "x"), number(3, "width")), (0.0, 910.0));
        // 材が外へ出るぶんも、図に描く範囲へ入れる。
        assert_eq!(diagram.get("minX").unwrap().as_f64(), Some(-52.5));

        // 壁の上の横架材（Y = 2900）は、この面材（上端 610）にかからない。
        assert!(!labels.contains(&"横架材2"));
        assert_eq!(members.len(), 5);
    }

    /// 壁の面材配列図には、軸組材も描く（面材の縁がどの材に載っているか）。
    #[test]
    fn the_arrangement_drawing_carries_the_frame_members() {
        let report = only_wall(&wall_example_form());
        let members = report
            .get("wallDiagram")
            .unwrap()
            .get("members")
            .unwrap()
            .as_array()
            .unwrap()
            .clone();
        let shape = |index: usize, key: &str| members[index].get(key).unwrap().as_f64().unwrap();

        // 縦材は壁の下から上まで、横材は左から右まで。ただし交わるところは
        // 種別の勝ち負けで切る（柱は横架材に負けるので、上下の横架材の
        // あいだだけになる）。
        assert_eq!(members[0].get("label").unwrap().as_str(), Some("柱"));
        assert_eq!((shape(0, "x"), shape(0, "width")), (-52.5, 105.0));
        assert_eq!((shape(0, "y"), shape(0, "height")), (52.5, 2895.0));
        let beam = members
            .iter()
            .find(|member| member.get("direction").unwrap().as_str() == Some("horizontal"))
            .unwrap();
        assert_eq!(beam.get("width").unwrap().as_f64(), Some(910.0));
    }

    /// 軸組材は、位置と見付け幅まで壁の計算書に残す（釘の縦列と縁端距離が
    /// 何から決まったのかを、そのまま追えるように）。
    #[test]
    fn the_wall_report_lists_every_frame_member() {
        let report = only_wall(&wall_example_form());

        let value = labelled(&report, "inputs", "label")
            .into_iter()
            .find(|(label, _)| label.contains("軸組材"))
            .map(|(_, value)| value)
            .unwrap();
        assert_eq!(value, "縦材 3 本 ／ 横材 4 本（下の「軸組材」を参照）");

        let columns: Vec<String> = report
            .get("frameColumns")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|column| column.as_str().unwrap().to_string())
            .collect();
        assert_eq!(columns[1], "種別");
        assert_eq!(columns[3], "材心の位置 [mm]");

        let rows: Vec<(String, Vec<String>)> = report
            .get("frame")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                (
                    row.get("label").unwrap().as_str().unwrap().to_string(),
                    row.get("cells")
                        .unwrap()
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|cell| cell.as_str().unwrap().to_string())
                        .collect(),
                )
            })
            .collect();
        // 縦材（左から）→ 横材（下から）の順に並ぶ。
        assert_eq!(
            rows[0],
            (
                "柱".to_string(),
                vec![
                    "柱".to_string(),
                    "縦材".to_string(),
                    "X = 0".to_string(),
                    "105".to_string()
                ]
            )
        );
        assert_eq!(
            rows[1],
            (
                "間柱".to_string(),
                vec![
                    "間柱".to_string(),
                    "縦材".to_string(),
                    "X = 455".to_string(),
                    "30".to_string()
                ]
            )
        );
        assert_eq!(rows[3].0, "横架材");
        assert_eq!(rows[4].1[2], "Y = 1,820");
        assert_eq!(rows[4].0, "継目の材");
    }

    /// 面材のページにも、その面材でいちばん厳しい釘列の縁端距離を残す。
    #[test]
    fn every_panel_reports_the_member_its_nails_are_driven_into() {
        let report = compute_panel(&example_panel(), &example_wall(), 0).unwrap();
        let inputs = labelled(&report, "inputs", "label");
        // 910 × 610 を壁（W 910 × H 2900）の左下に張るので、左右の縁は柱・
        // 下の縁は横架材・上の縁は壁の中の継目（どれも見付け 105 で 42.5 mm）。
        // いちばん厳しいのは、材心に打つ @455 の間柱（45 / 2）。
        assert!(
            inputs.contains(&(
                "軸材の縁端距離（釘から軸組材の縁まで）".to_string(),
                "最小 22.5 mm（中間の縦材（X = 455 mm） ／ 間柱（見付け 45 mm））".to_string()
            )),
            "{inputs:?}"
        );
    }

    /// へりあきは、実際に置かれた釘の座標から測る。
    #[test]
    fn the_edge_clearance_is_measured_from_the_nails() {
        let panel = PanelInput {
            edge_distance: 12.0,
            ..example_panel()
        };
        let report = compute_panel(&panel, &example_wall(), 0).unwrap();
        let inputs = labelled(&report, "inputs", "label");
        assert!(inputs.contains(&(
            "へりあき（面材の縁から釘まで）".to_string(),
            "12 mm".to_string()
        )));
    }

    /// 上限を超えたら、検定の行に「超えている」と出す（計算は止めない）。
    ///
    /// 壁の幅だけを狭めるので、面材はその壁からはみ出す。配置の判定は
    /// それを NG にするが、上限の検定はそれとは別に働く。
    #[test]
    fn the_wall_report_flags_a_wall_over_the_upper_limit() {
        let mut data = wall_example_form();
        data.walls[0].width = 300.0;
        let report = only_wall(&data);

        assert_eq!(report.get("withinLimit"), Some(&Value::Bool(false)));
        let limit = report
            .get("checks")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .find(|check| check.get("label").unwrap().as_str().unwrap().contains("上限"))
            .unwrap()
            .clone();
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

    /// どの壁にも、壁の面材配列図と面材の一覧が付く（配置は必須）。
    #[test]
    fn a_wall_carries_the_arrangement_drawing() {
        let report = only_wall(&wall_example_form());

        let diagram = report.get("wallDiagram").unwrap();
        assert_eq!(diagram.get("wallWidth").unwrap().as_f64(), Some(910.0));
        assert_eq!(diagram.get("wallHeight").unwrap().as_f64(), Some(3000.0));
        // 片面張りなので、描く面は 1 つだけ。
        let sides = diagram.get("sides").unwrap().as_array().unwrap();
        assert_eq!(sides.len(), 1);
        assert_eq!(sides[0].get("label").unwrap().as_str(), Some("表面"));
        // 範囲は、壁と面材に軸組材を足したもの（面材はどれも壁の中に収まって
        // いるが、上端の横架材は材心が階高の位置なので、見付けの半分が外に
        // 出る）。図の縁で軸組材が切れないように、そこまで描く。
        assert_eq!(diagram.get("maxY").unwrap().as_f64(), Some(3052.5));
        assert_eq!(diagram.get("minX").unwrap().as_f64(), Some(-52.5));

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
        let report = only_wall(&wall_example_form());
        let panels = report.get("panelReports").unwrap().as_array().unwrap();

        assert!(labelled(&panels[1], "inputs", "label").contains(&(
            "壁内の配置".to_string(),
            "表面　左下 (0, 1,820) 〜 右上 (910, 2,730) mm".to_string()
        )));
    }

    /// 壁に収まらない面材は、図でも判定でも「はみ出し」として出す。
    #[test]
    fn a_panel_outside_the_wall_is_reported() {
        let mut data = wall_example_form();
        // 上段を 2500 まで持ち上げる（2500 + 910 > 3000）。
        data.walls[0].panels[1].bottom = 2500.0;
        data.walls[0].panels[1].top = 3410.0;

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
        let mut data = wall_example_form();
        // 上段を下段（0〜1820）に食い込ませる。
        data.walls[0].panels[1].bottom = 1000.0;
        data.walls[0].panels[1].top = 1910.0;

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
        let mut data = wall_example_form();
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

    /// 面材の並びは、配置と 1 対 1 で対応する（図に描けない面材は無い）。
    #[test]
    fn every_panel_appears_in_the_arrangement() {
        let report = only_wall(&wall_example_form());

        let rows = report.get("layout").unwrap().as_array().unwrap();
        let panels = report.get("panelReports").unwrap().as_array().unwrap();
        assert_eq!(rows.len(), panels.len());
        for (row, panel) in rows.iter().zip(panels) {
            assert_eq!(row.get("label"), panel.get("panelName"));
        }
    }

    /// 配置は保存する入力にそのまま残る。
    #[test]
    fn the_area_a_panel_covers_is_stored_as_typed() {
        let data = normalize(
            r#"{"walls": [{"studPitch": 455, "panels": [
                 {"side": "back", "left": 0, "bottom": "1820", "right": 910, "top": 2730}
               ]}]}"#,
        )
        .unwrap();

        let panel = &data.walls[0].panels[0];
        assert_eq!((panel.left, panel.bottom), (0.0, 1820.0));
        assert_eq!((panel.right, panel.top), (910.0, 2730.0));
        assert_eq!(panel.side, "back");

        let stored = panel.to_value();
        assert_eq!(stored.get("bottom").unwrap().as_f64(), Some(1820.0));
        assert_eq!(stored.get("side").unwrap().as_str(), Some("back"));
        // 壁の軸組材も、保存する入力に残る（前の版の間柱ピッチから読み替えた
        // ものも、軸組材の一覧として保存される）。
        let frame = data.walls[0].to_value().get("frame").unwrap().clone();
        let members = frame.as_array().unwrap();
        assert!(members.iter().all(|member| {
            member.get("direction").is_some()
                && member.get("position").is_some()
                && member.get("width").is_some()
        }));
    }

    #[test]
    fn a_non_numeric_position_is_refused() {
        let error = normalize(r#"{"walls": [{"panels": [{"top": "上のほう"}]}]}"#).unwrap_err();
        assert!(error.contains("面材の上端 Y"), "{error}");
    }

    /// 中間材の有無（せん断座屈の ξ）は、壁の中に立つ縦材で決まる。
    #[test]
    fn the_intermediate_stud_follows_the_frame_members() {
        let wall = |width: f64, frame: Frame| WallInput {
            width,
            frame,
            ..wall_example_form().walls.remove(0)
        };
        // 幅 910 に @455 なら、455 の位置に縦材が 1 本立つ。
        assert!(wall(910.0, Frame::from_stud_pitch(910.0, 3000.0, 455.0)).has_intermediate_stud());
        // 両端の柱しか無ければ、壁の中に縦材は入らない。
        assert!(!wall(455.0, Frame::from_stud_pitch(455.0, 3000.0, 455.0)).has_intermediate_stud());
        assert!(!wall(910.0, Frame::default()).has_intermediate_stud());
        // 等間隔でなくても、壁の中に 1 本でも立っていれば中間材あり。
        assert!(wall(
            910.0,
            Frame::new(vec![frame::Member::new(frame::Kind::Stud, 300.0, 45.0)])
        )
        .has_intermediate_stud());
    }



}
