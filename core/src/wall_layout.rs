//! 壁の中での面材の配置（壁内の面材配列）と、その配置と計算の突き合わせ。
//!
//! 面材張り大壁の剛性・許容せん断耐力（グレー本 3.3）は、面材ごとの K0・My・
//! Mu を足して塑性率 μ の最小値を採るだけなので、**面材を壁のどこに張るかは
//! 数値に影響しない**（枚数だけで計算できる）。それでも配置を入力できるように
//! してあるのは、計算書を読む人に
//!
//!   - この壁をどう張り分けた前提の計算なのか
//!
//! が伝わるようにするためと、**配置と計算の食い違い**をその場で拾うため:
//!
//!   - 面材が壁からはみ出している（壁の寸法か面材の寸法のどちらかが違う）
//!   - 同じ面に張った面材どうしが重なっている（枚数を二重に数えている）
//!   - 配置を入れた面材と入れていない面材が混ざっている（図が計算より少ない）
//!
//! 配置は面材ごとの任意入力で、1 枚も入っていない壁は今までどおり枚数だけで
//! 計算する（配列図も配置の検定も出さない）。
//!
//! 座標系は壁の左下を原点とし、x は右・y は上・単位は mm。面材の位置は
//! **その面材の左下**で表す（釘座標が面材の左下を原点にしているのと同じ
//! 取り方なので、面材の中の釘座標へそのまま足せば壁の中の釘の位置になる）。

/// 配置が重なっている・はみ出していると見なす下限 [mm]。
///
/// 突き付けて張った面材（910 の隣に 910）は境界がぴったり重なるので、
/// 「触れている」を重なりと呼ばないための幅。入力は mm 単位なので、この
/// 幅で判定が変わることはない。
pub const TOLERANCE: f64 = 1e-6;

/// 面材を張る面。壁の両面に張る（両面張り）ことがあるので、配列図は面ごとに
/// 描き、重なりの判定も同じ面の中だけで行う。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    /// 表面。指定が無ければこちら。
    Front,
    /// 裏面（両面張りの反対側）。
    Back,
}

/// 画面の選択肢に並べる順。
pub const SIDES: [Side; 2] = [Side::Front, Side::Back];

impl Side {
    pub fn id(self) -> &'static str {
        match self {
            Side::Front => "front",
            Side::Back => "back",
        }
    }

    /// id から面を引く（知らない id は表面とみなす）。
    pub fn from_id(id: &str) -> Side {
        match id {
            "back" => Side::Back,
            _ => Side::Front,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Side::Front => "表面",
            Side::Back => "裏面",
        }
    }
}

/// 配列図に並べる面材 1 枚（名前・寸法・張る面・壁の中での位置）。
#[derive(Debug, Clone, PartialEq)]
pub struct Piece {
    /// 面材の名前（画面・計算書で指し示すもの）。
    pub label: String,
    /// 面材の幅 W [mm]。
    pub width: f64,
    /// 面材の高さ H [mm]。
    pub height: f64,
    pub side: Side,
    /// 壁の左下を原点とした、この面材の左下の位置 [mm]。未入力なら None。
    pub origin: Option<(f64, f64)>,
}

impl Piece {
    /// 壁の中で占める矩形（左, 下, 右, 上）。配置が無ければ None。
    fn rect(&self) -> Option<(f64, f64, f64, f64)> {
        let (x, y) = self.origin?;
        Some((x, y, x + self.width, y + self.height))
    }

    pub fn area(&self) -> f64 {
        self.width * self.height
    }
}

/// 配置の検分の結果。面材ごとの旗は `pieces` と同じ並びで返す。
#[derive(Debug, Clone, PartialEq)]
pub struct Inspection {
    /// この面材が壁からはみ出しているか。
    pub outside: Vec<bool>,
    /// この面材が、同じ面の別の面材と重なっているか。
    pub overlapping: Vec<bool>,
    /// 壁内の位置を入れていない面材の名前。
    pub unplaced: Vec<String>,
    /// 重なっている面材の組（名前の対）。
    pub overlaps: Vec<(String, String)>,
    /// 壁内の位置を入れた面材の枚数。
    pub placed: usize,
    /// 面ごとの、張った面材の枚数と面積の和 [mm²]（配置した面材だけ）。
    ///
    /// 重なっていれば面積を二重に数えるが、そのときは重なりのほうが先に
    /// NG になるので、この値だけを見て判断することはない。
    pub sides: Vec<(Side, usize, f64)>,
    /// はみ出し・重なり・配置漏れのどれも無いか。
    pub ok: bool,
}

