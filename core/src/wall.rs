//! 面材張り大壁の剛性とせん断耐力の計算。
//!
//! グレー本『木造軸組工法住宅の許容応力度設計』
//!   3.3 面材張り大壁の詳細計算法（式 3.3.1〜3.3.7）に準拠する。
//!
//! 釘配列諸定数 Ixy・Zxy・Cxy（3.2 節、nail_array モジュール）を入力として
//! 受け取り、面材 1 枚ごとに回転剛性 K0・降伏モーメント My・終局モーメント
//! Mu・塑性率 μ を求め、壁全体の面内せん断剛性 K と許容せん断耐力 Pa に
//! まとめる。
//!
//! ```text
//!   K0 = Aw / (1/(Ixy・k) + 1/(GB・t))                  … 式 3.3.3 / 3.3.4
//!   My = Aw × Zxy × ΔPv                                 … 式 3.3.5
//!   Mu = Cxy × My                                       … 式 3.3.6
//!   μ  = (δu・GB・t + δv・Ixy・k) / (δv・(GB・t + Ixy・k)) … 式 3.3.7
//!   K  = K0 / H                                         … 式 3.3.2
//!   Pa = min{ My, K0/150, 0.2√(2μ−1)×Mu } / H           … 式 3.3.1
//! ```
//!
//! 壁が複数枚の面材で構成される場合、K0・My・Mu は面材ごとの値の和、塑性率
//! μ は面材ごとの値の最小値とする（グレー本 3.3(3) の計算例の手順 4)〜8)）。
//!
//! # このモジュールが受け持たない検討
//!
//! 3.3【解説】の面材のせん断破壊・せん断座屈の検定（式 3.3.8〜3.3.11）は
//! ここには入れていない。グレー本自身が「表 3.2.1 と表 3.3.1 の全ての
//! 組合せに対しては、下記検定式により検討を行い、面材のせん断破壊とせん断
//! 座屈が生じないことを確認している」と述べており、3.3(3) の計算例でも
//! 検定は行っていないため。適用範囲（3.3(1)）の①許容せん断耐力の上限
//! 13.72 kN/m だけは、数値で機械的に確かめられるのでここで判定する。

use crate::nail_array::Constants;

/// 適用範囲（3.3(1)①）の許容せん断耐力の上限 [kN/m]（= 壁倍率 7 倍 × 1.96）。
pub const ALLOWABLE_SHEAR_LIMIT: f64 = 13.72;

/// 変形角の逆数。K0/150 は変形角 1/150 [rad] のときのモーメント（式 3.3.1）。
const DRIFT_DENOMINATOR: f64 = 150.0;

/// 入力が計算できないときのエラー。文面はそのまま利用者に見せられる日本語。
#[derive(Debug, Clone, PartialEq)]
pub struct WallError(pub String);

impl WallError {
    fn new(message: &str) -> WallError {
        WallError(message.to_string())
    }
}

/// 面材釘 1 本あたりの一面せん断特性（完全弾塑性関係、図 3.3.4）。
///
/// グレー本 表 3.3.1 の値を使うか、4.5 の試験で取得した値を使う。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NailShear {
    /// 剛性 k [kN/mm]。
    pub k: f64,
    /// 降伏点変位 δv [mm]。
    pub delta_v: f64,
    /// 終局変位 δu [mm]。
    pub delta_u: f64,
    /// 降伏耐力 ΔPv [kN]。
    pub delta_pv: f64,
}

/// 面材そのものの諸元。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sheathing {
    /// 厚さ t [mm]。
    pub thickness: f64,
    /// せん断弾性係数 GB [kN/mm²]。
    pub shear_modulus: f64,
}

impl Sheathing {
    /// 面材のせん断剛性 GB・t [kN/mm]（式 3.3.4 の第 2 項の分母）。
    pub fn shear_rigidity(self) -> f64 {
        self.shear_modulus * self.thickness
    }
}

/// 壁を構成する面材 1 枚分の入力（面積と釘配列諸定数）。
#[derive(Debug, Clone, PartialEq)]
pub struct PanelSpec {
    /// 画面・計算書で面材を指し示す名前（釘配列パターン名）。
    pub label: String,
    /// 面材の面積 Aw [mm²]。
    pub area: f64,
    /// 単位面積あたりの釘配列二次モーメント Ixy [mm²/mm²]（式 3.2.1）。
    pub ixy: f64,
    /// 単位面積あたりの釘配列係数 Zxy [mm/mm²]（式 3.2.3）。
    pub zxy: f64,
    /// 釘配列降伏終局比 Cxy（式 3.2.5）。
    pub cxy: f64,
}

