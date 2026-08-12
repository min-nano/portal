//! 釘の割り付け（面材寸法・配列の型・ピッチ・へりあきから釘座標を作る）。
//!
//! 実際の設計では、面材の種類（と釘）が先に決まっていて、**面材の配置と釘の
//! 間隔で耐力を調整する**。この module はその調整のしかたをそのまま入力に
//! したもので、面材 1 枚ぶんの
//!
//!   - 面材寸法 W × H
//!   - 配列の型（川型・山型・ロ型・日型）
//!   - 間柱・根太ピッチ
//!   - 釘ピッチ
//!   - へりあき（面材の縁から釘の中心までの距離）
//!
//! から釘 1 本ごとの座標を組み立てる。グレー本 表 3.2.1「標準的なサイズの
//! 面材の釘配列諸定数」の配列（presets.rs）も、へりあき 10 mm を入れたこの
//! 割り付けそのものなので、表の呼び出しは「この欄を埋める」ことになる。
//!
//! 座標系は nail_array と同じで、原点は面材の左下・単位は mm。
//!
//! # 配列の型の読み方
//!
//! 型の名前は、釘を打つ線を漢字の形に見立てたもの。縦線は面材の左右の端 +
//! 間柱（根太）の位置、横線は面材の上下の端（横架材）。
//!
//! | 型   | 縦線（両端 + 中間）        | 横線（上端 / 下端） |
//! | ---- | -------------------------- | ------------------- |
//! | 川型 | あり                       | なし                |
//! | 山型 | あり                       | 下端のみ            |
//! | ロ型 | 両端のみ（中間の間柱なし） | 上端・下端          |
//! | 日型 | あり                       | 上端・下端          |
//!
//! 面材の長辺方向に走る間柱に打たれた釘列は、グレー本 3.3(1)⑧ の理由により
//! 釘配列計算に含めない（表 3.2.1 の縦置の図で ※ が付いている列）。したがって
//! 縦長（H > W）の面材では、中間の縦線を釘配列から外す。
//!
//! # 釘の間隔
//!
//! 1 本の線には両端に必ず 1 本ずつ打ち、その間を釘ピッチちょうどで割り付け、
//! 割り切れない余りは両端の 2 区間へ均等に振り分ける（区間数は「距離 ÷
//! ピッチ」の切り上げ）。グレー本 3.2【解説】の計算例（図 3.2.2、610 mm の
//! 辺に @150）が 10・155・305・455・600 と、中央から等間隔で両端に寄せた
//! 並びになっているのと同じ規則。

use crate::nail_array::Nail;

/// へりあき（面材の縁から釘の中心までの距離）の既定値 [mm]。
///
/// グレー本 3.2【解説】の計算例が 910 × 610 の面材に対して 890 × 590 の
/// 広がりで釘を打っている（両側 10 mm ずつ内側）ことによる。表 3.2.1 の
/// 配列もこの値を前提とする。
///
/// 実際の設計では釘の呼び径や面材の種類に応じて広げることがあるので、画面と
/// 計算書では面材 1 枚ごとの入力欄として扱う（ここはその初期値）。
pub const DEFAULT_EDGE_DISTANCE: f64 = 10.0;

/// 釘を打つ線の組み合わせ（グレー本 表 3.2.1 の「型」）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Arrangement {
    /// 川型: 縦線のみ。
    Kawa,
    /// 山型: 縦線 + 下端の横線。
    Yama,
    /// ロ型: 面材の四周のみ（中間の間柱を設けない）。
    Ro,
    /// 日型: 縦線 + 上下端の横線。
    Hi,
}

/// 画面の一覧に並べる順（表 3.2.1 と同じ並び）。
pub const ARRANGEMENTS: [Arrangement; 4] = [
    Arrangement::Kawa,
    Arrangement::Yama,
    Arrangement::Ro,
    Arrangement::Hi,
];