/// 壁と面材の配置を突き合わせる。
///
/// 壁の寸法が入っていない（0 以下の）ときは、はみ出しを判定しない
/// （寸法そのものが未入力の途中経過なので、そちらの不備として扱われる）。
pub fn inspect(wall_width: f64, wall_height: f64, pieces: &[Piece]) -> Inspection {
    let known_wall = wall_width > 0.0 && wall_height > 0.0;

    let outside: Vec<bool> = pieces
        .iter()
        .map(|piece| match piece.rect() {
            Some((left, bottom, right, top)) if known_wall => {
                left < -TOLERANCE
                    || bottom < -TOLERANCE
                    || right > wall_width + TOLERANCE
                    || top > wall_height + TOLERANCE
            }
            _ => false,
        })
        .collect();

    let mut overlapping = vec![false; pieces.len()];
    let mut overlaps = Vec::new();
    for (index, piece) in pieces.iter().enumerate() {
        for (other_index, other) in pieces.iter().enumerate().skip(index + 1) {
            if piece.side != other.side {
                continue;
            }
            let (Some(left), Some(right)) = (piece.rect(), other.rect()) else {
                continue;
            };
            if !overlaps_rect(left, right) {
                continue;
            }
            overlapping[index] = true;
            overlapping[other_index] = true;
            overlaps.push((piece.label.clone(), other.label.clone()));
        }
    }

    let placed = pieces.iter().filter(|piece| piece.origin.is_some()).count();
    let unplaced: Vec<String> = pieces
        .iter()
        .filter(|piece| piece.origin.is_none())
        .map(|piece| piece.label.clone())
        .collect();

    // 面ごとのまとめは、実際に使われている面だけを SIDES の並びで返す
    //（片面張りの壁に、空の「裏面」を出さない）。
    let sides: Vec<(Side, usize, f64)> = SIDES
        .iter()
        .filter_map(|side| {
            let placed: Vec<&Piece> = pieces
                .iter()
                .filter(|piece| piece.side == *side && piece.origin.is_some())
                .collect();
            if placed.is_empty() {
                return None;
            }
            let area = placed.iter().map(|piece| piece.area()).sum();
            Some((*side, placed.len(), area))
        })
        .collect();

    Inspection {
        ok: placed > 0
            && unplaced.is_empty()
            && overlaps.is_empty()
            && !outside.iter().any(|flag| *flag),
        outside,
        overlapping,
        unplaced,
        overlaps,
        placed,
        sides,
    }
}

/// 2 つの矩形が（辺で触れているだけでなく）重なっているか。
fn overlaps_rect(left: (f64, f64, f64, f64), right: (f64, f64, f64, f64)) -> bool {
    let width = left.2.min(right.2) - left.0.max(right.0);
    let height = left.3.min(right.3) - left.1.max(right.1);
    width > TOLERANCE && height > TOLERANCE
}