impl PanelSpec {
    /// 釘配列諸定数の計算結果（3.2 節）から、そのまま 1 枚分の入力を作る。
    pub fn from_constants(label: &str, constants: &Constants) -> PanelSpec {
        PanelSpec {
            label: label.to_string(),
            area: constants.panel_area,
            ixy: constants.ixy,
            zxy: constants.zxy,
            cxy: constants.cxy,
        }
    }
}

/// 面材 1 枚分の計算結果。
#[derive(Debug, Clone, PartialEq)]
pub struct PanelResult {
    pub spec: PanelSpec,
    /// 回転剛性 K0 [kN·mm/rad]（式 3.3.3 / 3.3.4）。
    pub k0: f64,
    /// 降伏モーメント My [kN·mm]（式 3.3.5）。
    pub my: f64,
    /// 終局モーメント Mu [kN·mm]（式 3.3.6）。
    pub mu: f64,
    /// 塑性率 μ（式 3.3.7）。
    pub ductility: f64,
}

/// 許容せん断耐力 Pa を決めた項（式 3.3.1 の min{} のどれか）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Governing {
    /// 降伏モーメント My。
    Yield,
    /// 変形角 1/150 時のモーメント K0/150。
    Drift,
    /// 終局時 0.2√(2μ−1)×Mu。
    Ultimate,
}

impl Governing {
    pub fn id(self) -> &'static str {
        match self {
            Governing::Yield => "yield",
            Governing::Drift => "drift",
            Governing::Ultimate => "ultimate",
        }
    }

    /// 画面・計算書に出す短い説明。
    pub fn label(self) -> &'static str {
        match self {
            Governing::Yield => "降伏モーメント My",
            Governing::Drift => "変形角 1/150 時のモーメント K0/150",
            Governing::Ultimate => "終局時のモーメント 0.2√(2μ−1)×Mu",
        }
    }
}

/// 壁 1 枚分の入力。
#[derive(Debug, Clone, PartialEq)]
pub struct Wall {
    /// 階高 H [mm]。
    pub height: f64,
    /// 壁の幅 W [mm]（許容せん断耐力を長さあたりに直すのに使う）。
    pub width: f64,
    pub sheathing: Sheathing,
    pub nail: NailShear,
    /// 壁を構成する面材（1 枚以上）。
    pub panels: Vec<PanelSpec>,
}

/// 壁 1 枚分の計算結果。
#[derive(Debug, Clone, PartialEq)]
pub struct WallResult {
    pub panels: Vec<PanelResult>,
    /// 壁全体の回転剛性 K0 [kN·mm/rad]（面材ごとの和）。
    pub k0: f64,
    /// 面内せん断剛性 K [kN/rad]（式 3.3.2）。
    pub k: f64,
    /// 変形角 1/150 時のモーメント K0/150 [kN·mm]。
    pub m150: f64,
    /// 壁全体の降伏モーメント My [kN·mm]（面材ごとの和）。
    pub my: f64,
    /// 壁全体の終局モーメント Mu [kN·mm]（面材ごとの和）。
    pub mu: f64,
    /// 壁全体の塑性率 μ（面材ごとの最小値）。
    pub ductility: f64,
    /// 終局時のモーメント 0.2√(2μ−1)×Mu [kN·mm]。
    pub ultimate_moment: f64,
    /// Pa を決めた項。
    pub governing: Governing,
    /// 許容せん断耐力 Pa [kN]（式 3.3.1）。
    pub pa: f64,
    /// 壁長さあたりの許容せん断耐力 ΔPa = Pa / W [kN/m]。
    pub delta_pa: f64,
    /// ΔPa が適用範囲の上限 13.72 kN/m 以下か（3.3(1)①）。
    pub within_limit: bool,
}

// --- 式ごとの計算 ------------------------------------------------------------

/// 面材 1 枚の回転剛性 K0 を求める（式 3.3.3 と式 3.3.4 をまとめたもの）。
///
/// K0 = Aw / ( 1/(Ixy・k) + 1/(GB・t) )   [kN·mm/rad]
///
/// 釘のせん断変形による回転剛性と、面材そのもののせん断変形による回転剛性を
/// 直列バネとして足し合わせた形になっている。
pub fn rotational_stiffness(
    area: f64,
    ixy: f64,
    nail_stiffness: f64,
    shear_rigidity: f64,
) -> Result<f64, WallError> {
    let nails = ixy * nail_stiffness;
    if !(nails > 0.0) {
        return Err(WallError::new(
            "Ixy × k が 0 以下です。釘配列と釘の剛性 k を確かめてください。",
        ));
    }
    if !(shear_rigidity > 0.0) {
        return Err(WallError::new(
            "GB × t が 0 以下です。面材のせん断弾性係数 GB と厚さ t を確かめてください。",
        ));
    }
    Ok(area / (1.0 / nails + 1.0 / shear_rigidity))
}

/// 面材 1 枚の降伏モーメント My を求める（式 3.3.5）。
///
/// My = Aw × Zxy × ΔPv   [kN·mm]
pub fn yield_moment(area: f64, zxy: f64, delta_pv: f64) -> f64 {
    area * zxy * delta_pv
}

