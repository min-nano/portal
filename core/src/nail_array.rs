//! 釘配列諸定数（Ixy, Zxy, Cxy）の計算。
//!
//! グレー本『木造軸組工法住宅の許容応力度設計』
//!   3.2 面材張り耐力要素の詳細計算法で用いる釘配列諸定数の計算
//!   （式 3.2.1〜3.2.7）に準拠する。
//!
//! 計算上の仮定:
//!   - 面材・軸材は剛体、軸材どうしはピン接合。
//!   - 釘のせん断変形は中立軸に対して平面保持仮定が成立する。
//!
//! このモジュールが「唯一の計算実装」で、画面に表示する値も PDF 計算書に
//! 印字する値も必ずここを通る。同じ .wasm を画面（ブラウザ）とサーバ
//! （Cloud Run）の両方が動かすので、実装が 2 つに分かれることがない。
//! 関数の粒度と式番号のコメントは、GAS 版 gas-timber-panel-shear-calculator
//! の src/NailArrayConstants.js から引き継いでいる。

/// 入力が計算できないときのエラー。文面はそのまま利用者に見せられる日本語。
#[derive(Debug, Clone, PartialEq)]
pub struct NailArrayError(pub String);

impl NailArrayError {
    fn new(message: &str) -> NailArrayError {
        NailArrayError(message.to_string())
    }
}

/// 釘 1 本の座標 [mm]（原点は面材の左下）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Nail {
    pub x: f64,
    pub y: f64,
}

/// 釘配列諸定数と、その途中経過（白箱化のため全部返す）。
#[derive(Debug, Clone, PartialEq)]
pub struct Constants {
    pub n: usize,
    pub panel_area: f64,
    pub x0: f64,
    pub y0: f64,
    pub ix: f64,
    pub iy: f64,
    pub ixy: f64,
    pub dx_max: f64,
    pub dy_max: f64,
    pub zx: f64,
    pub zy: f64,
    pub zxy: f64,
    pub alpha_x: f64,
    pub zpxy: f64,
    pub cxy: f64,
}

/// 弾性中立軸位置を求める。
///
/// y0 = Σ(yj・nj) / Σnj 、 x0 = Σ(xi・ni) / Σni （式 3.2.2a / 3.2.2b の中立軸）。
/// 釘を「1 要素 = 釘 1 本」で表すため、各座標の重み nj は座標の重複本数として
/// 自然に折り込まれ、単純な相加平均となる。
pub fn neutral_axis_position(coords: &[f64]) -> Result<f64, NailArrayError> {
    if coords.is_empty() {
        return Err(NailArrayError::new("釘座標のリストが空です。"));
    }
    let sum: f64 = coords.iter().sum();
    Ok(sum / coords.len() as f64)
}

/// 釘配列二次モーメントを求める。
///
/// Ix = Σ(yj - y0)^2・nj （式 3.2.2a） / Iy = Σ(xi - x0)^2・ni （式 3.2.2b）
pub fn second_moment_of_nail_array(coords: &[f64], axis: f64) -> f64 {
    coords.iter().map(|coord| (coord - axis).powi(2)).sum()
}

/// 中立軸から端部の釘までの距離の最大値 (yj - y0)max / (xi - x0)max を求める。
pub fn max_distance_from_axis(coords: &[f64], axis: f64) -> f64 {
    coords
        .iter()
        .map(|coord| (coord - axis).abs())
        .fold(0.0, f64::max)
}

/// 単位面積あたりの釘配列二次モーメント Ixy を求める（式 3.2.1）。
///
/// Ixy = ( Ix・Iy / (Ix + Iy) ) / Aw   [mm^2/mm^2]
pub fn unit_second_moment(ix: f64, iy: f64, panel_area: f64) -> Result<f64, NailArrayError> {
    let denominator = ix + iy;
    if denominator == 0.0 {
        return Err(NailArrayError::new(
            "Ix + Iy が 0 です（釘が 1 点に集中しています）。",
        ));
    }
    Ok((ix * iy / denominator) / panel_area)
}

