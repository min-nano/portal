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
//! あわせて、3.3【解説】の面材のせん断破壊・せん断座屈の検定（式 3.3.8〜
//! 3.3.11）を面材 1 枚ごとに行う。
//!
//! ```text
//!   τN < τmax かつ τN < τcr                              … 式 3.3.8
//!   τN  = Cxy・Zxy・ΔPv / t                              … 式 3.3.9
//!   τcr = ξ・t²・Ca・S / (3a²) ・ (E1³・E2)^(1/4)         … 式 3.3.11a
//!   Ca  = 10.846β² − 10.82β + 13.729                     … 式 3.3.11b
//!   S   = 0.79α + 0.17β + 0.93                           … 式 3.3.11c
//!   α   = GB / √(E1・E2)                                 … 式 3.3.11d
//!   β   = (a/b)・(E2/E1)^(1/4) 、β > 1.5 なら β = 1.5     … 式 3.3.11e
//! ```
//!
//! 座屈の式は **四周打ち**（式 3.3.11）だけを持つ。面材張り大壁は適用範囲
//! 3.3(1)⑤ で「面材の四周は必ず釘打ちされていること」と定められているため、
//! 川の字打ちの式（式 3.3.10）が要るのは大壁以外の耐力要素だけになる。
//!
//! 適用範囲（3.3(1)）のうち、①許容せん断耐力の上限 13.72 kN/m も数値で
//! 機械的に確かめられるのでここで判定する。②〜⑧（面材と釘の組合せ、釘の
//! ピッチとへりあき、端部および継目の材の断面、中間材の配置など）は寸法と
//! 納まりの話なので、設計者が確認する前提とする。

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

/// 面材そのものの諸元（表 3.3.1 の脚注と表 3.3.2）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sheathing {
    /// 厚さ t [mm]。
    pub thickness: f64,
    /// せん断弾性係数 GB [kN/mm²]。
    pub shear_modulus: f64,
    /// せん断強度 τmax [N/mm²]（表 3.3.2）。
    pub tau_max: f64,
    /// 繊維直交方向の曲げヤング係数 E1 [N/mm²]（表 3.3.2）。
    pub e1: f64,
    /// 繊維平行方向の曲げヤング係数 E2 [N/mm²]（表 3.3.2）。
    pub e2: f64,
}

impl Sheathing {
    /// 面材のせん断剛性 GB・t [kN/mm]（式 3.3.4 の第 2 項の分母）。
    pub fn shear_rigidity(self) -> f64 {
        self.shear_modulus * self.thickness
    }

    /// せん断弾性係数 GB を N/mm² で返す（座屈の式は E1・E2 と単位をそろえる）。
    pub fn shear_modulus_in_newton(self) -> f64 {
        self.shear_modulus * 1000.0
    }
}

/// 面材の表面単板の繊維方向。座屈の式の a・b をどちらの辺に取るかを決める。
///
/// 式 3.3.11 の a は E1 方向（＝繊維直交方向）、b は E2 方向（＝繊維平行方向）の
/// 面材長さ。3 × 6 板のように長辺方向へ繊維が走る使い方が多いので、指定が
/// 無ければ長辺を繊維平行方向とみなす。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Grain {
    /// 指定なし（長辺方向を繊維平行方向とみなす）。
    LongSide,
    /// 面材の幅方向。
    Width,
    /// 面材の高さ方向。
    Height,
}

impl Grain {
    pub fn id(self) -> &'static str {
        match self {
            Grain::LongSide => "",
            Grain::Width => "width",
            Grain::Height => "height",
        }
    }

    pub fn from_id(id: &str) -> Grain {
        match id {
            "width" => Grain::Width,
            "height" => Grain::Height,
            _ => Grain::LongSide,
        }
    }

    pub fn label(self, width: f64, height: f64) -> &'static str {
        match self.resolve(width, height) {
            Grain::Width => "幅方向",
            _ => "高さ方向",
        }
    }

    /// 「長辺方向」を実際の向きへ解く。正方形は高さ方向とする。
    fn resolve(self, width: f64, height: f64) -> Grain {
        match self {
            Grain::LongSide if width > height => Grain::Width,
            Grain::LongSide => Grain::Height,
            other => other,
        }
    }

    /// 面材の幅・高さから (a, b) を決める。a は繊維直交方向、b は繊維平行方向。
    pub fn dimensions(self, width: f64, height: f64) -> (f64, f64) {
        match self.resolve(width, height) {
            Grain::Width => (height, width),
            _ => (width, height),
        }
    }
}