/// 面材 1 枚の終局モーメント Mu を求める（式 3.3.6）。
///
/// Mu = Cxy × My   [kN·mm]
pub fn ultimate_moment(cxy: f64, yield_moment: f64) -> f64 {
    cxy * yield_moment
}

/// 釘で決まる面材壁の塑性率 μ を求める（式 3.3.7）。
///
/// μ = (δu・GB・t + δv・Ixy・k) / ( δv・(GB・t + Ixy・k) )
///
/// 釘 1 本の塑性率 δu/δv に、面材自身のせん断変形分（降伏時にも終局時にも
/// 等しく加わる）を織り込んだもの（式 3.3.15 の変形）。
pub fn ductility_factor(
    nail: NailShear,
    ixy: f64,
    shear_rigidity: f64,
) -> Result<f64, WallError> {
    let nails = ixy * nail.k;
    let denominator = nail.delta_v * (shear_rigidity + nails);
    if !(denominator > 0.0) {
        return Err(WallError::new(
            "塑性率 μ の分母が 0 以下です。δv・GB・t・Ixy・k を確かめてください。",
        ));
    }
    Ok((nail.delta_u * shear_rigidity + nail.delta_v * nails) / denominator)
}

/// 面内せん断剛性 K を求める（式 3.3.2）。
///
/// K = K0 / H   [kN/rad]
pub fn shear_stiffness(k0: f64, height: f64) -> Result<f64, WallError> {
    if !(height > 0.0) {
        return Err(WallError::new("階高 H は正の数値である必要があります。"));
    }
    Ok(k0 / height)
}

/// 終局時のモーメント 0.2√(2μ−1)×Mu を求める（式 3.3.1 の第 3 項）。
pub fn ultimate_term(ductility: f64, mu: f64) -> Result<f64, WallError> {
    let inside = 2.0 * ductility - 1.0;
    if inside < 0.0 {
        return Err(WallError::new(
            "塑性率 μ が 0.5 未満のため 0.2√(2μ−1) を計算できません。δu ≧ δv を確かめてください。",
        ));
    }
    Ok(0.2 * inside.sqrt() * mu)
}

// --- 入力の検証 --------------------------------------------------------------

fn positive(value: f64, label: &str) -> Result<(), WallError> {
    if !value.is_finite() || value <= 0.0 {
        return Err(WallError(format!(
            "{label}には正の数値を入力してください。"
        )));
    }
    Ok(())
}

/// 壁の入力を検証する。
pub fn validate_input(wall: &Wall) -> Result<(), WallError> {
    positive(wall.height, "階高 H")?;
    positive(wall.width, "壁の幅 W")?;
    positive(wall.sheathing.thickness, "面材の厚さ t")?;
    positive(wall.sheathing.shear_modulus, "面材のせん断弾性係数 GB")?;
    positive(wall.nail.k, "釘 1 本あたりのせん断剛性 k")?;
    positive(wall.nail.delta_v, "釘の降伏点変位 δv")?;
    positive(wall.nail.delta_u, "釘の終局変位 δu")?;
    positive(wall.nail.delta_pv, "釘の降伏耐力 ΔPv")?;
    if wall.nail.delta_u < wall.nail.delta_v {
        return Err(WallError::new(
            "釘の終局変位 δu は降伏点変位 δv 以上である必要があります。",
        ));
    }
    if wall.panels.is_empty() {
        return Err(WallError::new(
            "壁を構成する面材がありません。釘配列パターンを 1 枚以上選んでください。",
        ));
    }
    for panel in &wall.panels {
        positive(panel.area, &format!("「{}」の面材面積 Aw", panel.label))?;
    }
    Ok(())
}

// --- 一括計算 ----------------------------------------------------------------