impl Arrangement {
    pub fn id(self) -> &'static str {
        match self {
            Arrangement::Kawa => "kawa",
            Arrangement::Yama => "yama",
            Arrangement::Ro => "ro",
            Arrangement::Hi => "hi",
        }
    }

    /// id から型を引く（知らない id は日型＝四周打ちとみなす）。
    ///
    /// 面材張り大壁は適用範囲 3.3(1)⑤ で四周打ちと定められているので、
    /// 迷ったときに寄せる先は日型にしてある。
    pub fn from_id(id: &str) -> Arrangement {
        match id {
            "kawa" => Arrangement::Kawa,
            "yama" => Arrangement::Yama,
            "ro" => Arrangement::Ro,
            _ => Arrangement::Hi,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Arrangement::Kawa => "川型",
            Arrangement::Yama => "山型",
            Arrangement::Ro => "ロ型",
            Arrangement::Hi => "日型",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            Arrangement::Kawa => "面材の左右の端と間柱に釘を打つ（上下の横架材には打たない）",
            Arrangement::Yama => "川型に加えて、下端の横架材にも釘を打つ",
            Arrangement::Ro => "面材の四周だけに釘を打つ（中間の間柱を設けない）",
            Arrangement::Hi => "川型に加えて、上下端の横架材にも釘を打つ",
        }
    }

    /// 中間の縦線（間柱・根太）を使う型か。
    pub fn uses_intermediate_studs(self) -> bool {
        !matches!(self, Arrangement::Ro)
    }
}

/// 面材 1 枚ぶんの釘の割り付け。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Layout {
    /// 面材の幅 W [mm]（横方向）。
    pub width: f64,
    /// 面材の高さ H [mm]（縦方向）。
    pub height: f64,
    /// 間柱・根太ピッチ [mm]（面材の幅方向に並ぶ）。
    pub stud_pitch: f64,
    /// 釘ピッチ [mm]。
    pub nail_pitch: f64,
    /// へりあき [mm]。
    pub edge_distance: f64,
    pub arrangement: Arrangement,
}

impl Layout {
    /// 間柱が面材の長辺方向に走るか（＝その釘列を計算に含めない配列か）。
    ///
    /// 間柱は面材の高さ方向に走るので、縦長のときだけ長辺方向になる。正方形は
    /// 長辺が無いため、表 3.2.1 も 910 × 910 / 1000 × 1000 の中間の間柱を
    /// 計算に含めている（縦置と呼んではいるが ※ が付かない）。
    pub fn studs_run_along_the_long_side(&self) -> bool {
        self.height > self.width
    }

    /// 中間の間柱（根太）の釘列を釘配列計算に含めるか。
    pub fn uses_intermediate_studs(&self) -> bool {
        self.arrangement.uses_intermediate_studs()
            && !self.studs_run_along_the_long_side()
            && self.stud_pitch > 0.0
    }

    /// 縦線（釘を打つ間柱・面材の左右の端）の X 座標。
    pub fn stud_positions(&self) -> Vec<f64> {
        let left = self.edge_distance;
        let right = self.width - self.edge_distance;
        let mut positions = vec![left];
        if self.uses_intermediate_studs() {
            let mut index = 1;
            loop {
                let x = self.stud_pitch * index as f64;
                if x >= right {
                    break;
                }
                if x > left {
                    positions.push(x);
                }
                index += 1;
            }
        }
        if right > left {
            positions.push(right);
        }
        positions
    }

    /// この型が釘を打つ横線（面材下端からの高さ）。
    pub fn rows(&self) -> Vec<f64> {
        match self.arrangement {
            Arrangement::Kawa => Vec::new(),
            Arrangement::Yama => vec![self.edge_distance],
            Arrangement::Ro | Arrangement::Hi => {
                vec![self.edge_distance, self.height - self.edge_distance]
            }
        }
    }

    /// 縦線 1 本に打つ釘の Y 座標。
    pub fn column_positions(&self) -> Vec<f64> {
        line_positions(
            self.edge_distance,
            self.height - self.edge_distance,
            self.nail_pitch,
        )
    }