/// 各方向の釘配列係数を求める（式 3.2.4a / 3.2.4b）。
///
/// Zx = Ix / (yj - y0)max 、 Zy = Iy / (xi - x0)max
/// 端部距離が 0（その方向に配列の広がりが無い）の場合は 0 を返す。
pub fn arrangement_coefficient(second_moment: f64, max_distance: f64) -> f64 {
    if max_distance == 0.0 {
        return 0.0;
    }
    second_moment / max_distance
}

/// 単位面積あたりの釘配列係数 Zxy を求める（式 3.2.3）。
///
/// Zxy = 1 / ( Aw・√(1/Zx^2 + 1/Zy^2) )   [mm/mm^2]
///
/// Zx もしくは Zy が 0 のときは、その方向に配列の広がりが無いということなので
/// Zxy は 0 に収束する（式のまま計算すると 1/0 = ∞ を経由することになるため、
/// 明示的に分岐する）。
pub fn unit_arrangement_coefficient(zx: f64, zy: f64, panel_area: f64) -> f64 {
    if zx == 0.0 || zy == 0.0 {
        return 0.0;
    }
    let root = (1.0 / (zx * zx) + 1.0 / (zy * zy)).sqrt();
    if root == 0.0 || root.is_infinite() {
        return 0.0;
    }
    1.0 / (panel_area * root)
}

/// 全塑性状態の全体変形に対する X 方向の変形割合 αx を求める（式 3.2.7）。
///
/// αx = Iy / (Ix + Iy)
pub fn deformation_ratio_x(ix: f64, iy: f64) -> Result<f64, NailArrayError> {
    let denominator = ix + iy;
    if denominator == 0.0 {
        return Err(NailArrayError::new(
            "Ix + Iy が 0 です（釘が 1 点に集中しています）。",
        ));
    }
    Ok(iy / denominator)
}

/// 単位面積あたりの塑性釘配列係数 Zpxy を求める（式 3.2.6）。
///
/// Zpxy = Σ√( {(yj - y0)・αx}^2 + {(xi - x0)・(1 - αx)}^2 ) / Aw   [mm/mm^2]
pub fn plastic_unit_arrangement_coefficient(
    nails: &[Nail],
    x0: f64,
    y0: f64,
    alpha_x: f64,
    panel_area: f64,
) -> f64 {
    let mut total = 0.0;
    for nail in nails {
        let dy = (nail.y - y0) * alpha_x;
        let dx = (nail.x - x0) * (1.0 - alpha_x);
        total += (dy * dy + dx * dx).sqrt();
    }
    total / panel_area
}

/// 釘配列降伏終局比 Cxy を求める（式 3.2.5）。
///
/// Cxy = Zpxy / Zxy 、ただし Cxy < 1.0 の場合は Cxy = 1.0 とする。
pub fn yield_ultimate_ratio(zpxy: f64, zxy: f64) -> Result<f64, NailArrayError> {
    if zxy == 0.0 {
        return Err(NailArrayError::new("Zxy が 0 です。"));
    }
    let ratio = zpxy / zxy;
    Ok(if ratio < 1.0 { 1.0 } else { ratio })
}

/// 釘リストと面材面積を検証する。
pub fn validate_input(nails: &[Nail], panel_area: f64) -> Result<(), NailArrayError> {
    if nails.is_empty() {
        return Err(NailArrayError::new(
            "釘座標のリストが空です。少なくとも 1 本の釘が必要です。",
        ));
    }
    for (index, nail) in nails.iter().enumerate() {
        if !nail.x.is_finite() || !nail.y.is_finite() {
            return Err(NailArrayError(format!(
                "釘座標 #{} の x, y は有限の数値である必要があります。",
                index + 1
            )));
        }
    }
    if !panel_area.is_finite() || panel_area <= 0.0 {
        return Err(NailArrayError::new(
            "面材の面積 Aw は正の数値である必要があります。",
        ));
    }
    Ok(())
}