/// 壁の剛性とせん断耐力を求める（グレー本 3.3(3) の計算例の手順 4)〜10) に対応）。
pub fn compute(wall: &Wall) -> Result<WallResult, WallError> {
    validate_input(wall)?;

    let shear_rigidity = wall.sheathing.shear_rigidity();

    // 4)〜8) 面材ごとに K0・My・Mu・μ を求める。
    let mut panels = Vec::with_capacity(wall.panels.len());
    for spec in &wall.panels {
        let k0 = rotational_stiffness(spec.area, spec.ixy, wall.nail.k, shear_rigidity)?;
        let my = yield_moment(spec.area, spec.zxy, wall.nail.delta_pv);
        panels.push(PanelResult {
            k0,
            my,
            mu: ultimate_moment(spec.cxy, my),
            ductility: ductility_factor(wall.nail, spec.ixy, shear_rigidity)?,
            spec: spec.clone(),
        });
    }

    // 壁全体へまとめる。K0・My・Mu は和、塑性率 μ は最小値。
    let k0: f64 = panels.iter().map(|panel| panel.k0).sum();
    let my: f64 = panels.iter().map(|panel| panel.my).sum();
    let mu: f64 = panels.iter().map(|panel| panel.mu).sum();
    let ductility = panels
        .iter()
        .map(|panel| panel.ductility)
        .fold(f64::INFINITY, f64::min);

    // 5) 変形角 1/150 時のモーメント、9) 終局時のモーメント。
    let m150 = k0 / DRIFT_DENOMINATOR;
    let ultimate_moment = ultimate_term(ductility, mu)?;

    // 10) 許容せん断耐力 Pa（式 3.3.1）。
    let candidates = [
        (Governing::Yield, my),
        (Governing::Drift, m150),
        (Governing::Ultimate, ultimate_moment),
    ];
    let (governing, moment) = candidates
        .iter()
        .copied()
        .fold(candidates[0], |lowest, candidate| {
            if candidate.1 < lowest.1 {
                candidate
            } else {
                lowest
            }
        });

    let pa = moment / wall.height;
    // 壁の幅は mm、ΔPa は kN/m なので 1000 倍して長さの単位をそろえる。
    let delta_pa = pa * 1000.0 / wall.width;

    Ok(WallResult {
        k: shear_stiffness(k0, wall.height)?,
        panels,
        k0,
        m150,
        my,
        mu,
        ductility,
        ultimate_moment,
        governing,
        pa,
        delta_pa,
        within_limit: delta_pa <= ALLOWABLE_SHEAR_LIMIT,
    })
}

// --- グレー本 表 3.3.1「面材釘 1 本あたりの一面せん断の数値」 ----------------

/// 表 3.3.1 の 1 行（面材と釘の組合せ）と、表の脚注にある面材のせん断弾性係数。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Material {
    pub id: &'static str,
    /// 面材の種類（「構造用合板」など）。
    pub panel: &'static str,
    /// 面材の厚さ t [mm]。
    pub thickness: f64,
    /// 釘の種類（「太め鉄丸釘(CN 釘)65」など）。
    pub nail_label: &'static str,
    pub nail: NailShear,
    /// 面材のせん断弾性係数 GB [kN/mm²]（表 3.3.1 の脚注）。
    pub shear_modulus: f64,
}

impl Material {
    pub fn label(&self) -> String {
        format!(
            "{} {}mm + {}",
            self.panel,
            crate::format::format_int(self.thickness),
            self.nail_label
        )
    }

    pub fn sheathing(&self) -> Sheathing {
        Sheathing {
            thickness: self.thickness,
            shear_modulus: self.shear_modulus,
        }
    }
}

/// 日本農林規格の構造用合板のせん断弾性係数 GB [kN/mm²]。
const PLYWOOD_G: f64 = 0.40;
/// JIS A 5905 の構造用 MDF のせん断弾性係数 GB [kN/mm²]。
const MDF_G: f64 = 0.75;
/// JIS A 5908 の構造用パーティクルボードのせん断弾性係数 GB [kN/mm²]。
const PARTICLE_BOARD_G: f64 = 1.00;

const fn material(
    id: &'static str,
    panel: &'static str,
    thickness: f64,
    nail_label: &'static str,
    k: f64,
    delta_v: f64,
    delta_u: f64,
    delta_pv: f64,
    shear_modulus: f64,
) -> Material {
    Material {
        id,
        panel,
        thickness,
        nail_label,
        nail: NailShear {
            k,
            delta_v,
            delta_u,
            delta_pv,
        },
        shear_modulus,
    }
}