/// 1 つの面を描くのに要る範囲（壁枠と、その面に置いた面材の外接矩形）。
///
/// 面材が壁からはみ出していても切り取らず、はみ出していることが図で見える
/// ようにする（釘配列図が、面材からはみ出した釘をそのまま描くのと同じ）。
pub fn bounds(wall_width: f64, wall_height: f64, pieces: &[Piece]) -> (f64, f64, f64, f64) {
    let mut min_x = 0.0_f64;
    let mut min_y = 0.0_f64;
    let mut max_x = wall_width;
    let mut max_y = wall_height;
    for piece in pieces {
        if let Some((left, bottom, right, top)) = piece.rect() {
            min_x = min_x.min(left);
            min_y = min_y.min(bottom);
            max_x = max_x.max(right);
            max_y = max_y.max(top);
        }
    }
    (min_x, min_y, max_x, max_y)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn piece(label: &str, width: f64, height: f64, origin: Option<(f64, f64)>) -> Piece {
        Piece {
            label: label.to_string(),
            width,
            height,
            side: Side::Front,
            origin,
        }
    }

    /// グレー本 3.3(3) の計算例（図 3.3.10）の張り方。
    /// 幅 910・階高 3000 の壁に、下から 910×1820、その上に 910×910。
    fn example() -> Vec<Piece> {
        vec![
            piece("下段", 910.0, 1820.0, Some((0.0, 0.0))),
            piece("上段", 910.0, 910.0, Some((0.0, 1820.0))),
        ]
    }

    #[test]
    fn stacked_panels_that_touch_are_not_an_overlap() {
        let inspection = inspect(910.0, 3000.0, &example());

        assert!(inspection.ok);
        assert_eq!(inspection.placed, 2);
        assert!(inspection.overlaps.is_empty());
        assert!(inspection.unplaced.is_empty());
        assert_eq!(inspection.outside, vec![false, false]);
        // 面ごとのまとめは、使っている面だけ（片面張りなので 1 つ）。
        assert_eq!(
            inspection.sides,
            vec![(Side::Front, 2, 910.0 * 1820.0 + 910.0 * 910.0)]
        );
    }

    #[test]
    fn a_panel_taller_than_the_wall_sticks_out() {
        let mut pieces = example();
        pieces[1].origin = Some((0.0, 2500.0)); // 2500 + 910 > 3000

        let inspection = inspect(910.0, 3000.0, &pieces);

        assert!(!inspection.ok);
        assert_eq!(inspection.outside, vec![false, true]);
    }

    #[test]
    fn a_panel_wider_than_the_wall_sticks_out() {
        let inspection = inspect(910.0, 3000.0, &[piece("下段", 1820.0, 910.0, Some((0.0, 0.0)))]);

        assert_eq!(inspection.outside, vec![true]);
    }

    #[test]
    fn a_negative_position_sticks_out() {
        let inspection = inspect(910.0, 3000.0, &[piece("下段", 910.0, 910.0, Some((-10.0, 0.0)))]);

        assert_eq!(inspection.outside, vec![true]);
    }

    #[test]
    fn panels_on_the_same_side_must_not_overlap() {
        let mut pieces = example();
        pieces[1].origin = Some((0.0, 1000.0)); // 下段（0〜1820）に食い込む

        let inspection = inspect(910.0, 3000.0, &pieces);

        assert!(!inspection.ok);
        assert_eq!(inspection.overlapping, vec![true, true]);
        assert_eq!(
            inspection.overlaps,
            vec![("下段".to_string(), "上段".to_string())]
        );
    }

    /// 両面張りは、表と裏の同じ場所に面材が来て当たり前なので重なりではない。
    #[test]
    fn the_two_sides_of_a_wall_never_overlap_each_other() {
        let mut pieces = example();
        pieces.push(Piece {
            side: Side::Back,
            ..piece("裏 下段", 910.0, 1820.0, Some((0.0, 0.0)))
        });

        let inspection = inspect(910.0, 3000.0, &pieces);

        assert!(inspection.ok);
        assert!(inspection.overlaps.is_empty());
        assert_eq!(
            inspection.sides,
            vec![
                (Side::Front, 2, 910.0 * 1820.0 + 910.0 * 910.0),
                (Side::Back, 1, 910.0 * 1820.0),
            ]
        );
    }

    /// 配置を入れた面材と入れていない面材が混ざると、図が計算より少なくなる。
    #[test]
    fn a_panel_without_a_position_is_reported() {
        let mut pieces = example();
        pieces.push(piece("忘れた面材", 910.0, 910.0, None));

        let inspection = inspect(910.0, 3000.0, &pieces);

        assert!(!inspection.ok);
        assert_eq!(inspection.placed, 2);
        assert_eq!(inspection.unplaced, vec!["忘れた面材".to_string()]);
    }

    /// 1 枚も配置が入っていない壁は「配置を書いていない」だけ（NG にしない
    /// 側の判断は呼ぶ側が持つが、ok は立たない）。
    #[test]
    fn a_wall_without_any_position_has_nothing_placed() {
        let inspection = inspect(910.0, 3000.0, &[piece("面材1", 910.0, 910.0, None)]);

        assert_eq!(inspection.placed, 0);
        assert!(!inspection.ok);
        assert!(inspection.sides.is_empty());
    }

    /// 壁の寸法が未入力のうちは、はみ出しを判定しない。
    #[test]
    fn an_unknown_wall_size_does_not_report_an_overhang() {
        let inspection = inspect(0.0, 0.0, &example());

        assert_eq!(inspection.outside, vec![false, false]);
    }

    #[test]
    fn the_drawing_range_covers_the_wall_and_every_panel() {
        let mut pieces = example();
        pieces[1].origin = Some((-100.0, 2500.0));

        assert_eq!(bounds(910.0, 3000.0, &pieces), (-100.0, 0.0, 910.0, 3410.0));
        // 壁の中に収まっていれば、範囲は壁そのもの。
        assert_eq!(bounds(910.0, 3000.0, &example()), (0.0, 0.0, 910.0, 3000.0));
    }

    #[test]
    fn sides_can_be_read_from_their_id() {
        for side in SIDES {
            assert_eq!(Side::from_id(side.id()), side);
        }
        assert_eq!(Side::from_id("なにか"), Side::Front);
    }
}