/// 釘配列諸定数を一括で計算する（グレー本 3.2 の手順 1)〜9) に対応）。
pub fn compute(nails: &[Nail], panel_area: f64) -> Result<Constants, NailArrayError> {
    validate_input(nails, panel_area)?;

    let xs: Vec<f64> = nails.iter().map(|nail| nail.x).collect();
    let ys: Vec<f64> = nails.iter().map(|nail| nail.y).collect();

    // 2) 各方向の弾性中立軸位置 x0, y0
    let x0 = neutral_axis_position(&xs)?;
    let y0 = neutral_axis_position(&ys)?;

    // 3) 各方向の釘配列二次モーメント Ix, Iy
    let ix = second_moment_of_nail_array(&ys, y0); // Y 方向中立軸まわり（X 軸まわり）
    let iy = second_moment_of_nail_array(&xs, x0); // X 方向中立軸まわり（Y 軸まわり）

    // 4) 単位面積あたりの釘配列二次モーメント Ixy
    let ixy = unit_second_moment(ix, iy, panel_area)?;

    // 5) 各方向の釘配列係数 Zx, Zy
    let dy_max = max_distance_from_axis(&ys, y0);
    let dx_max = max_distance_from_axis(&xs, x0);
    let zx = arrangement_coefficient(ix, dy_max);
    let zy = arrangement_coefficient(iy, dx_max);

    // 6) 単位面積あたりの釘配列係数 Zxy
    let zxy = unit_arrangement_coefficient(zx, zy, panel_area);

    // 7) αx
    let alpha_x = deformation_ratio_x(ix, iy)?;

    // 8) 単位面積あたりの塑性釘配列係数 Zpxy
    let zpxy = plastic_unit_arrangement_coefficient(nails, x0, y0, alpha_x, panel_area);

    // 9) 釘配列降伏終局比 Cxy
    let cxy = yield_ultimate_ratio(zpxy, zxy)?;

    Ok(Constants {
        n: nails.len(),
        panel_area,
        x0,
        y0,
        ix,
        iy,
        ixy,
        dx_max,
        dy_max,
        zx,
        zy,
        zxy,
        alpha_x,
        zpxy,
        cxy,
    })
}

/// 矩形格子状の釘配列を生成する（xs と ys の全組合せに釘を 1 本ずつ）。
pub fn build_rectangular_grid(xs: &[f64], ys: &[f64]) -> Vec<Nail> {
    let mut nails = Vec::with_capacity(xs.len() * ys.len());
    for &x in xs {
        for &y in ys {
            nails.push(Nail { x, y });
        }
    }
    nails
}

#[cfg(test)]
mod tests {
    //! GAS 版 tests/NailArrayConstants.test.js から引き継いだテスト構成:
    //!   1. グレー本 3.2【解説】の計算例（図 3.2.2）を再現する統合テスト。
    //!   2. 各関数単位のユニットテスト。
    //!   3. 入力検証・エッジケース。

    use super::*;

    // グレー本 3.2【解説】の計算例（図 3.2.2）。
    //   釘: X ∈ {0, 445, 890}, Y ∈ {0, 145, 295, 445, 590} の格子（15 本）
    //   面材: 610 × 910 = 555100 mm²
    const EXAMPLE_XS: [f64; 3] = [0.0, 445.0, 890.0];
    const EXAMPLE_YS: [f64; 5] = [0.0, 145.0, 295.0, 445.0, 590.0];
    const EXAMPLE_AREA: f64 = 610.0 * 910.0;

    fn example() -> Constants {
        let nails = build_rectangular_grid(&EXAMPLE_XS, &EXAMPLE_YS);
        compute(&nails, EXAMPLE_AREA).unwrap()
    }

    fn close(actual: f64, expected: f64, tolerance: f64) {
        assert!(
            (actual - expected).abs() <= tolerance,
            "{actual} != {expected} (±{tolerance})"
        );
    }