/// 表 3.3.1 に載っている面材と釘の組合せ。
///
/// 表は「構造用合板 24mm、または、28mm」を 1 行にまとめているが、厚さ t は
/// GB・t として計算に効くので、24mm と 28mm を別の組合せとして持つ。
///
/// 構造用合板 12mm の鉄丸釘 N-65 と太め鉄丸釘(CN 釘)65 は、**印刷された表の
/// 値が入れ替わっている**（正誤表による訂正がある）。ここは訂正後の値を持つ:
/// 同じ長さなら太め鉄丸釘(CN 釘)のほうが軸径が太く、50 の行（N-50 は
/// k = 0.430・ΔPv = 0.91、CN 釘 50 は k = 0.467・ΔPv = 0.94）と同じく
/// 剛性・耐力とも大きくなる側が CN 釘である。
/// なお 3.3(3) の計算例は「CN65」と書きながら訂正前の値
/// （k = 0.483、δv = 2.3、ΔPv = 1.13 ＝ 訂正後の N-65）で計算している。
/// 計算例をなぞるときは、一覧から選ぶのではなく数値を直接入力する。
const TABLE: &[Material] = &[
    material("plywood12-n50", "構造用合板", 12.0, "鉄丸釘 N-50", 0.430, 2.1, 17.1, 0.91, PLYWOOD_G),
    material("plywood12-n65", "構造用合板", 12.0, "鉄丸釘 N-65", 0.483, 2.3, 17.0, 1.13, PLYWOOD_G),
    material("plywood12-cn50", "構造用合板", 12.0, "太め鉄丸釘(CN 釘)50", 0.467, 2.0, 17.1, 0.94, PLYWOOD_G),
    material("plywood12-cn65", "構造用合板", 12.0, "太め鉄丸釘(CN 釘)65", 0.605, 2.1, 17.0, 1.29, PLYWOOD_G),
    material("plywood24-n75", "構造用合板", 24.0, "鉄丸釘 N-75", 0.651, 2.5, 17.1, 1.62, PLYWOOD_G),
    material("plywood24-cn65", "構造用合板", 24.0, "太め鉄丸釘(CN 釘)65", 0.878, 1.5, 13.2, 1.31, PLYWOOD_G),
    material("plywood24-cn75", "構造用合板", 24.0, "太め鉄丸釘(CN 釘)75", 1.013, 1.8, 21.4, 1.85, PLYWOOD_G),
    material("plywood28-n75", "構造用合板", 28.0, "鉄丸釘 N-75", 0.651, 2.5, 17.1, 1.62, PLYWOOD_G),
    material("plywood28-cn65", "構造用合板", 28.0, "太め鉄丸釘(CN 釘)65", 0.878, 1.5, 13.2, 1.31, PLYWOOD_G),
    material("plywood28-cn75", "構造用合板", 28.0, "太め鉄丸釘(CN 釘)75", 1.013, 1.8, 21.4, 1.85, PLYWOOD_G),
    material("mdf9-cn50", "構造用 MDF", 9.0, "太め鉄丸釘(CN 釘)50", 0.636, 1.5, 17.1, 0.93, MDF_G),
    material("particleboard9-cn50", "構造用パーティクルボード", 9.0, "太め鉄丸釘(CN 釘)50", 0.732, 1.2, 15.6, 0.85, PARTICLE_BOARD_G),
];

/// 表 3.3.1 の組合せを、表と同じ並びで返す。
pub fn materials() -> &'static [Material] {
    TABLE
}

/// id から組合せを引く（知らない id なら None）。
pub fn find_material(id: &str) -> Option<&'static Material> {
    TABLE.iter().find(|material| material.id == id)
}

#[cfg(test)]
mod tests {
    //! テストの構成:
    //!   1. グレー本 3.3(3) の計算例（図 3.3.10）を再現する統合テスト。
    //!   2. 各式単位のユニットテスト。
    //!   3. 入力検証・エッジケース。
    //!   4. 表 3.3.1 の一覧。

    use super::*;
    use crate::{nail_array, presets};

    fn close(actual: f64, expected: f64, tolerance: f64) {
        assert!(
            (actual - expected).abs() <= tolerance,
            "{actual} != {expected} (±{tolerance})"
        );
    }

    // --- 1. グレー本 3.3(3) の計算例（図 3.3.10） ----------------------------
    //
    // 階高 H = 3000、壁幅 W = 910 の準耐力壁形式の面材張り大壁。
    //   面材: 構造用合板 JAS1 級 t = 12mm、GB = 0.40 kN/mm²
    //   釘  : CN65 @75mm、四周打ち（k = 0.483、δv = 2.3、δu = 17.0、ΔPv = 1.13）
    //   下側の面材 1820 × 910（表 3.2.1 の「1820×910 縦置・日型 @455 / 釘 @75」）
    //   上側の面材  910 × 910（表 3.2.1 の「910×910 縦置・ロ型 @455 / 釘 @75」）
    //
    // 釘配列諸定数は表 3.2.1 の丸めた値（下: Ixy 4.99 / Zxy 0.0124 / Cxy 1.18、
    // 上: 3.84 / 0.0122 / 1.22）ではなく、presets の釘座標から計算した値を
    // 使う。本の表は小数 2〜4 桁に丸めてあるので、結果も本の表示値からその分
    // だけずれる（Pa = 8.39 kN に対して本は 8.37 kN）。

    /// 計算例の釘 1 本あたりの一面せん断データ。
    ///
    /// 本文は「表 3.3.1 より、構造用合板 12〔mm〕＋ CN65」としているが、表の
    /// CN65 と N-65 は入れ替わっている（TABLE のコメント参照）。ここは本が
    /// 実際に計算に使った数値をそのまま置く。
    const EXAMPLE_NAIL: NailShear = NailShear {
        k: 0.483,
        delta_v: 2.3,
        delta_u: 17.0,
        delta_pv: 1.13,
    };

    const EXAMPLE_SHEATHING: Sheathing = Sheathing {
        thickness: 12.0,
        shear_modulus: 0.40,
    };