    /// 横線 1 本に打つ釘の X 座標。
    pub fn row_positions(&self) -> Vec<f64> {
        line_positions(
            self.edge_distance,
            self.width - self.edge_distance,
            self.nail_pitch,
        )
    }

    /// 釘の本数（座標を作らずに数える）。
    ///
    /// 桁を間違えた入力（釘ピッチに 1 mm と書くなど）で座標の配列が膨れ上がる
    /// 前に、本数だけを確かめられるようにするためのもの。横線と縦線が交わる
    /// 位置の釘は 1 本と数える（nails() と同じ数になる）。
    pub fn nail_count(&self) -> usize {
        let rows = self.rows().len();
        let studs = self.stud_positions().len();
        let along_row = line_count(
            self.edge_distance,
            self.width - self.edge_distance,
            self.nail_pitch,
        );
        let along_column = line_count(
            self.edge_distance,
            self.height - self.edge_distance,
            self.nail_pitch,
        );
        // 縦線の釘のうち、横線と重なるのは端の rows 本（横線は必ず縦線の
        // 両端の高さに置かれる）。
        rows.saturating_mul(along_row)
            .saturating_add(studs.saturating_mul(along_column.saturating_sub(rows)))
    }

    /// 釘 1 本ごとの座標（X, Y の昇順）。
    pub fn nails(&self) -> Vec<Nail> {
        let rows = self.rows();
        let mut nails = Vec::new();

        // 横線（横架材）。端から端まで釘ピッチで割り付ける。
        for &y in &rows {
            for x in self.row_positions() {
                nails.push(Nail { x, y });
            }
        }
        // 縦線（左右の端・間柱）。横線と重なる位置は、横線の釘がすでにある。
        for x in self.stud_positions() {
            for y in self.column_positions() {
                if rows.iter().any(|row| *row == y) {
                    continue;
                }
                nails.push(Nail { x, y });
            }
        }

        nails.sort_by(|a, b| {
            a.x.partial_cmp(&b.x)
                .expect("釘座標は有限")
                .then(a.y.partial_cmp(&b.y).expect("釘座標は有限"))
        });
        nails
    }
}

/// 1 本の線に打つ釘の位置。
///
/// 両端に 1 本ずつ置き、その間を釘ピッチちょうどで割り付け、割り切れない
/// 余りは両端の 2 区間へ均等に振り分ける。区間数は「距離 ÷ ピッチ」の
/// 切り上げなので、どの区間もピッチを超えない。
pub fn line_positions(low: f64, high: f64, pitch: f64) -> Vec<f64> {
    let span = high - low;
    if !(span > 0.0) {
        return vec![low];
    }
    if !(pitch > 0.0) || pitch >= span {
        return vec![low, high];
    }
    let intervals = (span / pitch).ceil() as usize;
    let inner = intervals - 2;
    let end = (span - inner as f64 * pitch) / 2.0;

    let mut positions = Vec::with_capacity(intervals + 1);
    positions.push(low);
    for index in 0..=inner {
        positions.push(low + end + pitch * index as f64);
    }
    positions.push(high);
    positions
}

