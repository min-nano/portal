//! 壁の軸組材（柱・間柱・横架材・継目の材）と、釘列の縁端距離。
//!
//! グレー本『木造軸組工法住宅の許容応力度設計』の適用範囲 3.3(1)④ は、釘の
//! まわりに 2 つの寸法を求めている。
//!
//! ```text
//!   面材の釘列に対するへりあき     … 10mm 以上かつ接合具径 d × 5 以上
//!   軸材の釘列に対する縁端距離     … 20mm 以上かつ接合具径 d × 5 以上
//! ```
//!
//! 前者（面材の縁から釘の中心まで）は面材の寸法と釘座標だけで測れるので、
//! layout::min_edge_clearance が実際に置かれた釘から測っている。後者は
//! **釘が刺さっている軸組材の見付け幅**が要るので、壁の入力に軸組材の寸法を
//! 持つことで初めて判定できる。この module はその判定のための幾何を持つ。
//!
//! # 釘列と軸組材の対応
//!
//! 釘を打つ線は、面材の四周（適用範囲 3.3(1)⑤ の四周打ち）と、その面材に
//! かかる間柱。どの線も**軸組材の心の上**にあり、面材の縁の線だけがへりあき
//! ぶん内側へずれる（面材どうしは軸組材の心で突き付けて張るため）。
//!
//! ```text
//!        材心（面材の継目）        釘
//!            │←─ へりあき e ─→●
//!            │←───── 見付け幅 b ÷ 2 ─────→│ 材の縁
//!
//!   縁端距離 = b ÷ 2 − e   … 面材の縁の釘列（左右の縁・上下の縁）
//!   縁端距離 = b ÷ 2       … 中間の間柱の釘列（材心の上に打つ）
//! ```
//!
//! 線がどの材に来るかは、壁の中でのその線の位置で決まる。
//!
//! | 釘列               | 位置                     | 軸組材     |
//! | ------------------ | ------------------------ | ---------- |
//! | 面材の左右の縁     | 壁の左端・右端           | 柱         |
//! | 面材の左右の縁     | 壁の内側（面材の継目）   | 継目の材   |
//! | 中間の縦列         | 面材にかかる間柱         | 間柱       |
//! | 面材の上下の縁     | 壁の下端・上端           | 横架材     |
//! | 面材の上下の縁     | 壁の内側（面材の継目）   | 継目の材   |
//!
//! 面材の継目に来る材（縦の継目の間柱・横の継目の受け材）を 1 つの入力に
//! まとめてあるのは、適用範囲 3.3(1)⑥ が「端部及び継目の材」としてまとめて
//! 断面を定めているのと同じ括り方による（継目は 2 枚ぶんの縁の釘列を 1 本の
//! 材で受けるので、通常の間柱より広い見付けが要る）。

use crate::wall::{EDGE_DISTANCE_DIAMETER_FACTOR, MIN_FRAME_EDGE_DISTANCE};

/// 位置が「壁の端に一致する」とみなす幅 [mm]。入力は mm 単位の実寸なので、
/// 二進小数の端数を吸収できれば足りる。
const AT_THE_END: f64 = 1e-6;

/// 軸組材の既定の見付け幅 [mm]。
///
/// 尺モジュールの在来軸組でよくある取り合わせ（柱 105 角・間柱 45×105・
/// 土台や桁は 105 角以上・継目には 45×105 を平使いして見付け 105）。
pub const DEFAULT_COLUMN_WIDTH: f64 = 105.0;
pub const DEFAULT_STUD_WIDTH: f64 = 45.0;
pub const DEFAULT_BEAM_WIDTH: f64 = 105.0;
pub const DEFAULT_JOINT_WIDTH: f64 = 105.0;

/// 釘が刺さる軸組材の種類。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Member {
    /// 柱（壁の両端の縦材）。
    Column,
    /// 間柱（面材の中間にかかる縦材）。
    Stud,
    /// 横架材（壁の上下の横材。土台・胴差・桁）。
    Beam,
    /// 面材の継目を受ける材（縦の継目の間柱・横の継目の受け材）。
    Joint,
}

