//! グレー本 表 3.2.1「標準的なサイズの面材の釘配列諸定数」の釘配列。
//!
//! 表 3.2.1 は、実務でよく使う面材寸法・間柱（根太）ピッチ・釘ピッチの
//! 組み合わせについて、釘配列諸定数 Ixy・Zxy・Cxy をまとめたもの。ここには
//! **その表に載っている配列そのもの**（釘 1 本ごとの座標）を組み立てる規則を
//! 置き、画面から「呼び出せる配列」として一覧できるようにする。
//!
//! 座標系は nail_array と同じで、原点は面材の左下・単位は mm。へりあき
//! （EDGE_DISTANCE）を見込むので、釘は面材の内側に収まる。
//!
//! # 表の配列（型）の読み方
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

use crate::json::Value;
use crate::nail_array::Nail;

/// へりあき（面材の縁から釘までの距離）[mm]。
///
/// グレー本 3.2【解説】の計算例が 910 × 610 の面材に対して 890 × 590 の
/// 広がりで釘を打っている（両側 10 mm ずつ内側）ことによる。
pub const EDGE_DISTANCE: f64 = 10.0;

/// 釘を打つ線の組み合わせ（表 3.2.1 の「型」）。
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

impl Arrangement {
    pub fn id(self) -> &'static str {
        match self {
            Arrangement::Kawa => "kawa",
            Arrangement::Yama => "yama",
            Arrangement::Ro => "ro",
            Arrangement::Hi => "hi",
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
    fn uses_intermediate_studs(self) -> bool {
        !matches!(self, Arrangement::Ro)
    }

    /// この型が釘を打つ横線（面材下端からの高さ）。
    fn rows(self, height: f64) -> Vec<f64> {
        match self {
            Arrangement::Kawa => Vec::new(),
            Arrangement::Yama => vec![EDGE_DISTANCE],
            Arrangement::Ro | Arrangement::Hi => vec![EDGE_DISTANCE, height - EDGE_DISTANCE],
        }
    }
}

/// 表 3.2.1 の 1 つの配列（面材寸法・ピッチ・型の組み合わせ）。
#[derive(Debug, Clone, PartialEq)]
pub struct Preset {
    /// 面材の幅 W [mm]（横方向）。
    pub width: f64,
    /// 面材の高さ H [mm]（縦方向）。
    pub height: f64,
    /// 間柱・根太ピッチ [mm]（面材の幅方向に並ぶ）。
    pub stud_pitch: f64,
    /// 釘ピッチ [mm]。
    pub nail_pitch: f64,
    pub arrangement: Arrangement,
}

/// 表 3.2.1 の 1 行（面材寸法とピッチの組み合わせ）。
struct Row {
    width: f64,
    height: f64,
    stud_pitch: f64,
    nail_pitches: &'static [f64],
    /// ロ型（中間の間柱を設けない配列）が表に載っている行か。
    has_ro: bool,
}

const SHAKU_PITCHES: &[f64] = &[150.0, 100.0, 75.0];
const METER_PITCHES: &[f64] = &[150.0];

/// 表 3.2.1 に載っている面材寸法とピッチの組み合わせ。
///
/// 上段が尺モジュール（間柱・根太 @455 / @910、釘 @150・@100・@75）、
/// 下段がメーターモジュール（@500 / @1000、釘 @150）。
const CATALOGUE: &[Row] = &[
    // 尺モジュール・間柱（根太）@455
    row(910.0, 3030.0, 455.0, SHAKU_PITCHES, false),
    row(910.0, 2730.0, 455.0, SHAKU_PITCHES, false),
    row(910.0, 1820.0, 455.0, SHAKU_PITCHES, false),
    row(910.0, 910.0, 455.0, SHAKU_PITCHES, true),
    row(910.0, 610.0, 455.0, SHAKU_PITCHES, true),
    row(1820.0, 910.0, 455.0, SHAKU_PITCHES, false),
    row(1820.0, 610.0, 455.0, SHAKU_PITCHES, false),
    // 尺モジュール・間柱（根太）@910
    row(1820.0, 910.0, 910.0, SHAKU_PITCHES, false),
    row(1820.0, 610.0, 910.0, SHAKU_PITCHES, false),
    // メーターモジュール・間柱（根太）@500
    row(1000.0, 2000.0, 500.0, METER_PITCHES, false),
    row(1000.0, 1000.0, 500.0, METER_PITCHES, true),
    row(2000.0, 1000.0, 500.0, METER_PITCHES, false),
    row(2000.0, 600.0, 500.0, METER_PITCHES, false),
    // メーターモジュール・間柱（根太）@1000
    row(2000.0, 1000.0, 1000.0, METER_PITCHES, false),
    row(2000.0, 600.0, 1000.0, METER_PITCHES, false),
];

const fn row(
    width: f64,
    height: f64,
    stud_pitch: f64,
    nail_pitches: &'static [f64],
    has_ro: bool,
) -> Row {
    Row {
        width,
        height,
        stud_pitch,
        nail_pitches,
        has_ro,
    }
}

/// 表 3.2.1 に載っている配列を、表と同じ並びで返す。
pub fn all() -> Vec<Preset> {
    let mut presets = Vec::new();
    for row in CATALOGUE {
        for &nail_pitch in row.nail_pitches {
            for arrangement in [
                Arrangement::Kawa,
                Arrangement::Yama,
                Arrangement::Ro,
                Arrangement::Hi,
            ] {
                if arrangement == Arrangement::Ro && !row.has_ro {
                    continue;
                }
                presets.push(Preset {
                    width: row.width,
                    height: row.height,
                    stud_pitch: row.stud_pitch,
                    nail_pitch,
                    arrangement,
                });
            }
        }
    }
    presets
}

/// id から配列を引く（知らない id なら None）。
pub fn find(id: &str) -> Option<Preset> {
    all().into_iter().find(|preset| preset.id() == id)
}

impl Preset {
    /// 画面が配列を指定するための id。
    pub fn id(&self) -> String {
        format!(
            "{}x{}-s{}-n{}-{}",
            number(self.width),
            number(self.height),
            number(self.stud_pitch),
            number(self.nail_pitch),
            self.arrangement.id()
        )
    }