    /// 表 3.2.1 の配列 id から、計算例の面材 1 枚分の入力を作る。
    fn example_panel(id: &str) -> PanelSpec {
        let preset = presets::find(id).expect("表 3.2.1 にある配列");
        let constants =
            nail_array::compute(&preset.nails(), preset.width * preset.height).unwrap();
        PanelSpec::from_constants(&preset.label(), &constants)
    }

    fn example() -> WallResult {
        compute(&Wall {
            height: 3000.0,
            width: 910.0,
            sheathing: EXAMPLE_SHEATHING,
            nail: EXAMPLE_NAIL,
            panels: vec![
                example_panel("910x1820-s455-n75-hi"),
                example_panel("910x910-s455-n75-ro"),
            ],
        })
        .unwrap()
    }

    /// 手順 3) 釘配列諸定数は表 3.2.1 の値（丸め）とほぼ同じ。
    #[test]
    fn example_panels_match_the_book_table() {
        let lower = example_panel("910x1820-s455-n75-hi");
        close(lower.area, 1_656_200.0, 0.0);
        close(lower.ixy, 4.99, 0.02);
        close(lower.zxy, 0.0124, 0.00005);
        close(lower.cxy, 1.18, 0.005);

        let upper = example_panel("910x910-s455-n75-ro");
        close(upper.area, 828_100.0, 0.0);
        close(upper.ixy, 3.84, 0.02);
        close(upper.zxy, 0.0122, 0.0001);
        close(upper.cxy, 1.22, 0.01);
    }

    /// 手順 4) 面材ごとの回転剛性 K0（本: 下 2657395、上 1107829、計 3765224）。
    #[test]
    fn example_rotational_stiffness() {
        let example = example();
        close(example.panels[0].k0, 2_657_395.0, 8_000.0);
        close(example.panels[1].k0, 1_107_829.0, 5_000.0);
        close(example.k0, 3_765_224.0, 12_000.0);
    }

    /// 手順 5) 変形角 1/150 時のモーメント K0/150（本: 25101 kN·mm）。
    #[test]
    fn example_moment_at_one_over_150() {
        close(example().m150, 25_101.0, 80.0);
    }

    /// 手順 6) 降伏モーメント My（本: 下 23207、上 11416、計 34623 kN·mm）。
    #[test]
    fn example_yield_moment() {
        let example = example();
        close(example.panels[0].my, 23_207.0, 60.0);
        close(example.panels[1].my, 11_416.0, 60.0);
        close(example.my, 34_623.0, 100.0);
    }

    /// 手順 7) 終局モーメント Mu（本: 下 27384、上 13928、計 41312 kN·mm）。
    #[test]
    fn example_ultimate_moment() {
        let example = example();
        close(example.panels[0].mu, 27_384.0, 60.0);
        close(example.panels[1].mu, 13_928.0, 60.0);
        close(example.mu, 41_312.0, 100.0);
    }

    /// 手順 8) 塑性率 μ（本: 下 5.25、上 5.61 → 小さい方の 5.25）。
    #[test]
    fn example_ductility_takes_the_smallest_panel() {
        let example = example();
        close(example.panels[0].ductility, 5.25, 0.01);
        close(example.panels[1].ductility, 5.61, 0.01);
        close(example.ductility, 5.25, 0.01);
        assert_eq!(example.ductility, example.panels[0].ductility);
    }

    /// 手順 9) 0.2√(2μ−1)×Mu（本: 25466 kN·mm）。
    #[test]
    fn example_ultimate_term() {
        close(example().ultimate_moment, 25_466.0, 80.0);
    }

    /// 手順 10) 許容せん断耐力 Pa（本: 8.37 kN）と ΔPa（本: 9.20 kN/m）。
    ///
    /// min{ My 34623, K0/150 25101, 0.2√(2μ−1)Mu 25466 } は K0/150 なので、
    /// この壁は変形角 1/150 で決まる。
    #[test]
    fn example_allowable_shear() {
        let example = example();
        assert_eq!(example.governing, Governing::Drift);
        close(example.pa, 8.37, 0.03);
        close(example.delta_pa, 9.20, 0.03);
        assert!(example.within_limit);
    }

    /// 面内せん断剛性 K = K0/H（式 3.3.2）。
    #[test]
    fn example_shear_stiffness() {
        let example = example();
        close(example.k, example.k0 / 3000.0, 1e-9);
        close(example.k, 1255.0, 5.0);
    }

    // --- 2. 各式単位のユニットテスト ----------------------------------------

    /// 式 3.3.3 / 3.3.4。本の下側の面材の数値をそのまま入れる。
    #[test]
    fn rotational_stiffness_is_the_series_of_two_springs() {
        let k0 = rotational_stiffness(1_656_200.0, 4.99, 0.483, 0.40 * 12.0).unwrap();
        close(k0, 2_657_395.0, 40.0);
        // 直列バネなので、どちらか一方だけの剛性より必ず小さい。
        assert!(k0 < 1_656_200.0 * 4.99 * 0.483);
        assert!(k0 < 1_656_200.0 * 0.40 * 12.0);
    }