impl Member {
    pub fn label(self) -> &'static str {
        match self {
            Member::Column => "柱",
            Member::Stud => "間柱",
            Member::Beam => "横架材",
            Member::Joint => "継目の材",
        }
    }
}

/// 壁の軸組材の見付け幅 [mm]（面材を張る面から見た材の幅）。
///
/// 奥行き（材せい）は釘の縁端距離に効かないので持たない。釘は面材の面に
/// 直交して打たれるため、効くのは面内の幅だけ。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub column: f64,
    pub stud: f64,
    pub beam: f64,
    pub joint: f64,
}

impl Default for Frame {
    fn default() -> Frame {
        Frame {
            column: DEFAULT_COLUMN_WIDTH,
            stud: DEFAULT_STUD_WIDTH,
            beam: DEFAULT_BEAM_WIDTH,
            joint: DEFAULT_JOINT_WIDTH,
        }
    }
}

impl Frame {
    /// その材の見付け幅 [mm]。
    pub fn width_of(&self, member: Member) -> f64 {
        match member {
            Member::Column => self.column,
            Member::Stud => self.stud,
            Member::Beam => self.beam,
            Member::Joint => self.joint,
        }
    }
}

/// 面材 1 枚が壁の中でどこを占め、釘列がどこに来るか。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placement {
    /// 壁の幅 W [mm]（縦材が柱か継目の材かは、この端に一致するかで決まる）。
    pub wall_width: f64,
    /// 階高 H [mm]（横材が横架材か継目の材かは、この端に一致するかで決まる）。
    pub wall_height: f64,
    /// 壁の中でこの面材が占める領域 [mm]（壁の左下が原点）。
    pub left: f64,
    pub bottom: f64,
    pub right: f64,
    pub top: f64,
    /// へりあき（面材の縁から釘の中心まで）[mm]。
    pub edge_distance: f64,
    /// この面材に釘を打った中間の縦列の本数（面材の左右の縁を除く）。
    ///
    /// 間柱の位置は釘の割り付け（layout）が決めるので、本数だけを受け取る。
    /// 3.3(1)⑧ で釘配列計算から外した縦列はここに入らない（計算に入れた釘
    /// だけを判定するので、へりあきと同じ物差しになる）。
    pub intermediate_studs: usize,
}

/// 釘列 1 本と、その釘が刺さる軸組材の縁端距離。
#[derive(Debug, Clone, PartialEq)]
pub struct Clearance {
    /// どの釘列か（「左の縁」「中間の間柱」など）。
    pub line: &'static str,
    pub member: Member,
    /// その材の見付け幅 [mm]。
    pub width: f64,
    /// 材心から釘の中心までのずれ [mm]（面材の縁ならへりあき、中間なら 0）。
    pub offset: f64,
    /// 縁端距離 [mm]（釘の中心から材の縁まで）。材から外れていれば負。
    pub distance: f64,
}

impl Clearance {
    fn new(line: &'static str, member: Member, frame: &Frame, offset: f64) -> Clearance {
        let width = frame.width_of(member);
        Clearance {
            line,
            member,
            width,
            offset,
            distance: width / 2.0 - offset,
        }
    }

    /// 判定の根拠として読める 1 行（「上の縁 ／ 継目の材 見付け 105 mm」）。
    pub fn label(&self) -> String {
        format!(
            "{} ／ {} 見付け {} mm",
            self.line,
            self.member.label(),
            crate::format::format_dimension(self.width)
        )
    }
}