    /// 縦置き（面材の長辺が縦）か。正方形は表 3.2.1 に合わせて縦置と呼ぶ。
    pub fn is_portrait(&self) -> bool {
        self.height >= self.width
    }

    /// 間柱が面材の長辺方向に走るか（＝その釘列を計算に含めない配列か）。
    ///
    /// 間柱は面材の高さ方向に走るので、縦長のときだけ長辺方向になる。正方形は
    /// 長辺が無いため、表 3.2.1 も 910 × 910 / 1000 × 1000 の中間の間柱を
    /// 計算に含めている（縦置と呼んではいるが ※ が付かない）。
    fn studs_run_along_the_long_side(&self) -> bool {
        self.height > self.width
    }

    pub fn orientation_label(&self) -> &'static str {
        if self.is_portrait() {
            "縦置"
        } else {
            "横置"
        }
    }

    /// 表 3.2.1 の「面材サイズ」欄と同じ表記（長辺 × 短辺）。
    pub fn size_label(&self) -> String {
        let (long, short) = if self.is_portrait() {
            (self.height, self.width)
        } else {
            (self.width, self.height)
        };
        format!("{}×{}", number(long), number(short))
    }

    /// 一覧に出す名前。
    pub fn label(&self) -> String {
        format!(
            "{} {}・{}（間柱・根太 @{} / 釘 @{}）",
            self.size_label(),
            self.orientation_label(),
            self.arrangement.label(),
            number(self.stud_pitch),
            number(self.nail_pitch)
        )
    }

