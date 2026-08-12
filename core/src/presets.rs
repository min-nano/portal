//! グレー本 表 3.2.1「標準的なサイズの面材の釘配列諸定数」の釘配列。
//!
//! 表 3.2.1 は、実務でよく使う面材寸法・間柱（根太）ピッチ・釘ピッチの
//! 組み合わせについて、釘配列諸定数 Ixy・Zxy・Cxy をまとめたもの。ここには
//! **その表に載っている配列そのもの**を組み立てる規則を置き、画面から
//! 「呼び出せる配列」として一覧できるようにする。
//!
//! 呼び出した配列は、壁を構成する面材 1 枚の**割り付けの入力欄**（面材寸法・
//! 型・間柱ピッチ・釘ピッチ・へりあき）へそのまま入る。表の配列を出発点に
//! して、面材の配置や釘の間隔を実際の設計に合わせて動かせるようにするため。
//! 釘座標の作り方そのものは layout.rs にある。

use crate::json::Value;
use crate::layout::{Arrangement, Layout, ARRANGEMENTS, DEFAULT_EDGE_DISTANCE};
use crate::nail_array::Nail;

/// 表 3.2.1 の配列が前提とするへりあき [mm]。
///
/// グレー本 3.2【解説】の計算例が 910 × 610 の面材に対して 890 × 590 の
/// 広がりで釘を打っている（両側 10 mm ずつ内側）ことによる。
pub const EDGE_DISTANCE: f64 = DEFAULT_EDGE_DISTANCE;

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
            for arrangement in ARRANGEMENTS {
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

    /// この配列の割り付け（へりあきは表が前提とする 10 mm）。
    pub fn layout(&self) -> Layout {
        Layout {
            width: self.width,
            height: self.height,
            stud_pitch: self.stud_pitch,
            nail_pitch: self.nail_pitch,
            edge_distance: EDGE_DISTANCE,
            arrangement: self.arrangement,
        }
    }

    /// 釘 1 本ごとの座標（X, Y の昇順）。
    pub fn nails(&self) -> Vec<Nail> {
        self.layout().nails()
    }

    /// 縦置き（面材の長辺が縦）か。正方形は表 3.2.1 に合わせて縦置と呼ぶ。
    pub fn is_portrait(&self) -> bool {
        self.height >= self.width
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

    /// この配列を、壁を構成する面材 1 枚ぶんの入力として書き出す。
    ///
    /// 割り付けの欄（寸法・型・ピッチ・へりあき）へそのまま入るので、
    /// 読み込んだあとに面材の配置や釘の間隔を動かせる。
    pub fn to_panel_value(&self) -> Value {
        Value::obj([
            ("panelName", self.label().into()),
            ("width", self.width.into()),
            ("height", self.height.into()),
            ("mode", "layout".into()),
            ("arrangement", self.arrangement.id().into()),
            ("studPitch", self.stud_pitch.into()),
            ("nailPitch", self.nail_pitch.into()),
            ("edgeDistance", EDGE_DISTANCE.into()),
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
            ("edgeDistance", EDGE_DISTANCE.into()),
            ("nailCount", self.nails().len().into()),
        ])
    }
}

/// 寸法を入力欄の文字列にする（3 桁区切りは付けない）。
fn number(value: f64) -> String {
    format!("{value}")
}

#[cfg(test)]
mod tests {
    //! テストの構成:
    //!   1. 一覧としての体裁（件数・id の一意性・書き出す入力の形）。
    //!   2. グレー本 表 3.2.1 の Ixy・Zxy・Cxy との突き合わせ（本節の主眼）。
    //!
    //! 釘の割り付け規則そのもののテストは layout.rs にある。

    use super::*;
    use crate::nail_array;
    use crate::report;

    fn preset(id: &str) -> Preset {
        find(id).unwrap_or_else(|| panic!("{id} が一覧にありません"))
    }

    // --- 1. 一覧としての体裁 -------------------------------------------------

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

    /// 呼び出した配列は、割り付けの入力欄をそのまま埋める。
    #[test]
    fn a_preset_fills_the_layout_fields_of_a_panel() {
        let panel = preset("910x610-s455-n150-kawa").to_panel_value();
        assert_eq!(panel.get("mode").unwrap().as_str(), Some("layout"));
        assert_eq!(panel.get("width").unwrap().as_f64(), Some(910.0));
        assert_eq!(panel.get("height").unwrap().as_f64(), Some(610.0));
        assert_eq!(panel.get("arrangement").unwrap().as_str(), Some("kawa"));
        assert_eq!(panel.get("studPitch").unwrap().as_f64(), Some(455.0));
        assert_eq!(panel.get("nailPitch").unwrap().as_f64(), Some(150.0));
        assert_eq!(panel.get("edgeDistance").unwrap().as_f64(), Some(10.0));
    }

    /// 書き出した入力は、面材 1 枚としてそのまま計算できる。
    #[test]
    fn every_preset_can_be_calculated_as_a_wall_panel() {
        for preset in all() {
            let panel = report::normalize_panel(&preset.to_panel_value(), "w1", 0).unwrap();
            let nails = report::nails_of(&panel).unwrap_or_else(|error| {
                panic!("{} を計算できません: {error}", preset.id());
            });
            assert_eq!(nails.len(), preset.nails().len(), "{}", preset.id());
            assert!(nail_array::compute(&nails, panel.panel_area()).is_ok());
        }
    }

    // --- 2. グレー本 表 3.2.1 との突き合わせ ---------------------------------

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