    #[test]
    fn rotational_stiffness_rejects_a_zero_spring() {
        assert!(rotational_stiffness(1000.0, 0.0, 0.483, 4.8).is_err());
        assert!(rotational_stiffness(1000.0, 4.99, 0.483, 0.0).is_err());
    }

    /// 式 3.3.5 / 3.3.6。
    #[test]
    fn yield_and_ultimate_moments() {
        let my = yield_moment(1_656_200.0, 0.0124, 1.13);
        close(my, 23_207.0, 1.0);
        close(ultimate_moment(1.18, my), 27_384.0, 2.0);
    }

    /// 式 3.3.7。本の下側の面材（μ = 5.25）と上側の面材（μ = 5.61）。
    #[test]
    fn ductility_factor_matches_the_book() {
        let rigidity = 0.40 * 12.0;
        close(ductility_factor(EXAMPLE_NAIL, 4.99, rigidity).unwrap(), 5.25, 0.005);
        close(ductility_factor(EXAMPLE_NAIL, 3.84, rigidity).unwrap(), 5.61, 0.005);
    }

    /// 面材のせん断変形が無い（GB・t → ∞）極限では、釘そのものの塑性率
    /// δu/δv に一致する。
    #[test]
    fn ductility_factor_approaches_the_nail_ratio_for_a_rigid_panel() {
        let ratio = EXAMPLE_NAIL.delta_u / EXAMPLE_NAIL.delta_v;
        let stiff = ductility_factor(EXAMPLE_NAIL, 4.99, 1e12).unwrap();
        close(stiff, ratio, 1e-6);
        // 面材が柔らかいほど、壁としての塑性率は小さくなる。
        assert!(ductility_factor(EXAMPLE_NAIL, 4.99, 4.8).unwrap() < ratio);
    }

    /// 式 3.3.2。
    #[test]
    fn shear_stiffness_divides_by_the_storey_height() {
        close(shear_stiffness(3_765_224.0, 3000.0).unwrap(), 1255.07, 0.01);
        assert!(shear_stiffness(1.0, 0.0).is_err());
    }

    /// 式 3.3.1 の第 3 項。μ = 5.25、Mu = 41312 → 25466。
    #[test]
    fn ultimate_term_matches_the_book() {
        close(ultimate_term(5.25, 41_312.0).unwrap(), 25_466.0, 3.0);
        // μ = 0.5 のとき 0（√0）。それ未満は計算できない。
        close(ultimate_term(0.5, 100.0).unwrap(), 0.0, 1e-12);
        assert!(ultimate_term(0.4, 100.0).is_err());
    }

    // --- 3. 入力検証・エッジケース ------------------------------------------

    fn wall_with(panels: Vec<PanelSpec>) -> Wall {
        Wall {
            height: 3000.0,
            width: 910.0,
            sheathing: EXAMPLE_SHEATHING,
            nail: EXAMPLE_NAIL,
            panels,
        }
    }

    fn one_panel() -> Vec<PanelSpec> {
        vec![PanelSpec {
            label: "面材".to_string(),
            area: 1_656_200.0,
            ixy: 4.99,
            zxy: 0.0124,
            cxy: 1.18,
        }]
    }

    #[test]
    fn rejects_non_positive_dimensions_and_nail_data() {
        let cases: [(&dyn Fn(&mut Wall), &str); 6] = [
            (&|wall: &mut Wall| wall.height = 0.0, "階高 H"),
            (&|wall: &mut Wall| wall.width = -1.0, "壁の幅 W"),
            (&|wall: &mut Wall| wall.sheathing.thickness = 0.0, "面材の厚さ t"),
            (&|wall: &mut Wall| wall.sheathing.shear_modulus = 0.0, "せん断弾性係数 GB"),
            (&|wall: &mut Wall| wall.nail.k = 0.0, "せん断剛性 k"),
            (&|wall: &mut Wall| wall.nail.delta_pv = 0.0, "降伏耐力 ΔPv"),
        ];
        for (break_it, expected) in cases {
            let mut wall = wall_with(one_panel());
            break_it(&mut wall);
            let error = compute(&wall).unwrap_err().0;
            assert!(error.contains(expected), "{error} should mention {expected}");
        }
    }

    #[test]
    fn rejects_an_ultimate_displacement_below_the_yield_one() {
        let mut wall = wall_with(one_panel());
        wall.nail.delta_u = 1.0;
        assert!(compute(&wall).unwrap_err().0.contains("δu"));
    }