/// 1 本の線に打つ釘の本数（位置を作らずに数える）。
pub fn line_count(low: f64, high: f64, pitch: f64) -> usize {
    let span = high - low;
    if !(span > 0.0) {
        return 1;
    }
    if !(pitch > 0.0) || pitch >= span {
        return 2;
    }
    ((span / pitch).ceil() as usize).saturating_add(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout(arrangement: Arrangement) -> Layout {
        Layout {
            width: 910.0,
            height: 610.0,
            stud_pitch: 455.0,
            nail_pitch: 150.0,
            edge_distance: DEFAULT_EDGE_DISTANCE,
            arrangement,
        }
    }

    // --- 釘の割り付け規則 ----------------------------------------------------

    /// グレー本 3.2【解説】の計算例（図 3.2.2）の並び。
    /// 610 mm の辺に @150 → 10, 155, 305, 455, 600（両端の区間だけ 145）。
    #[test]
    fn line_positions_match_the_worked_example() {
        assert_eq!(
            line_positions(10.0, 600.0, 150.0),
            vec![10.0, 155.0, 305.0, 455.0, 600.0]
        );
    }

    #[test]
    fn line_positions_keep_the_pitch_between_the_inner_nails() {
        // 910 mm の辺に @150 → 両端 145、中は 150 ちょうど。
        assert_eq!(
            line_positions(10.0, 900.0, 150.0),
            vec![10.0, 155.0, 305.0, 455.0, 605.0, 755.0, 900.0]
        );
        // 割り切れる場合は等間隔になる。
        assert_eq!(
            line_positions(10.0, 1810.0, 150.0),
            (0..=12)
                .map(|i| 10.0 + 150.0 * i as f64)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn line_positions_never_exceed_the_pitch() {
        for (low, high, pitch) in [
            (10.0, 600.0, 150.0),
            (10.0, 3020.0, 75.0),
            (10.0, 990.0, 100.0),
        ] {
            let positions = line_positions(low, high, pitch);
            for pair in positions.windows(2) {
                assert!(
                    pair[1] - pair[0] <= pitch + 1e-9,
                    "{pair:?} exceeds {pitch}"
                );
            }
            assert_eq!(positions.first(), Some(&low));
            assert_eq!(positions.last(), Some(&high));
        }
    }

    #[test]
    fn line_positions_fall_back_to_the_two_ends() {
        assert_eq!(line_positions(10.0, 600.0, 0.0), vec![10.0, 600.0]);
        assert_eq!(line_positions(10.0, 600.0, 900.0), vec![10.0, 600.0]);
        assert_eq!(line_positions(10.0, 10.0, 150.0), vec![10.0]);
    }

    // --- 縦線・横線の位置 ----------------------------------------------------

    /// 横長の面材は、間柱の位置にも釘列が入る。
    #[test]
    fn stud_positions_include_the_intermediate_studs_of_a_landscape_panel() {
        let wide = Layout {
            width: 1820.0,
            height: 910.0,
            ..layout(Arrangement::Kawa)
        };
        assert_eq!(
            wide.stud_positions(),
            vec![10.0, 455.0, 910.0, 1365.0, 1810.0]
        );
        assert_eq!(
            Layout {
                stud_pitch: 910.0,
                ..wide
            }
            .stud_positions(),
            vec![10.0, 910.0, 1810.0]
        );
    }

    /// 縦長の面材では、長辺方向の間柱の釘列を含めない（3.3(1)⑧）。
    #[test]
    fn stud_positions_drop_the_intermediate_studs_of_a_portrait_panel() {
        let tall = Layout {
            width: 910.0,
            height: 3030.0,
            ..layout(Arrangement::Kawa)
        };
        assert_eq!(tall.stud_positions(), vec![10.0, 900.0]);
    }

    /// ロ型は中間の間柱を設けない。
    #[test]
    fn stud_positions_of_the_ro_arrangement_are_the_two_edges() {
        assert_eq!(layout(Arrangement::Ro).stud_positions(), vec![10.0, 900.0]);
    }

    /// 間柱ピッチが入っていない（0）ときは、中間の縦線を置かない。
    /// ピッチ 0 で位置を数え上げると終わらないため、割り付けの側で止める。
    #[test]
    fn stud_positions_without_a_pitch_are_the_two_edges() {
        let without = Layout {
            stud_pitch: 0.0,
            ..layout(Arrangement::Hi)
        };
        assert_eq!(without.stud_positions(), vec![10.0, 900.0]);
        assert!(!without.uses_intermediate_studs());
    }

    /// 型ごとの横線（山型は下端だけ、ロ型・日型は上下端）。
    #[test]
    fn rows_follow_the_arrangement() {
        assert!(layout(Arrangement::Kawa).rows().is_empty());
        assert_eq!(layout(Arrangement::Yama).rows(), vec![10.0]);
        assert_eq!(layout(Arrangement::Ro).rows(), vec![10.0, 600.0]);
        assert_eq!(layout(Arrangement::Hi).rows(), vec![10.0, 600.0]);
    }

    // --- 釘座標 --------------------------------------------------------------

    /// 川型（縦線のみ）は、グレー本 3.2【解説】の計算例そのもの（釘 15 本）。
    #[test]
    fn the_worked_example_is_a_layout() {
        let nails = layout(Arrangement::Kawa).nails();
        assert_eq!(nails.len(), 15);
        assert_eq!(nails[0], Nail { x: 10.0, y: 10.0 });
        assert_eq!(nails[14], Nail { x: 900.0, y: 600.0 });
    }

    /// 横線と縦線が交わる位置の釘は 1 本だけ（二重に数えない）。
    #[test]
    fn nails_are_not_duplicated_where_the_lines_cross() {
        let nails = layout(Arrangement::Hi).nails();
        for (index, nail) in nails.iter().enumerate() {
            for other in &nails[index + 1..] {
                assert!(
                    nail.x != other.x || nail.y != other.y,
                    "({}, {}) が重複しています",
                    nail.x,
                    nail.y
                );
            }
        }
    }

    /// 釘はすべて、へりあきの分だけ面材の内側に入る。
    #[test]
    fn nails_stay_inside_the_panel() {
        for arrangement in ARRANGEMENTS {
            let layout = Layout {
                edge_distance: 15.0,
                ..layout(arrangement)
            };
            for nail in layout.nails() {
                assert!(
                    nail.x >= 15.0 - 1e-9
                        && nail.x <= layout.width - 15.0 + 1e-9
                        && nail.y >= 15.0 - 1e-9
                        && nail.y <= layout.height - 15.0 + 1e-9,
                    "釘 ({}, {}) が面材からはみ出しています",
                    nail.x,
                    nail.y
                );
            }
        }
    }

    /// へりあきを広げると釘の広がりが縮む（同じピッチなら本数は増えない）。
    #[test]
    fn a_wider_edge_distance_pulls_the_nails_in() {
        let narrow = layout(Arrangement::Hi);
        let wide = Layout {
            edge_distance: 20.0,
            ..narrow
        };
        assert_eq!(narrow.stud_positions().first(), Some(&10.0));
        assert_eq!(wide.stud_positions().first(), Some(&20.0));
        assert!(wide.nails().len() <= narrow.nails().len());
    }

    /// 本数だけを数えた値は、実際に作った座標の数と一致する。
    #[test]
    fn the_nail_count_matches_the_coordinates() {
        for arrangement in ARRANGEMENTS {
            for (width, height, stud_pitch, nail_pitch, edge) in [
                (910.0, 610.0, 455.0, 150.0, 10.0),
                (910.0, 3030.0, 455.0, 75.0, 15.0),
                (1820.0, 910.0, 910.0, 100.0, 10.0),
                (1000.0, 1000.0, 500.0, 150.0, 12.0),
            ] {
                let layout = Layout {
                    width,
                    height,
                    stud_pitch,
                    nail_pitch,
                    edge_distance: edge,
                    arrangement,
                };
                assert_eq!(
                    layout.nail_count(),
                    layout.nails().len(),
                    "{arrangement:?} {width}×{height}"
                );
            }
        }
    }

    /// 桁を間違えたピッチでも、座標を作る前に本数で気付ける。
    #[test]
    fn the_nail_count_grows_with_a_tiny_pitch() {
        let dense = Layout {
            nail_pitch: 1.0,
            ..layout(Arrangement::Hi)
        };
        assert!(dense.nail_count() > 2000);
    }

    #[test]
    fn arrangements_can_be_read_from_their_id() {
        for arrangement in ARRANGEMENTS {
            assert_eq!(Arrangement::from_id(arrangement.id()), arrangement);
        }
        // 知らない型は四周打ち（日型）とみなす（適用範囲 3.3(1)⑤）。
        assert_eq!(Arrangement::from_id("なにか"), Arrangement::Hi);
    }
}