    // --- 1. グレー本 3.2【解説】の計算例（図 3.2.2） -------------------------

    #[test]
    fn example_counts_and_area() {
        let example = example();
        assert_eq!(example.n, 15);
        assert_eq!(example.panel_area, 555100.0);
    }

    #[test]
    fn example_neutral_axis() {
        let example = example();
        assert_eq!(example.x0, 445.0);
        assert_eq!(example.y0, 295.0);
    }

    #[test]
    fn example_second_moments() {
        let example = example();
        assert_eq!(example.ix, 657150.0);
        assert_eq!(example.iy, 1980250.0);
    }

    /// Ixy = 0.889 [mm²/mm²]（式 3.2.1）。
    #[test]
    fn example_unit_second_moment() {
        close(example().ixy, 0.889, 0.0005);
    }

    #[test]
    fn example_edge_distances() {
        let example = example();
        assert_eq!(example.dy_max, 295.0);
        assert_eq!(example.dx_max, 445.0);
    }

    /// Zx = 2228, Zy = 4450 [mm]（式 3.2.4）。
    #[test]
    fn example_arrangement_coefficients() {
        let example = example();
        close(example.zx, 2228.0, 0.5);
        assert_eq!(example.zy, 4450.0);
    }

    /// Zxy = 0.0036 [mm/mm²]（式 3.2.3）。
    #[test]
    fn example_unit_arrangement_coefficient() {
        close(example().zxy, 0.0036, 0.00005);
    }

    /// αx = 0.751（式 3.2.7）。
    #[test]
    fn example_deformation_ratio() {
        close(example().alpha_x, 0.751, 0.0005);
    }

    /// Zpxy = 0.0045 [mm/mm²]（式 3.2.6）。
    #[test]
    fn example_plastic_unit_arrangement_coefficient() {
        close(example().zpxy, 0.0045, 0.00005);
    }

    /// Cxy（式 3.2.5、Cxy ≧ 1.0）。
    ///
    /// グレー本は丸めた 0.0045 / 0.0036 = 1.25 と表示している。丸め前の
    /// 厳密値は約 1.26 で、いずれも 1.0 以上になる。
    #[test]
    fn example_yield_ultimate_ratio() {
        let example = example();
        close(example.cxy, 1.26, 0.02);
        assert!(example.cxy >= 1.0);
    }

    // --- 2. 各関数単位のユニットテスト ---------------------------------------

    #[test]
    fn neutral_axis_position_is_the_arithmetic_mean() {
        assert_eq!(neutral_axis_position(&EXAMPLE_XS).unwrap(), 445.0);
        assert_eq!(neutral_axis_position(&EXAMPLE_YS).unwrap(), 295.0);
    }

    /// 重複座標（本数の重み）を正しく反映する: (0+0+300)/3 = 100。
    #[test]
    fn neutral_axis_position_weights_duplicate_coordinates() {
        assert_eq!(neutral_axis_position(&[0.0, 0.0, 300.0]).unwrap(), 100.0);
    }

    #[test]
    fn neutral_axis_position_rejects_empty() {
        assert!(neutral_axis_position(&[]).is_err());
    }

    #[test]
    fn second_moment_of_nail_array_sums_the_squares() {
        assert_eq!(second_moment_of_nail_array(&[-1.0, 1.0], 0.0), 2.0);
        assert_eq!(second_moment_of_nail_array(&[2.0, 4.0, 6.0], 4.0), 8.0);
    }

    #[test]
    fn second_moment_reproduces_the_example_ix() {
        let ys: Vec<f64> = EXAMPLE_YS.iter().chain(&EXAMPLE_YS).chain(&EXAMPLE_YS).copied().collect();
        assert_eq!(second_moment_of_nail_array(&ys, 295.0), 657150.0);
    }