    #[test]
    fn rejects_a_wall_without_panels() {
        let error = compute(&wall_with(Vec::new())).unwrap_err().0;
        assert!(error.contains("面材がありません"), "{error}");
    }

    #[test]
    fn names_the_panel_whose_area_is_not_positive() {
        let mut panels = one_panel();
        panels[0].label = "南面 下".to_string();
        panels[0].area = 0.0;
        let error = compute(&wall_with(panels)).unwrap_err().0;
        assert!(error.contains("「南面 下」"), "{error}");
    }

    /// 面材を 1 枚にすると、その 1 枚の値がそのまま壁全体の値になる。
    #[test]
    fn a_single_panel_wall_is_that_panel() {
        let result = compute(&wall_with(one_panel())).unwrap();
        assert_eq!(result.k0, result.panels[0].k0);
        assert_eq!(result.my, result.panels[0].my);
        assert_eq!(result.mu, result.panels[0].mu);
        assert_eq!(result.ductility, result.panels[0].ductility);
    }

    /// 面材を増やせば K0・My・Mu は和になる（同じ面材を 2 枚なら 2 倍）。
    #[test]
    fn panels_add_up() {
        let one = compute(&wall_with(one_panel())).unwrap();
        let two = compute(&wall_with([one_panel(), one_panel()].concat())).unwrap();
        close(two.k0, one.k0 * 2.0, 1e-6);
        close(two.my, one.my * 2.0, 1e-9);
        close(two.mu, one.mu * 2.0, 1e-9);
        // 同じ面材なので塑性率は変わらない。
        close(two.ductility, one.ductility, 1e-12);
    }

    /// 許容せん断耐力を決める項は 3 つのうち最小のもの。
    #[test]
    fn the_governing_term_is_the_smallest_of_the_three() {
        let result = compute(&wall_with(one_panel())).unwrap();
        let smallest = result
            .my
            .min(result.m150)
            .min(result.ultimate_moment);
        close(result.pa * 3000.0, smallest, 1e-9);
        assert_eq!(
            result.governing,
            match smallest {
                value if value == result.my => Governing::Yield,
                value if value == result.m150 => Governing::Drift,
                _ => Governing::Ultimate,
            }
        );
    }

    /// 適用範囲（3.3(1)①）の上限 13.72 kN/m を超えたら知らせる。
    #[test]
    fn reports_when_the_wall_exceeds_the_upper_limit() {
        // 壁を細くすれば、同じ Pa でも長さあたりの耐力は大きくなる。
        let mut wall = wall_with(one_panel());
        wall.width = 300.0;
        let result = compute(&wall).unwrap();
        assert!(result.delta_pa > ALLOWABLE_SHEAR_LIMIT);
        assert!(!result.within_limit);
    }

    // --- 4. 表 3.3.1 の一覧 --------------------------------------------------

    #[test]
    fn the_material_table_covers_every_combination_of_the_book() {
        let materials = materials();
        assert_eq!(materials.len(), 12);
        let mut ids: Vec<&str> = materials.iter().map(|material| material.id).collect();
        let count = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), count);
        for material in materials {
            assert_eq!(find_material(material.id).unwrap().id, material.id);
            assert!(material.nail.delta_u > material.nail.delta_v);
            assert!(material.nail.k > 0.0 && material.nail.delta_pv > 0.0);
        }
        assert_eq!(find_material("なにか"), None);
    }

    /// 同じ長さなら、太め鉄丸釘(CN 釘)のほうが剛性・耐力とも大きい
    /// （12mm の N-65 / CN65 が入れ替わっている正誤を、訂正後で持っている）。
    #[test]
    fn the_thicker_nail_is_always_the_stronger_one() {
        for (thin, thick) in [
            ("plywood12-n50", "plywood12-cn50"),
            ("plywood12-n65", "plywood12-cn65"),
        ] {
            let thin = find_material(thin).unwrap();
            let thick = find_material(thick).unwrap();
            assert!(thick.nail.k > thin.nail.k, "{}", thick.id);
            assert!(thick.nail.delta_pv > thin.nail.delta_pv, "{}", thick.id);
        }
    }

    #[test]
    fn materials_carry_the_shear_modulus_of_their_panel() {
        assert_eq!(find_material("plywood12-n50").unwrap().shear_modulus, 0.40);
        assert_eq!(find_material("mdf9-cn50").unwrap().shear_modulus, 0.75);
        assert_eq!(
            find_material("particleboard9-cn50").unwrap().shear_modulus,
            1.00
        );
    }

    #[test]
    fn material_labels_name_the_panel_thickness_and_nail() {
        assert_eq!(
            find_material("plywood12-cn65").unwrap().label(),
            "構造用合板 12mm + 太め鉄丸釘(CN 釘)65"
        );
        assert_eq!(
            find_material("plywood28-cn75").unwrap().sheathing().shear_rigidity(),
            0.40 * 28.0
        );
    }
}