/// 壁を構成する面材 1 枚分の入力（寸法と釘配列諸定数）。
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
    /// E1 方向（繊維直交方向）の面材長さ a [mm]（式 3.3.11）。
    pub a: f64,
    /// E2 方向（繊維平行方向）の面材長さ b [mm]（式 3.3.11）。
    pub b: f64,
    /// 繊維方向の見出し（「高さ方向」など。計算書に何を仮定したかを残す）。
    pub grain_label: &'static str,
}

impl PanelSpec {
    /// 釘配列諸定数の計算結果（3.2 節）と面材寸法から、1 枚分の入力を作る。
    pub fn new(
        label: &str,
        constants: &Constants,
        width: f64,
        height: f64,
        grain: Grain,
    ) -> PanelSpec {
        let (a, b) = grain.dimensions(width, height);
        PanelSpec {
            label: label.to_string(),
            area: constants.panel_area,
            ixy: constants.ixy,
            zxy: constants.zxy,
            cxy: constants.cxy,
            a,
            b,
            grain_label: grain.label(width, height),
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
    /// 終局せん断応力度 τN [N/mm²]（式 3.3.9）。
    pub tau_n: f64,
    /// 座屈の式の β（式 3.3.11e、1.5 で頭打ち）。
    pub beta: f64,
    /// 臨界せん断座屈応力度 τcr [N/mm²]（式 3.3.11a）。
    pub tau_cr: f64,
    /// τN < τmax（面材のせん断破壊が生じない）。
    pub shear_ok: bool,
    /// τN < τcr（面材のせん断座屈が生じない）。
    pub buckling_ok: bool,
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
    /// 中間材（間柱等）を設けるか。せん断座屈の ξ になる（式 3.3.11e の下）。
    pub has_intermediate_stud: bool,
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
    /// せん断座屈の ξ（中間材ありで 2、なしで 1）。
    pub xi: f64,
    /// すべての面材で τN < τmax（式 3.3.8 の前半）。
    pub shear_ok: bool,
    /// すべての面材で τN < τcr（式 3.3.8 の後半）。
    pub buckling_ok: bool,
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

/// 中間材（間柱等）の有無で決まるせん断座屈の係数 ξ を返す。
///
/// 「間柱なしの場合は 1、間柱ありの場合その本数によらず 2」（式 3.3.11e の下）。
pub fn buckling_factor(has_intermediate_stud: bool) -> f64 {
    if has_intermediate_stud {
        2.0
    } else {
        1.0
    }
}

/// 面材釘のせん断抵抗により面材に作用する終局せん断応力度 τN を求める（式 3.3.9）。
///
/// τN = Cxy・Zxy・ΔPv / t   [N/mm²]
///
/// ΔPv は式のうえでは N なので、kN で受け取った値を 1000 倍する。
pub fn ultimate_shear_stress(
    cxy: f64,
    zxy: f64,
    delta_pv: f64,
    thickness: f64,
) -> Result<f64, WallError> {
    if !(thickness > 0.0) {
        return Err(WallError::new("面材の厚さ t が 0 以下です。"));
    }
    Ok(cxy * zxy * (delta_pv * 1000.0) / thickness)
}

/// せん断座屈の式の β を求める（式 3.3.11e）。
///
/// β = (a/b)・(E2/E1)^(1/4) 、ただし β > 1.5 となる場合は β = 1.5 とする。
pub fn buckling_aspect_ratio(a: f64, b: f64, e1: f64, e2: f64) -> Result<f64, WallError> {
    if !(b > 0.0) || !(e1 > 0.0) {
        return Err(WallError::new(
            "面材長さ b と曲げヤング係数 E1 は正の数値である必要があります。",
        ));
    }
    let beta = (a / b) * (e2 / e1).powf(0.25);
    Ok(beta.min(1.5))
}

/// 臨界せん断座屈応力度 τcr を求める（式 3.3.11a〜d、四周打ち）。
///
/// τcr = ξ・t²・Ca・S / (3a²) ・ (E1³・E2)^(1/4)   [N/mm²]
///
/// 面材張り大壁は適用範囲 3.3(1)⑤ により四周打ちなので、川の字打ちの式
/// （3.3.10）は持たない。
pub fn critical_buckling_stress(
    sheathing: Sheathing,
    a: f64,
    beta: f64,
    xi: f64,
) -> Result<f64, WallError> {
    if !(a > 0.0) {
        return Err(WallError::new(
            "面材長さ a は正の数値である必要があります。",
        ));
    }
    let (e1, e2) = (sheathing.e1, sheathing.e2);
    if !(e1 > 0.0) || !(e2 > 0.0) {
        return Err(WallError::new(
            "曲げヤング係数 E1・E2 は正の数値である必要があります。",
        ));
    }
    // (3.3.11d) α = GB / √(E1・E2)。GB だけ kN/mm² なので N/mm² へそろえる。
    let alpha = sheathing.shear_modulus_in_newton() / (e1 * e2).sqrt();
    // (3.3.11b) (3.3.11c)
    let ca = 10.846 * beta * beta - 10.82 * beta + 13.729;
    let s = 0.79 * alpha + 0.17 * beta + 0.93;
    let t = sheathing.thickness;
    Ok(xi * (t * t * ca * s) / (3.0 * a * a) * (e1.powi(3) * e2).powf(0.25))
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
    positive(wall.sheathing.tau_max, "面材のせん断強度 τmax")?;
    positive(wall.sheathing.e1, "繊維直交方向の曲げヤング係数 E1")?;
    positive(wall.sheathing.e2, "繊維平行方向の曲げヤング係数 E2")?;
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
        positive(panel.a, &format!("「{}」の面材長さ a", panel.label))?;
        positive(panel.b, &format!("「{}」の面材長さ b", panel.label))?;
    }
    Ok(())
}

// --- 一括計算 ----------------------------------------------------------------

/// 壁の剛性とせん断耐力を求める（グレー本 3.3(3) の計算例の手順 4)〜10) に対応）。
pub fn compute(wall: &Wall) -> Result<WallResult, WallError> {
    validate_input(wall)?;

    let shear_rigidity = wall.sheathing.shear_rigidity();
    let xi = buckling_factor(wall.has_intermediate_stud);

    // 4)〜8) 面材ごとに K0・My・Mu・μ を求め、あわせて面材のせん断破壊・
    // せん断座屈の検定（式 3.3.8〜3.3.11）も行う。
    let mut panels = Vec::with_capacity(wall.panels.len());
    for spec in &wall.panels {
        let k0 = rotational_stiffness(spec.area, spec.ixy, wall.nail.k, shear_rigidity)?;
        let my = yield_moment(spec.area, spec.zxy, wall.nail.delta_pv);
        let tau_n = ultimate_shear_stress(
            spec.cxy,
            spec.zxy,
            wall.nail.delta_pv,
            wall.sheathing.thickness,
        )?;
        let beta =
            buckling_aspect_ratio(spec.a, spec.b, wall.sheathing.e1, wall.sheathing.e2)?;
        let tau_cr = critical_buckling_stress(wall.sheathing, spec.a, beta, xi)?;
        panels.push(PanelResult {
            k0,
            my,
            mu: ultimate_moment(spec.cxy, my),
            ductility: ductility_factor(wall.nail, spec.ixy, shear_rigidity)?,
            tau_n,
            beta,
            tau_cr,
            shear_ok: tau_n < wall.sheathing.tau_max,
            buckling_ok: tau_n < tau_cr,
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
        xi,
        shear_ok: panels.iter().all(|panel| panel.shear_ok),
        buckling_ok: panels.iter().all(|panel| panel.buckling_ok),
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
    /// 釘の呼び径 [mm]（JIS A 5508）。
    ///
    /// 計算そのものには使わない。面材ごとに決めるへりあき（面材の縁から釘の
    /// 中心までの距離）を、選んだ釘に合わせて決められるよう画面と計算書に
    /// 添えるための値。
    pub nail_diameter: f64,
    pub nail: NailShear,
    /// 面材のせん断弾性係数 GB [kN/mm²]（表 3.3.1 の脚注）。
    pub shear_modulus: f64,
    /// 既定で組み合わせる表 3.3.2 の規格（構造用合板は JAS 1 級）。
    pub grade_id: &'static str,
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

    /// 既定の規格（表 3.3.2）と組み合わせた面材の諸元。
    pub fn sheathing(&self) -> Sheathing {
        let grade = find_grade(self.grade_id).expect("既定の規格は表 3.3.2 にある");
        Sheathing {
            thickness: self.thickness,
            shear_modulus: self.shear_modulus,
            tau_max: grade.tau_max,
            e1: grade.e1,
            e2: grade.e2,
        }
    }
}

/// 表 3.3.2「面材のせん断強度及び曲げヤング係数」の 1 行。
///
/// せん断強度も曲げヤング係数も厚さには依らないので、面材の種類と規格だけで
/// 引ける形にしてある（表は「構造用合板 12mm」「同 24mm、又は、28mm」を
/// 別の行にしているが、数値はどちらも同じ）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Grade {
    pub id: &'static str,
    /// 面材の種類。
    pub panel: &'static str,
    /// 規格（「JAS 1 級」「JIS A 5905」など）。
    pub grade: &'static str,
    /// せん断強度 τmax [N/mm²]。
    pub tau_max: f64,
    /// 繊維直交方向の曲げヤング係数 E1 [N/mm²]。
    pub e1: f64,
    /// 繊維平行方向の曲げヤング係数 E2 [N/mm²]。
    pub e2: f64,
}

impl Grade {
    pub fn label(&self) -> String {
        format!("{} {}", self.panel, self.grade)
    }
}

/// 表 3.3.2 の規格。
///
/// 構造用合板の E1・E2 が JAS 1 級と 2 級で同じなのは、表の注 *1 のとおり
/// 「JAS 2 級であったとしても JAS 1 級相当とみなし、面材のせん断座屈の検討に
/// 限り、E1 と E2 は JAS 1 級の値を用いてもよい」ため。
const GRADES: &[Grade] = &[
    Grade { id: "plywood-jas1", panel: "構造用合板", grade: "JAS 1 級", tau_max: 3.6, e1: 3500.0, e2: 5500.0 },
    Grade { id: "plywood-jas2", panel: "構造用合板", grade: "JAS 2 級", tau_max: 2.4, e1: 3500.0, e2: 5500.0 },
    Grade { id: "mdf", panel: "構造用 MDF", grade: "JIS A 5905", tau_max: 6.0, e1: 2000.0, e2: 2000.0 },
    Grade { id: "particleboard", panel: "構造用パーティクルボード", grade: "JIS A 5908", tau_max: 4.0, e1: 3000.0, e2: 3000.0 },
];

/// 表 3.3.2 の規格を、表と同じ並びで返す。
pub fn grades() -> &'static [Grade] {
    GRADES
}

/// id から規格を引く（知らない id なら None）。
pub fn find_grade(id: &str) -> Option<&'static Grade> {
    GRADES.iter().find(|grade| grade.id == id)
}

/// 日本農林規格の構造用合板のせん断弾性係数 GB [kN/mm²]。
const PLYWOOD_G: f64 = 0.40;
/// JIS A 5905 の構造用 MDF のせん断弾性係数 GB [kN/mm²]。
const MDF_G: f64 = 0.75;
/// JIS A 5908 の構造用パーティクルボードのせん断弾性係数 GB [kN/mm²]。
const PARTICLE_BOARD_G: f64 = 1.00;

/// 釘の呼び径 [mm]（JIS A 5508）。長さが同じでも CN 釘のほうが太い。
const N50_D: f64 = 2.75;
const N65_D: f64 = 3.05;
const N75_D: f64 = 3.40;
const CN50_D: f64 = 2.87;
const CN65_D: f64 = 3.33;
const CN75_D: f64 = 3.76;

#[allow(clippy::too_many_arguments)]
const fn material(
    id: &'static str,
    panel: &'static str,
    thickness: f64,
    nail_label: &'static str,
    nail_diameter: f64,
    k: f64,
    delta_v: f64,
    delta_u: f64,
    delta_pv: f64,
    shear_modulus: f64,
    grade_id: &'static str,
) -> Material {
    Material {
        id,
        panel,
        thickness,
        nail_label,
        nail_diameter,
        nail: NailShear {
            k,
            delta_v,
            delta_u,
            delta_pv,
        },
        shear_modulus,
        grade_id,
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
/// 3.3(3) の計算例が「CN65」として使っている k = 0.483、δv = 2.3、δu = 17.0、
/// ΔPv = 1.13 は訂正後の N-65 の値なので、計算例の釘は N-65 として扱う。
const TABLE: &[Material] = &[
    material("plywood12-n50", "構造用合板", 12.0, "鉄丸釘 N-50", N50_D, 0.430, 2.1, 17.1, 0.91, PLYWOOD_G, "plywood-jas1"),
    material("plywood12-n65", "構造用合板", 12.0, "鉄丸釘 N-65", N65_D, 0.483, 2.3, 17.0, 1.13, PLYWOOD_G, "plywood-jas1"),
    material("plywood12-cn50", "構造用合板", 12.0, "太め鉄丸釘(CN 釘)50", CN50_D, 0.467, 2.0, 17.1, 0.94, PLYWOOD_G, "plywood-jas1"),
    material("plywood12-cn65", "構造用合板", 12.0, "太め鉄丸釘(CN 釘)65", CN65_D, 0.605, 2.1, 17.0, 1.29, PLYWOOD_G, "plywood-jas1"),
    material("plywood24-n75", "構造用合板", 24.0, "鉄丸釘 N-75", N75_D, 0.651, 2.5, 17.1, 1.62, PLYWOOD_G, "plywood-jas1"),
    material("plywood24-cn65", "構造用合板", 24.0, "太め鉄丸釘(CN 釘)65", CN65_D, 0.878, 1.5, 13.2, 1.31, PLYWOOD_G, "plywood-jas1"),
    material("plywood24-cn75", "構造用合板", 24.0, "太め鉄丸釘(CN 釘)75", CN75_D, 1.013, 1.8, 21.4, 1.85, PLYWOOD_G, "plywood-jas1"),
    material("plywood28-n75", "構造用合板", 28.0, "鉄丸釘 N-75", N75_D, 0.651, 2.5, 17.1, 1.62, PLYWOOD_G, "plywood-jas1"),
    material("plywood28-cn65", "構造用合板", 28.0, "太め鉄丸釘(CN 釘)65", CN65_D, 0.878, 1.5, 13.2, 1.31, PLYWOOD_G, "plywood-jas1"),
    material("plywood28-cn75", "構造用合板", 28.0, "太め鉄丸釘(CN 釘)75", CN75_D, 1.013, 1.8, 21.4, 1.85, PLYWOOD_G, "plywood-jas1"),
    material("mdf9-cn50", "構造用 MDF", 9.0, "太め鉄丸釘(CN 釘)50", CN50_D, 0.636, 1.5, 17.1, 0.93, MDF_G, "mdf"),
    material("particleboard9-cn50", "構造用パーティクルボード", 9.0, "太め鉄丸釘(CN 釘)50", CN50_D, 0.732, 1.2, 15.6, 0.85, PARTICLE_BOARD_G, "particleboard"),
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
    //!   3. 面材のせん断破壊・せん断座屈の検定（式 3.3.8〜3.3.11）。
    //!   4. 入力検証・エッジケース。
    //!   5. 表 3.3.1 / 表 3.3.2 の一覧。

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

    /// 計算例の面材と釘（構造用合板 12mm・JAS 1 級 ＋ 鉄丸釘 N-65）。
    ///
    /// 本文は「表 3.3.1 より、構造用合板 12〔mm〕＋ CN65」としているが、印刷
    /// された表は CN65 と N-65 が入れ替わっており、本文が計算に使っている
    /// k = 0.483・δv = 2.3・δu = 17.0・ΔPv = 1.13 は訂正後の N-65 の値
    /// （TABLE のコメント参照）。よってこの釘は N-65 として扱う。
    fn example_material() -> &'static Material {
        find_material("plywood12-n65").unwrap()
    }

    /// 表 3.2.1 の配列 id から、計算例の面材 1 枚分の入力を作る。
    ///
    /// 繊維方向は指定しない（長辺方向とみなす）。3 × 6 板を縦置きにした
    /// 下側の面材は b = 1820・a = 910、正方形の上側の面材は a = b = 910。
    fn example_panel(id: &str) -> PanelSpec {
        let preset = presets::find(id).expect("表 3.2.1 にある配列");
        let constants =
            nail_array::compute(&preset.nails(), preset.width * preset.height).unwrap();
        PanelSpec::new(
            &preset.label(),
            &constants,
            preset.width,
            preset.height,
            Grain::LongSide,
        )
    }

    fn example_wall() -> Wall {
        Wall {
            height: 3000.0,
            width: 910.0,
            sheathing: example_material().sheathing(),
            nail: example_material().nail,
            // 間柱 30 × 105 を @455 で入れている（図 3.3.10）。
            has_intermediate_stud: true,
            panels: vec![
                example_panel("910x1820-s455-n75-hi"),
                example_panel("910x910-s455-n75-ro"),
            ],
        }
    }

    fn example() -> WallResult {
        compute(&example_wall()).unwrap()
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
        close(ductility_factor(example_material().nail, 4.99, rigidity).unwrap(), 5.25, 0.005);
        close(ductility_factor(example_material().nail, 3.84, rigidity).unwrap(), 5.61, 0.005);
    }

    /// 面材のせん断変形が無い（GB・t → ∞）極限では、釘そのものの塑性率
    /// δu/δv に一致する。
    #[test]
    fn ductility_factor_approaches_the_nail_ratio_for_a_rigid_panel() {
        let nail = example_material().nail;
        let ratio = nail.delta_u / nail.delta_v;
        let stiff = ductility_factor(nail, 4.99, 1e12).unwrap();
        close(stiff, ratio, 1e-6);
        // 面材が柔らかいほど、壁としての塑性率は小さくなる。
        assert!(ductility_factor(nail, 4.99, 4.8).unwrap() < ratio);
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

    // --- 3. 面材のせん断破壊・せん断座屈（式 3.3.8〜3.3.11） ----------------

    /// 計算例の面材は、どちらも τN が τmax・τcr に対して十分に小さい。
    ///
    /// グレー本は「表 3.2.1 と表 3.3.1 の全ての組合せに対しては…面材の
    /// せん断破壊とせん断座屈が生じないことを確認している」としており、その
    /// 確認を計算例でなぞる形になる。
    #[test]
    fn the_example_passes_the_shear_and_buckling_checks() {
        let example = example();
        assert!(example.shear_ok && example.buckling_ok);
        assert_eq!(example.xi, 2.0);

        // 下側の面材 910 × 1820（繊維は長辺方向なので a = 910、b = 1820）。
        let lower = &example.panels[0];
        assert_eq!((lower.spec.a, lower.spec.b), (910.0, 1820.0));
        close(lower.beta, 0.5598, 0.0005); // (910/1820)×(5500/3500)^(1/4)
        close(lower.tau_n, 1.376, 0.005);
        close(lower.tau_cr, 5.518, 0.01);

        // 上側の面材 910 × 910（正方形なので a = b）。
        let upper = &example.panels[1];
        assert_eq!((upper.spec.a, upper.spec.b), (910.0, 910.0));
        close(upper.beta, 1.1196, 0.0005);
        close(upper.tau_n, 1.399, 0.005);
        close(upper.tau_cr, 8.239, 0.01);

        // τmax（構造用合板 JAS 1 級）= 3.6 N/mm² のほうが先に効く余裕度。
        for panel in &example.panels {
            assert!(panel.tau_n < 3.6);
            assert!(panel.tau_n < panel.tau_cr);
        }
    }

    /// 式 3.3.9。ΔPv は kN で受け取り、式のうえの N へ直す。
    #[test]
    fn ultimate_shear_stress_converts_the_nail_strength_to_newton() {
        // 1.17732 × 0.0124144 × 1130 N / 12mm
        close(
            ultimate_shear_stress(1.17732, 0.0124144, 1.13, 12.0).unwrap(),
            1.3764,
            0.0005,
        );
        assert!(ultimate_shear_stress(1.0, 0.01, 1.0, 0.0).is_err());
    }

    /// 式 3.3.11e。β は 1.5 で頭打ちにする。
    #[test]
    fn buckling_aspect_ratio_is_capped_at_one_and_a_half() {
        close(
            buckling_aspect_ratio(910.0, 1820.0, 3500.0, 5500.0).unwrap(),
            0.5598,
            0.0005,
        );
        // 細長い面材でも 1.5 を超えない。
        assert_eq!(
            buckling_aspect_ratio(3000.0, 910.0, 3500.0, 5500.0).unwrap(),
            1.5
        );
        assert!(buckling_aspect_ratio(910.0, 0.0, 3500.0, 5500.0).is_err());
    }

    /// 式 3.3.11a〜d。中間材（間柱）があれば τcr は 2 倍になる。
    #[test]
    fn critical_buckling_stress_doubles_with_an_intermediate_stud() {
        let sheathing = example_material().sheathing();
        let beta = buckling_aspect_ratio(910.0, 1820.0, sheathing.e1, sheathing.e2).unwrap();

        let without = critical_buckling_stress(sheathing, 910.0, beta, 1.0).unwrap();
        let with = critical_buckling_stress(sheathing, 910.0, beta, 2.0).unwrap();
        close(with, without * 2.0, 1e-9);
        close(with, 5.518, 0.01);

        assert_eq!(buckling_factor(true), 2.0);
        assert_eq!(buckling_factor(false), 1.0);
    }

    /// τcr は a²（繊維直交方向の長さ）に反比例する。
    #[test]
    fn critical_buckling_stress_falls_with_the_square_of_a() {
        let sheathing = example_material().sheathing();
        let narrow = critical_buckling_stress(sheathing, 455.0, 1.0, 2.0).unwrap();
        let wide = critical_buckling_stress(sheathing, 910.0, 1.0, 2.0).unwrap();
        close(narrow, wide * 4.0, 1e-9);
    }

    /// 薄い面材・弱い規格にすると、せん断破壊とせん断座屈が NG になる。
    #[test]
    fn a_thin_panel_fails_both_checks() {
        let mut wall = example_wall();
        wall.sheathing.thickness = 2.0;
        wall.sheathing.tau_max = 1.0;
        let result = compute(&wall).unwrap();

        assert!(!result.shear_ok);
        assert!(!result.buckling_ok);
        assert!(result.panels.iter().all(|panel| !panel.shear_ok));
    }

    /// 繊維方向は a・b の取り方を入れ替える。
    #[test]
    fn the_grain_direction_swaps_a_and_b() {
        assert_eq!(Grain::LongSide.dimensions(910.0, 1820.0), (910.0, 1820.0));
        assert_eq!(Grain::LongSide.dimensions(1820.0, 910.0), (910.0, 1820.0));
        assert_eq!(Grain::Width.dimensions(910.0, 1820.0), (1820.0, 910.0));
        assert_eq!(Grain::Height.dimensions(1820.0, 910.0), (1820.0, 910.0));
        // 正方形は高さ方向とみなす。
        assert_eq!(Grain::LongSide.label(910.0, 910.0), "高さ方向");
        assert_eq!(Grain::LongSide.label(1820.0, 910.0), "幅方向");
        assert_eq!(Grain::from_id("width"), Grain::Width);
        assert_eq!(Grain::from_id("なにか"), Grain::LongSide);
        assert_eq!(Grain::LongSide.id(), "");
    }

    /// 同じ面材でも、繊維方向を変えれば τcr が変わる（a と β が変わるため）。
    #[test]
    fn the_grain_direction_changes_the_buckling_stress() {
        let preset = presets::find("910x1820-s455-n75-hi").unwrap();
        let constants =
            nail_array::compute(&preset.nails(), preset.width * preset.height).unwrap();
        let across = |grain| {
            let panels = vec![PanelSpec::new(
                "面材",
                &constants,
                preset.width,
                preset.height,
                grain,
            )];
            compute(&wall_with(panels)).unwrap().panels[0].tau_cr
        };

        // 910 × 1820 の面材で繊維が高さ方向なら a = 910、幅方向なら a = 1820。
        // a² で効くぶん τcr は下がるが、β（1.5 で頭打ち）も動くので 1/4 に
        // なるわけではない。
        close(across(Grain::Height), 5.518, 0.01);
        close(across(Grain::Width), 3.127, 0.01);
        assert!(across(Grain::Width) < across(Grain::Height));
    }

    // --- 4. 入力検証・エッジケース ------------------------------------------

    fn wall_with(panels: Vec<PanelSpec>) -> Wall {
        Wall {
            panels,
            ..example_wall()
        }
    }

    fn one_panel() -> Vec<PanelSpec> {
        vec![PanelSpec {
            label: "面材".to_string(),
            area: 1_656_200.0,
            ixy: 4.99,
            zxy: 0.0124,
            cxy: 1.18,
            a: 910.0,
            b: 1820.0,
            grain_label: "高さ方向",
        }]
    }

    #[test]
    fn rejects_non_positive_dimensions_and_nail_data() {
        let cases: [(&dyn Fn(&mut Wall), &str); 9] = [
            (&|wall: &mut Wall| wall.height = 0.0, "階高 H"),
            (&|wall: &mut Wall| wall.width = -1.0, "壁の幅 W"),
            (&|wall: &mut Wall| wall.sheathing.thickness = 0.0, "面材の厚さ t"),
            (&|wall: &mut Wall| wall.sheathing.shear_modulus = 0.0, "せん断弾性係数 GB"),
            (&|wall: &mut Wall| wall.sheathing.tau_max = 0.0, "せん断強度 τmax"),
            (&|wall: &mut Wall| wall.sheathing.e1 = 0.0, "曲げヤング係数 E1"),
            (&|wall: &mut Wall| wall.sheathing.e2 = -1.0, "曲げヤング係数 E2"),
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

    // --- 5. 表 3.3.1 / 表 3.3.2 の一覧 --------------------------------------

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

    /// 釘の呼び径（JIS A 5508）。計算には使わないが、面材ごとのへりあきを
    /// 決めるときの手がかりとして表に持たせている。
    #[test]
    fn every_material_carries_the_nail_diameter() {
        assert_eq!(find_material("plywood12-n50").unwrap().nail_diameter, 2.75);
        assert_eq!(find_material("plywood12-n65").unwrap().nail_diameter, 3.05);
        assert_eq!(find_material("plywood24-cn75").unwrap().nail_diameter, 3.76);
        for material in materials() {
            assert!(material.nail_diameter > 0.0, "{}", material.id);
        }
        // 同じ長さなら、太め鉄丸釘(CN 釘)のほうが太い。
        for (thin, thick) in [
            ("plywood12-n50", "plywood12-cn50"),
            ("plywood12-n65", "plywood12-cn65"),
        ] {
            assert!(
                find_material(thick).unwrap().nail_diameter
                    > find_material(thin).unwrap().nail_diameter
            );
        }
    }

    #[test]
    fn the_grade_table_covers_every_row_of_the_book() {
        let grades = grades();
        assert_eq!(grades.len(), 4);
        assert_eq!(find_grade("plywood-jas1").unwrap().tau_max, 3.6);
        assert_eq!(find_grade("plywood-jas2").unwrap().tau_max, 2.4);
        // 注 *1 のとおり、JAS 2 級でも座屈の検討に使う E1・E2 は 1 級と同じ。
        assert_eq!(
            (find_grade("plywood-jas1").unwrap().e1, find_grade("plywood-jas1").unwrap().e2),
            (find_grade("plywood-jas2").unwrap().e1, find_grade("plywood-jas2").unwrap().e2)
        );
        assert_eq!(find_grade("mdf").unwrap().label(), "構造用 MDF JIS A 5905");
        assert_eq!(find_grade("なにか"), None);
    }

    /// 表 3.3.1 の組合せは、必ず表 3.3.2 の規格を 1 つ指している。
    #[test]
    fn every_material_points_at_a_grade() {
        for material in materials() {
            let sheathing = material.sheathing();
            assert!(sheathing.tau_max > 0.0, "{}", material.id);
            assert!(sheathing.e1 > 0.0 && sheathing.e2 > 0.0, "{}", material.id);
            assert_eq!(sheathing.thickness, material.thickness);
        }
        // 構造用合板は既定で JAS 1 級（適用範囲 3.3(1)③ の基本）。
        assert_eq!(find_material("plywood12-n65").unwrap().grade_id, "plywood-jas1");
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