    /// 縦線（釘を打つ間柱・面材の左右の端）の X 座標。
    ///
    /// 面材の長辺方向に走る間柱の釘列は釘配列計算に含めない（3.3(1)⑧）ため、
    /// 縦長の面材では中間の間柱を外す。
    pub fn stud_positions(&self) -> Vec<f64> {
        let left = EDGE_DISTANCE;
        let right = self.width - EDGE_DISTANCE;
        let mut positions = vec![left];
        if self.arrangement.uses_intermediate_studs() && !self.studs_run_along_the_long_side() {
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

    /// 釘 1 本ごとの座標（X, Y の昇順）。
    pub fn nails(&self) -> Vec<Nail> {
        let rows = self.arrangement.rows(self.height);
        let mut nails = Vec::new();

        // 横線（横架材）。端から端まで釘ピッチで割り付ける。
        for &y in &rows {
            for x in line_positions(EDGE_DISTANCE, self.width - EDGE_DISTANCE, self.nail_pitch) {
                nails.push(Nail { x, y });
            }
        }
        // 縦線（左右の端・間柱）。横線と重なる位置は、横線の釘がすでにある。
        for x in self.stud_positions() {
            for y in line_positions(EDGE_DISTANCE, self.height - EDGE_DISTANCE, self.nail_pitch) {
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

    /// この配列をフォーム 1 パターン分の入力として書き出す。
    ///
    /// 川型は縦線だけの格子なので、そのまま「格子」入力にする（X と Y を
    /// 直せる形で渡るほうが、実際の設計に合わせて手を入れやすい）。
    /// 横線が加わる型は格子で表せないので、座標を直接並べる。
    pub fn to_pattern_value(&self) -> Value {
        let (mode, grid_x, grid_y, coords) = if self.arrangement == Arrangement::Kawa {
            (
                "grid",
                join(&self.stud_positions()),
                join(&line_positions(
                    EDGE_DISTANCE,
                    self.height - EDGE_DISTANCE,
                    self.nail_pitch,
                )),
                String::new(),
            )
        } else {
            let coords = self
                .nails()
                .iter()
                .map(|nail| format!("{}, {}", number(nail.x), number(nail.y)))
                .collect::<Vec<_>>()
                .join("\n");
            ("coords", String::new(), String::new(), coords)
        };
        Value::obj([
            ("patternName", self.label().into()),
            ("width", self.width.into()),
            ("height", self.height.into()),
            ("mode", mode.into()),
            ("gridX", grid_x.into()),
            ("gridY", grid_y.into()),
            ("coords", coords.into()),
        ])
    }

    /// 一覧に出す情報（釘座標は含めない。選ばれてから組み立てる）。
    pub fn to_value(&self) -> Value {
        Value::obj([
            ("id", self.id().into()),
            ("label", self.label().into()),
            ("sizeLabel", self.size_label().into()),
            ("orientation", self.orientation_label().into()),
            ("arrangement", self.arrangement.id().into()),
            ("arrangementLabel", self.arrangement.label().into()),
            ("arrangementNote", self.arrangement.description().into()),
            ("width", self.width.into()),
            ("height", self.height.into()),
            ("studPitch", self.stud_pitch.into()),
            ("nailPitch", self.nail_pitch.into()),
            ("nailCount", self.nails().len().into()),
        ])
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

/// 座標を入力欄の文字列にする（3 桁区切りは付けない。区切りに使う「,」と
/// 混ざってしまうため）。
fn number(value: f64) -> String {
    format!("{value}")
}

fn join(values: &[f64]) -> String {
    values
        .iter()
        .map(|value| number(*value))
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    //! テストの構成:
    //!   1. 釘の割り付け規則（線 1 本・縦線の位置）。
    //!   2. 一覧としての体裁（件数・id の一意性・書き出す入力の形）。
    //!   3. グレー本 表 3.2.1 の Ixy・Zxy・Cxy との突き合わせ（本節の主眼）。

    use super::*;
    use crate::nail_array;
    use crate::report::{self, Pattern};

    // --- 1. 割り付け規則 -----------------------------------------------------

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

    fn preset(id: &str) -> Preset {
        find(id).unwrap_or_else(|| panic!("{id} が一覧にありません"))
    }

    /// 横長の面材は、間柱の位置にも釘列が入る。
    #[test]
    fn stud_positions_include_the_intermediate_studs_of_a_landscape_panel() {
        assert_eq!(
            preset("1820x910-s455-n150-kawa").stud_positions(),
            vec![10.0, 455.0, 910.0, 1365.0, 1810.0]
        );
        assert_eq!(
            preset("1820x910-s910-n150-kawa").stud_positions(),
            vec![10.0, 910.0, 1810.0]
        );
    }

    /// 縦長の面材では、長辺方向の間柱の釘列を含めない（3.3(1)⑧）。
    #[test]
    fn stud_positions_drop_the_intermediate_studs_of_a_portrait_panel() {
        assert_eq!(
            preset("910x3030-s455-n150-kawa").stud_positions(),
            vec![10.0, 900.0]
        );
    }

    /// ロ型は中間の間柱を設けない。
    #[test]
    fn stud_positions_of_the_ro_arrangement_are_the_two_edges() {
        assert_eq!(
            preset("910x610-s455-n150-ro").stud_positions(),
            vec![10.0, 900.0]
        );
    }

    /// 横線と縦線が交わる位置の釘は 1 本だけ（二重に数えない）。
    #[test]
    fn nails_are_not_duplicated_where_the_lines_cross() {
        let nails = preset("910x610-s455-n150-hi").nails();
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

    /// 釘はすべて面材の内側（へりあきの分だけ内側）に入る。
    #[test]
    fn nails_stay_inside_the_panel() {
        for preset in all() {
            for nail in preset.nails() {
                assert!(
                    nail.x >= EDGE_DISTANCE - 1e-9
                        && nail.x <= preset.width - EDGE_DISTANCE + 1e-9
                        && nail.y >= EDGE_DISTANCE - 1e-9
                        && nail.y <= preset.height - EDGE_DISTANCE + 1e-9,
                    "{} の釘 ({}, {}) が面材からはみ出しています",
                    preset.id(),
                    nail.x,
                    nail.y
                );
            }
        }
    }

    /// 川型（縦線のみ）は、グレー本 3.2【解説】の計算例そのもの。
    #[test]
    fn the_worked_example_is_one_of_the_presets() {
        let preset = preset("910x610-s455-n150-kawa");
        let pattern = preset.to_pattern_value();
        assert_eq!(pattern.get("mode").unwrap().as_str(), Some("grid"));
        assert_eq!(pattern.get("gridX").unwrap().as_str(), Some("10, 455, 900"));
        assert_eq!(
            pattern.get("gridY").unwrap().as_str(),
            Some("10, 155, 305, 455, 600")
        );
        assert_eq!(preset.nails().len(), 15);
    }

    // --- 2. 一覧としての体裁 -------------------------------------------------

    /// 表 3.2.1 は 33 通りの寸法・ピッチ × 型 = 106 の配列を載せている。
    #[test]
    fn the_catalogue_covers_the_whole_table() {
        let presets = all();
        assert_eq!(presets.len(), 106);
        assert_eq!(
            presets
                .iter()
                .filter(|preset| preset.arrangement == Arrangement::Ro)
                .count(),
            7
        );
    }

    #[test]
    fn ids_are_unique_and_can_be_looked_up() {
        let mut ids: Vec<String> = all().iter().map(Preset::id).collect();
        let count = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), count);
        for id in ids {
            assert_eq!(find(&id).unwrap().id(), id);
        }
    }

    #[test]
    fn unknown_ids_are_not_found() {
        assert_eq!(find("なにか"), None);
    }

    #[test]
    fn labels_name_the_size_orientation_and_arrangement() {
        assert_eq!(
            preset("910x3030-s455-n150-kawa").label(),
            "3030×910 縦置・川型（間柱・根太 @455 / 釘 @150）"
        );
        assert_eq!(
            preset("1820x610-s910-n75-hi").label(),
            "1820×610 横置・日型（間柱・根太 @910 / 釘 @75）"
        );
    }

    /// 横線を持つ型は座標をそのまま並べる（格子では表せない）。
    #[test]
    fn arrangements_with_rows_are_written_as_coordinates() {
        let pattern = preset("910x610-s455-n150-yama").to_pattern_value();
        assert_eq!(pattern.get("mode").unwrap().as_str(), Some("coords"));
        let coords = pattern.get("coords").unwrap().as_str().unwrap();
        assert!(coords.starts_with("10, 10\n10, 155\n"), "{coords}");
        assert_eq!(
            coords.lines().count(),
            preset("910x610-s455-n150-yama").nails().len()
        );
    }

    /// 書き出した入力は、フォームの入力としてそのまま計算できる。
    #[test]
    fn every_preset_can_be_calculated_as_a_form_pattern() {
        for preset in all() {
            let pattern = report::normalize_pattern(&preset.to_pattern_value(), 0).unwrap();
            let nails = report::nails_of(&pattern).unwrap_or_else(|error| {
                panic!("{} を計算できません: {error}", preset.id());
            });
            assert_eq!(nails.len(), preset.nails().len(), "{}", preset.id());
            assert!(nail_array::compute(&nails, pattern.panel_area()).is_ok());
        }
    }

    // --- 3. グレー本 表 3.2.1 との突き合わせ ---------------------------------

    /// 表 3.2.1 の値（Ixy [mm²/mm²]、Zxy [mm/mm²]、Cxy）。
    /// 並びは CATALOGUE と同じ（面材寸法・ピッチごとに 川・山・（ロ・）日）。
    const BOOK: &[(&str, f64, f64, f64)] = &[
        // 尺モジュール・@455・釘 @150（p.194〜195）
        ("910x3030-s455-n150-kawa", 2.58, 0.0057, 1.13),
        ("910x3030-s455-n150-yama", 2.74, 0.0060, 1.15),
        ("910x3030-s455-n150-hi", 2.89, 0.0067, 1.11),
        ("910x2730-s455-n150-kawa", 2.51, 0.0055, 1.15),
        ("910x2730-s455-n150-yama", 2.69, 0.0059, 1.17),
        ("910x2730-s455-n150-hi", 2.86, 0.0067, 1.12),
        ("910x1820-s455-n150-kawa", 1.91, 0.0043, 1.25),
        ("910x1820-s455-n150-yama", 2.21, 0.0049, 1.29),
        ("910x1820-s455-n150-hi", 2.51, 0.0062, 1.17),
        ("910x910-s455-n150-kawa", 1.35, 0.0042, 1.31),
        ("910x910-s455-n150-yama", 1.66, 0.0048, 1.39),
        ("910x910-s455-n150-ro", 1.94, 0.0062, 1.21),
        ("910x910-s455-n150-hi", 2.01, 0.0064, 1.25),
        ("910x610-s455-n150-kawa", 0.89, 0.0036, 1.27),
        ("910x610-s455-n150-yama", 1.18, 0.0042, 1.44),
        ("910x610-s455-n150-ro", 1.53, 0.0062, 1.19),
        ("910x610-s455-n150-hi", 1.56, 0.0063, 1.23),
        ("1820x910-s455-n150-kawa", 1.54, 0.0038, 1.37),
        ("1820x910-s455-n150-yama", 2.10, 0.0046, 1.50),
        ("1820x910-s455-n150-hi", 2.82, 0.0070, 1.27),
        ("1820x610-s455-n150-kawa", 0.89, 0.0031, 1.28),
        ("1820x610-s455-n150-yama", 1.30, 0.0038, 1.50),
        ("1820x610-s455-n150-hi", 1.91, 0.0067, 1.19),
        // 尺モジュール・@910・釘 @150（p.196）
        ("1820x910-s910-n150-kawa", 0.97, 0.0024, 1.34),
        ("1820x910-s910-n150-yama", 1.58, 0.0031, 1.62),
        ("1820x910-s910-n150-hi", 2.59, 0.0064, 1.21),
        ("1820x610-s910-n150-kawa", 0.55, 0.0019, 1.26),
        ("1820x610-s910-n150-yama", 0.96, 0.0025, 1.68),
        ("1820x610-s910-n150-hi", 1.82, 0.0064, 1.15),
        // 尺モジュール・@455・釘 @100（p.197〜198）
        ("910x3030-s455-n100-kawa", 3.72, 0.0081, 1.15),
        ("910x3030-s455-n100-yama", 4.00, 0.0087, 1.16),
        ("910x3030-s455-n100-hi", 4.26, 0.0098, 1.12),
        ("910x2730-s455-n100-kawa", 3.59, 0.0078, 1.16),
        ("910x2730-s455-n100-yama", 3.91, 0.0085, 1.18),
        ("910x2730-s455-n100-hi", 4.21, 0.0098, 1.13),
        ("910x1820-s455-n100-kawa", 2.74, 0.0061, 1.28),
        ("910x1820-s455-n100-yama", 3.25, 0.0072, 1.31),
        ("910x1820-s455-n100-hi", 3.76, 0.0093, 1.18),
        ("910x910-s455-n100-kawa", 1.83, 0.0057, 1.35),
        ("910x910-s455-n100-yama", 2.38, 0.0067, 1.45),
        ("910x910-s455-n100-ro", 2.90, 0.0092, 1.21),
        ("910x910-s455-n100-hi", 3.02, 0.0096, 1.26),
        ("910x610-s455-n100-kawa", 1.42, 0.0057, 1.28),
        ("910x610-s455-n100-yama", 1.92, 0.0067, 1.46),
        ("910x610-s455-n100-ro", 2.48, 0.0100, 1.18),
        ("910x610-s455-n100-hi", 2.61, 0.0105, 1.23),
        ("1820x910-s455-n100-kawa", 2.05, 0.0051, 1.41),
        ("1820x910-s455-n100-yama", 2.99, 0.0064, 1.57),
        ("1820x910-s455-n100-hi", 4.31, 0.0107, 1.27),
        ("1820x610-s455-n100-kawa", 1.13, 0.0040, 1.34),
        ("1820x610-s455-n100-yama", 1.79, 0.0051, 1.61),
        ("1820x610-s455-n100-hi", 2.91, 0.0102, 1.20),
        // 尺モジュール・@910・釘 @100（p.199）
        ("1820x910-s910-n100-kawa", 1.28, 0.0032, 1.38),
        ("1820x910-s910-n100-yama", 2.23, 0.0043, 1.70),
        ("1820x910-s910-n100-hi", 3.90, 0.0096, 1.21),
        ("1820x610-s910-n100-kawa", 0.69, 0.0025, 1.32),
        ("1820x610-s910-n100-yama", 1.31, 0.0034, 1.79),
        ("1820x610-s910-n100-hi", 2.74, 0.0096, 1.16),
        // 尺モジュール・@455・釘 @75（p.200〜201）
        ("910x3030-s455-n75-kawa", 4.86, 0.0105, 1.15),
        ("910x3030-s455-n75-yama", 5.26, 0.0114, 1.17),
        ("910x3030-s455-n75-hi", 5.63, 0.0130, 1.12),
        ("910x2730-s455-n75-kawa", 4.68, 0.0101, 1.18),
        ("910x2730-s455-n75-yama", 5.14, 0.0112, 1.19),
        ("910x2730-s455-n75-hi", 5.56, 0.0130, 1.13),
        ("910x1820-s455-n75-kawa", 3.56, 0.0079, 1.29),
        ("910x1820-s455-n75-yama", 4.29, 0.0094, 1.32),
        ("910x1820-s455-n75-hi", 4.99, 0.0124, 1.18),
        ("910x910-s455-n75-kawa", 2.31, 0.0071, 1.38),
        ("910x910-s455-n75-yama", 3.10, 0.0087, 1.47),
        ("910x910-s455-n75-ro", 3.84, 0.0122, 1.22),
        ("910x910-s455-n75-hi", 4.02, 0.0127, 1.27),
        ("910x610-s455-n75-kawa", 1.40, 0.0055, 1.38),
        ("910x610-s455-n75-yama", 2.13, 0.0072, 1.55),
        ("910x610-s455-n75-ro", 3.01, 0.0121, 1.20),
        ("910x610-s455-n75-hi", 3.13, 0.0126, 1.25),
        ("1820x910-s455-n75-kawa", 2.57, 0.0064, 1.44),
        ("1820x910-s455-n75-yama", 3.92, 0.0083, 1.60),
        ("1820x910-s455-n75-hi", 5.81, 0.0143, 1.28),
        ("1820x610-s455-n75-kawa", 1.37, 0.0048, 1.39),
        ("1820x610-s455-n75-yama", 2.32, 0.0065, 1.64),
        ("1820x610-s455-n75-hi", 3.93, 0.0137, 1.21),
        // 尺モジュール・@910・釘 @75（p.202）
        ("1820x910-s910-n75-kawa", 1.61, 0.0039, 1.42),
        ("1820x910-s910-n75-yama", 2.91, 0.0056, 1.72),
        ("1820x910-s910-n75-hi", 5.21, 0.0128, 1.22),
        ("1820x610-s910-n75-kawa", 0.84, 0.0029, 1.37),
        ("1820x610-s910-n75-yama", 1.70, 0.0043, 1.82),
        ("1820x610-s910-n75-hi", 3.66, 0.0128, 1.16),
        // メーターモジュール・@500・釘 @150（p.203）
        ("1000x2000-s500-n150-kawa", 2.26, 0.0047, 1.22),
        ("1000x2000-s500-n150-yama", 2.63, 0.0053, 1.28),
        ("1000x2000-s500-n150-hi", 3.00, 0.0067, 1.18),
        ("1000x1000-s500-n150-kawa", 1.56, 0.0043, 1.35),
        ("1000x1000-s500-n150-yama", 1.98, 0.0053, 1.36),
        ("1000x1000-s500-n150-ro", 2.32, 0.0065, 1.23),
        ("1000x1000-s500-n150-hi", 2.41, 0.0068, 1.28),
        ("2000x1000-s500-n150-kawa", 1.79, 0.0039, 1.42),
        ("2000x1000-s500-n150-yama", 2.54, 0.0052, 1.45),
        ("2000x1000-s500-n150-hi", 3.42, 0.0075, 1.28),
        ("2000x600-s500-n150-kawa", 0.82, 0.0029, 1.26),
        ("2000x600-s500-n150-yama", 1.26, 0.0036, 1.56),
        ("2000x600-s500-n150-hi", 2.01, 0.0071, 1.16),
        // メーターモジュール・@1000・釘 @150（p.204）
        ("2000x1000-s1000-n150-kawa", 1.13, 0.0024, 1.39),
        ("2000x1000-s1000-n150-yama", 1.92, 0.0035, 1.57),
        ("2000x1000-s1000-n150-hi", 3.11, 0.0069, 1.22),
        ("2000x600-s1000-n150-kawa", 0.50, 0.0018, 1.24),
        ("2000x600-s1000-n150-yama", 0.92, 0.0023, 1.75),
        ("2000x600-s1000-n150-hi", 1.93, 0.0068, 1.13),
    ];

    /// 表 3.2.1 のうち、本の図がここでの割り付け規則と違う配列。
    ///
    /// 910 × 610 に釘 @100 の欄だけ、本の図は 610 mm の辺に釘を 8 本
    /// （両端 45 mm・中 100 mm）並べている。同じ辺・同じ @100 でも他の欄
    /// （910 × 910 の 910 mm 辺など）は規則どおり「区間数 = 切り上げ」で
    /// 描かれているので、この欄だけ釘が 1 本多い。本ツールは規則を優先する
    /// （釘が少ない側＝安全側の値になる）。
    const BOOK_DRAWS_ONE_EXTRA_NAIL: &[&str] = &[
        "910x610-s455-n100-kawa",
        "910x610-s455-n100-yama",
        "910x610-s455-n100-ro",
        "910x610-s455-n100-hi",
    ];

    /// 表 3.2.1 に載っている桁（Ixy は小数 2 桁、Zxy は 4 桁、Cxy は 2 桁）の
    /// 丸め幅。本の値はこの幅だけ真の値からずれうる。
    fn rounding(decimals: i32) -> f64 {
        0.5 * 10f64.powi(-decimals)
    }

    fn computed(id: &str) -> nail_array::Constants {
        let preset = preset(id);
        nail_array::compute(&preset.nails(), preset.width * preset.height)
            .unwrap_or_else(|error| panic!("{id} を計算できません: {}", error.0))
    }

    /// 表 3.2.1 の全 106 通りと突き合わせる。
    ///
    /// 一致の判定は「本の表示桁の丸め幅 + 相対 6%」。相対の幅を見ているのは、
    /// 本の値そのものに次のような揺れがあるため:
    ///   - Zxy は小数 4 桁表示なので、0.0018 のような小さい値では丸めだけで
    ///     ±2.8% になる。
    ///   - メーターモジュールの高さ 1000 mm の欄は、Ixy が一致していても
    ///     Zxy・Cxy が 4〜5% ずれる（本の Ixy と Zxy を同時に満たす釘配置は
    ///     存在しないので、本の側の丸めか誤植と考えられる）。
    #[test]
    fn every_preset_matches_the_book() {
        const RELATIVE: f64 = 0.06;
        let mut checked = 0;
        for (id, ixy, zxy, cxy) in BOOK {
            if BOOK_DRAWS_ONE_EXTRA_NAIL.contains(id) {
                continue;
            }
            let result = computed(id);
            for (name, got, expected, decimals) in [
                ("Ixy", result.ixy, *ixy, 2),
                ("Zxy", result.zxy, *zxy, 4),
                ("Cxy", result.cxy, *cxy, 2),
            ] {
                let allowed = rounding(decimals) + RELATIVE * expected;
                assert!(
                    (got - expected).abs() <= allowed,
                    "{id} の {name}: {got} はグレー本の {expected} と違いすぎます（許容 ±{allowed}）"
                );
                checked += 1;
            }
        }
        assert_eq!(checked, (BOOK.len() - BOOK_DRAWS_ONE_EXTRA_NAIL.len()) * 3);
    }

    /// 丸め幅 + 2% を超えてずれるのは、メーターモジュールで高さ 1000 mm の
    /// 面材だけ（本の Ixy とは一致していて、Zxy・Cxy だけが 4〜5% ずれる）。
    /// ほかの欄はすべて 2% に収まる。
    #[test]
    fn only_the_1000mm_high_meter_module_rows_differ_by_more_than_two_percent() {
        let mut loose = Vec::new();
        for (id, ixy, zxy, cxy) in BOOK {
            if BOOK_DRAWS_ONE_EXTRA_NAIL.contains(id) {
                continue;
            }
            let result = computed(id);
            for (got, expected, decimals) in [
                (result.ixy, *ixy, 2),
                (result.zxy, *zxy, 4),
                (result.cxy, *cxy, 2),
            ] {
                if (got - expected).abs() > rounding(decimals) + 0.02 * expected {
                    loose.push(*id);
                }
            }
        }
        loose.sort();
        loose.dedup();
        assert!(!loose.is_empty());
        for id in &loose {
            let preset = preset(id);
            assert_eq!(preset.height, 1000.0, "{id}");
            assert_eq!(preset.stud_pitch % 500.0, 0.0, "{id}");
        }
    }

    /// 本の図が 1 本多い欄でも、その 1 本を足せば本の値と一致する
    /// （＝違いは割り付け規則だけで、計算そのものは同じ）。
    #[test]
    fn the_extra_nail_of_the_910x610_at_100_row_explains_the_difference() {
        // 610 mm の辺に釘 8 本（両端 45 mm・中 100 mm）を並べた本の図。
        let ys = [10.0, 55.0, 155.0, 255.0, 355.0, 455.0, 555.0, 600.0];
        let xs = [10.0, 455.0, 900.0];
        let nails = nail_array::build_rectangular_grid(&xs, &ys);
        let result = nail_array::compute(&nails, 910.0 * 610.0).unwrap();

        assert!((result.ixy - 1.42).abs() <= 0.005, "{}", result.ixy);
        assert!((result.zxy - 0.0057).abs() <= 0.00005, "{}", result.zxy);
        assert!((result.cxy - 1.28).abs() <= 0.005, "{}", result.cxy);

        // 規則どおりに並べた本ツールの値は、釘が 1 本少ないぶん小さい。
        let ours = computed("910x610-s455-n100-kawa");
        assert!(ours.ixy < result.ixy);
        assert_eq!(preset("910x610-s455-n100-kawa").nails().len(), 21);
    }
}