/// この釘で必要な、軸材の釘列に対する縁端距離 [mm]（適用範囲 3.3(1)④）。
///
/// 20mm 以上かつ接合具径 d × 5 以上。釘を表 3.3.1 から選んでいない（4.5 の
/// 試験値を直接入力した）面材は呼び径が分からないので、20mm の側だけを見る。
pub fn required_clearance(nail_diameter: Option<f64>) -> f64 {
    match nail_diameter {
        Some(diameter) => {
            let from_diameter = EDGE_DISTANCE_DIAMETER_FACTOR * diameter;
            // 5 × 3.76 が 18.799999999999997 になるような二進小数の端数を落とす
            //（この値は画面と計算書にそのまま出す）。
            let from_diameter = (from_diameter * 1e6).round() / 1e6;
            from_diameter.max(MIN_FRAME_EDGE_DISTANCE)
        }
        None => MIN_FRAME_EDGE_DISTANCE,
    }
}

/// 面材 1 枚の釘列を、刺さる軸組材ごとの縁端距離にする。
///
/// 並びは釘配列図と同じく左から右・下から上（左の縁 → 中間の間柱 → 右の縁
/// → 下の縁 → 上の縁）。
pub fn clearances(placement: &Placement, frame: &Frame) -> Vec<Clearance> {
    let vertical = |position: f64| {
        if at(position, 0.0) || at(position, placement.wall_width) {
            Member::Column
        } else {
            Member::Joint
        }
    };
    let horizontal = |position: f64| {
        if at(position, 0.0) || at(position, placement.wall_height) {
            Member::Beam
        } else {
            Member::Joint
        }
    };

    let edge = placement.edge_distance;
    let mut lines = vec![Clearance::new(
        "左の縁",
        vertical(placement.left),
        frame,
        edge,
    )];
    if placement.intermediate_studs > 0 {
        // 中間の間柱は、何本あっても釘は材心の上（同じ縁端距離）に来る。
        lines.push(Clearance::new("中間の間柱", Member::Stud, frame, 0.0));
    }
    lines.push(Clearance::new(
        "右の縁",
        vertical(placement.right),
        frame,
        edge,
    ));
    lines.push(Clearance::new(
        "下の縁",
        horizontal(placement.bottom),
        frame,
        edge,
    ));
    lines.push(Clearance::new(
        "上の縁",
        horizontal(placement.top),
        frame,
        edge,
    ));
    lines
}

/// 縁端距離がいちばん小さい釘列（面材には必ず 1 本以上の釘列がある）。
pub fn worst(clearances: &[Clearance]) -> Clearance {
    clearances
        .iter()
        .fold(clearances[0].clone(), |worst, line| {
            if line.distance < worst.distance {
                line.clone()
            } else {
                worst
            }
        })
}

fn at(position: f64, edge: f64) -> bool {
    (position - edge).abs() <= AT_THE_END
}

#[cfg(test)]
mod tests {
    use super::*;

    /// グレー本 3.3(3) の計算例の壁（W 910 × H 3000、面材は 910 × 1820 と
    /// 910 × 910 の 2 段）。下側の面材の置かれ方。
    fn lower_panel() -> Placement {
        Placement {
            wall_width: 910.0,
            wall_height: 3000.0,
            left: 0.0,
            bottom: 0.0,
            right: 910.0,
            top: 1820.0,
            edge_distance: 10.0,
            intermediate_studs: 0,
        }
    }

    #[test]
    fn the_edges_of_the_wall_are_columns_and_beams() {
        let lines = clearances(&lower_panel(), &Frame::default());
        let members: Vec<Member> = lines.iter().map(|line| line.member).collect();
        // 左右の縁は壁の端なので柱、下の縁は壁の下端なので横架材。上の縁は
        // 壁の中（面材の継目）なので継目の材。
        assert_eq!(
            members,
            vec![Member::Column, Member::Column, Member::Beam, Member::Joint]
        );
        assert_eq!(lines[0].line, "左の縁");
        assert_eq!(lines[3].line, "上の縁");
    }

    #[test]
    fn the_clearance_is_half_the_member_less_the_edge_distance() {
        let lines = clearances(&lower_panel(), &Frame::default());
        // 柱 105 の心から 10 mm 内側 → 52.5 − 10。
        assert_eq!(lines[0].distance, 42.5);
        assert_eq!(lines[0].width, 105.0);
        assert_eq!(lines[0].offset, 10.0);
    }