    #[test]
    fn max_distance_from_the_axis() {
        assert_eq!(max_distance_from_axis(&EXAMPLE_YS, 295.0), 295.0);
        assert_eq!(max_distance_from_axis(&EXAMPLE_XS, 445.0), 445.0);
        assert_eq!(max_distance_from_axis(&[], 0.0), 0.0);
    }

    #[test]
    fn unit_second_moment_reproduces_the_example() {
        close(
            unit_second_moment(657150.0, 1980250.0, 555100.0).unwrap(),
            0.8889,
            1e-3,
        );
    }

    #[test]
    fn unit_second_moment_rejects_a_single_point() {
        assert!(unit_second_moment(0.0, 0.0, 100.0).is_err());
    }

    #[test]
    fn arrangement_coefficients() {
        close(arrangement_coefficient(657150.0, 295.0), 2227.63, 0.1);
        assert_eq!(arrangement_coefficient(1980250.0, 445.0), 4450.0);
    }

    /// 端部距離 0 のとき 0 を返す（0 除算を回避）。
    #[test]
    fn arrangement_coefficient_without_spread_is_zero() {
        assert_eq!(arrangement_coefficient(0.0, 0.0), 0.0);
    }

    #[test]
    fn unit_arrangement_coefficient_reproduces_the_example() {
        close(
            unit_arrangement_coefficient(2228.0, 4450.0, 555100.0),
            0.0036,
            1e-4,
        );
    }

    /// Zx = 0 のとき Zxy = 0（エラーにしない）。
    #[test]
    fn unit_arrangement_coefficient_without_spread_is_zero() {
        assert_eq!(unit_arrangement_coefficient(0.0, 4450.0, 555100.0), 0.0);
    }

    #[test]
    fn deformation_ratio() {
        close(deformation_ratio_x(657150.0, 1980250.0).unwrap(), 0.751, 1e-3);
        assert!(deformation_ratio_x(0.0, 0.0).is_err());
    }

    #[test]
    fn plastic_unit_arrangement_coefficient_reproduces_the_example() {
        let nails = build_rectangular_grid(&EXAMPLE_XS, &EXAMPLE_YS);
        let alpha_x = deformation_ratio_x(657150.0, 1980250.0).unwrap();
        close(
            plastic_unit_arrangement_coefficient(&nails, 445.0, 295.0, alpha_x, 555100.0),
            0.0045,
            1e-4,
        );
    }

    #[test]
    fn yield_ultimate_ratio_divides_zpxy_by_zxy() {
        close(yield_ultimate_ratio(0.0045, 0.0036).unwrap(), 1.25, 1e-12);
    }

    #[test]
    fn yield_ultimate_ratio_is_clamped_to_one() {
        assert_eq!(yield_ultimate_ratio(0.5, 1.0).unwrap(), 1.0);
    }

    #[test]
    fn yield_ultimate_ratio_rejects_zero() {
        assert!(yield_ultimate_ratio(0.1, 0.0).is_err());
    }

    #[test]
    fn rectangular_grid_is_every_combination() {
        let nails = build_rectangular_grid(&EXAMPLE_XS, &EXAMPLE_YS);
        assert_eq!(nails.len(), 15);
        assert_eq!(nails[0], Nail { x: 0.0, y: 0.0 });
        assert_eq!(nails[14], Nail { x: 890.0, y: 590.0 });
    }

    // --- 3. 入力検証・エッジケース --------------------------------------------

    #[test]
    fn compute_rejects_an_empty_nail_list() {
        assert!(compute(&[], 100.0).is_err());
    }

    #[test]
    fn compute_rejects_a_non_positive_area() {
        for area in [0.0, -5.0] {
            assert!(compute(&[Nail { x: 0.0, y: 0.0 }], area).is_err());
        }
    }

    #[test]
    fn compute_rejects_non_finite_coordinates() {
        let nails = [Nail { x: 0.0, y: f64::NAN }];
        assert!(compute(&nails, 100.0).is_err());
    }
}