    #[test]
    fn a_nail_on_an_intermediate_stud_sits_on_its_centre() {
        let placement = Placement {
            intermediate_studs: 1,
            ..lower_panel()
        };
        let lines = clearances(&placement, &Frame::default());
        let stud = lines
            .iter()
            .find(|line| line.member == Member::Stud)
            .unwrap();
        assert_eq!(stud.line, "中間の間柱");
        assert_eq!(stud.offset, 0.0);
        // 間柱 45 の心に打つので、縁端距離は 22.5 mm（へりあきに依らない）。
        assert_eq!(stud.distance, 22.5);
    }

    /// 中間の間柱が何本あっても、縁端距離は 1 本ぶんしか出さない。
    #[test]
    fn the_intermediate_studs_are_reported_once() {
        let placement = Placement {
            intermediate_studs: 3,
            ..lower_panel()
        };
        let lines = clearances(&placement, &Frame::default());
        assert_eq!(
            lines
                .iter()
                .filter(|line| line.member == Member::Stud)
                .count(),
            1
        );
    }

    /// 壁の内側で面材どうしが突き付く縁は、継目の材で受ける。
    #[test]
    fn a_joint_inside_the_wall_is_carried_by_the_joint_member() {
        let placement = Placement {
            wall_width: 1820.0,
            left: 910.0,
            right: 1820.0,
            ..lower_panel()
        };
        let lines = clearances(&placement, &Frame::default());
        assert_eq!(lines[0].member, Member::Joint); // 壁の中の縦の継目
        assert_eq!(lines[1].member, Member::Column); // 壁の右端
    }

    /// 見付けの狭い材では、へりあきを広げるほど縁端距離が足りなくなる。
    #[test]
    fn a_narrow_member_loses_its_clearance_as_the_edge_distance_grows() {
        let placement = Placement {
            edge_distance: 15.25,
            ..lower_panel()
        };
        let narrow = Frame {
            joint: 45.0,
            ..Frame::default()
        };
        let lines = clearances(&placement, &narrow);
        let joint = worst(&lines);
        assert_eq!(joint.member, Member::Joint);
        assert_eq!(joint.distance, 22.5 - 15.25);
        assert!(joint.distance < required_clearance(Some(3.05)));
    }

    /// 材から外れた釘（見付けの半分よりへりあきが大きい）は負で出す。
    #[test]
    fn a_nail_that_misses_the_member_is_negative() {
        let placement = Placement {
            edge_distance: 30.0,
            ..lower_panel()
        };
        let lines = clearances(
            &placement,
            &Frame {
                joint: 45.0,
                ..Frame::default()
            },
        );
        assert_eq!(worst(&lines).distance, 22.5 - 30.0);
    }

    #[test]
    fn the_required_clearance_is_twenty_millimetres_or_five_diameters() {
        // N-50（φ2.75）・N-65（φ3.05）は 5d が 20 mm に届かないので 20 mm。
        assert_eq!(required_clearance(Some(2.75)), 20.0);
        assert_eq!(required_clearance(Some(3.05)), 20.0);
        // CN 釘 75（φ3.76）は 5d = 18.8 でまだ 20 mm が効く。
        assert_eq!(required_clearance(Some(3.76)), 20.0);
        // 太い接合具では 5d の側が効く。
        assert_eq!(required_clearance(Some(6.0)), 30.0);
        // 釘を選んでいない面材は 20 mm だけで確かめる。
        assert_eq!(required_clearance(None), 20.0);
    }

    #[test]
    fn the_worst_line_is_the_one_with_the_least_clearance() {
        let lines = clearances(
            &lower_panel(),
            &Frame {
                joint: 60.0,
                ..Frame::default()
            },
        );
        let worst = worst(&lines);
        assert_eq!(worst.member, Member::Joint);
        assert_eq!(worst.distance, 20.0);
        assert_eq!(worst.label(), "上の縁 ／ 継目の材 見付け 60 mm");
    }
}
