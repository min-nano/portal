//! 壁の軸組材（柱・間柱・横架材・受け材）と、釘列の縁端距離。
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
//! **釘が刺さっている軸組材がどこにあり、どれだけの見付け幅を持つか**が要る
//! ので、壁の入力として軸組材そのものを受け取る。
//!
//! # 軸組材は 1 本ずつ、自由な位置に入れる
//!
//! 実際の軸組は等間隔とは限らない（開口まわり、面材の継目に入れる受け材、
//! 壁の途中で寄せた間柱）。そこで壁は **軸組材の一覧**を持つ。1 本の軸組材は
//!
//!   - 向き（縦材＝柱・間柱など／横材＝横架材・受け材など）
//!   - 名前（「柱」「間柱」「まぐさ」など、計算書にそのまま出る）
//!   - 材心の位置 [mm]（壁の左下が原点。縦材は X、横材は Y）
//!   - 見付け幅 [mm]（面材の側から見た材の幅）
//!
//! で表す。尺モジュールのように等間隔で並べたいときは、間柱ピッチから
//! 一覧を組み立てられる（`Frame::from_stud_pitch`）。
//!
//! # 釘列と軸組材の対応
//!
//! 釘を打つ線は、面材の四周（適用範囲 3.3(1)⑤ の四周打ち）と、その面材の
//! 内側を通る縦材。縦材の釘列は**材心の上**に来て、面材の縁の釘列は面材の
//! 縁からへりあきぶん内側に来る。縁端距離は、その釘列を受ける軸組材の縁
//! までの距離として測る。
//!
//! ```text
//!        材心          釘          材の縁
//!          │←── ずれ ──→●←─ 縁端距離 ─→│
//!          │←────── 見付け幅 ÷ 2 ──────→│
//! ```
//!
//! 釘列の位置に軸組材が無ければ、そこには釘を打てない（面材の継目に受け材が
//! 入っていない、など）。その釘列は「軸組材なし」として判定に出す。

use crate::format::{format_dimension, format_int};
use crate::json::Value;
use crate::wall::{EDGE_DISTANCE_DIAMETER_FACTOR, MIN_FRAME_EDGE_DISTANCE};

/// 壁 1 枚に入れられる軸組材の本数の上限。実務では多くても数十本なので、
/// 桁を間違えた入力で計算と描画が膨れ上がらないようにするための歯止め。
pub const MAX_MEMBERS: usize = 200;

/// 軸組材の既定の見付け幅 [mm]。
///
/// 尺モジュールの在来軸組でよくある取り合わせ（柱 105 角・間柱 45×105・
/// 土台や桁は 105 角以上・面材の継目には 45×105 を平使いして見付け 105）。
pub const DEFAULT_COLUMN_WIDTH: f64 = 105.0;
pub const DEFAULT_STUD_WIDTH: f64 = 45.0;
pub const DEFAULT_BEAM_WIDTH: f64 = 105.0;
pub const DEFAULT_JOINT_WIDTH: f64 = 105.0;

/// 等間隔で軸組材を組み立てるときの、既定の間柱ピッチ [mm]（尺モジュール）。
pub const DEFAULT_STUD_PITCH: f64 = 455.0;

/// 既定の名前。画面の一覧にもそのまま並べる。
pub const COLUMN_LABEL: &str = "柱";
pub const STUD_LABEL: &str = "間柱";
pub const BEAM_LABEL: &str = "横架材";
pub const JOINT_LABEL: &str = "継目の材";

/// 軸組材の向き。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// 縦材（柱・間柱など）。位置は壁の左端からの X [mm]。
    Vertical,
    /// 横材（横架材・受け材など）。位置は壁の下端からの Y [mm]。
    Horizontal,
}

/// 画面の選択肢に並べる順。
pub const DIRECTIONS: [Direction; 2] = [Direction::Vertical, Direction::Horizontal];

impl Direction {
    pub fn id(self) -> &'static str {
        match self {
            Direction::Vertical => "vertical",
            Direction::Horizontal => "horizontal",
        }
    }

    /// id から向きを引く（知らない id は縦材とみなす）。
    pub fn from_id(id: &str) -> Direction {
        match id {
            "horizontal" => Direction::Horizontal,
            _ => Direction::Vertical,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Direction::Vertical => "縦材",
            Direction::Horizontal => "横材",
        }
    }

    /// 位置を表す軸の名前（計算書に「X = 455 mm」と出すため）。
    pub fn axis(self) -> &'static str {
        match self {
            Direction::Vertical => "X",
            Direction::Horizontal => "Y",
        }
    }
}

/// 軸組材 1 本。
#[derive(Debug, Clone, PartialEq)]
pub struct Member {
    pub direction: Direction,
    /// 名前（「柱」「間柱」「横架材」「継目の材」など）。計算書にそのまま出る。
    pub label: String,
    /// 材心の位置 [mm]（壁の左下が原点）。
    pub position: f64,
    /// 見付け幅 [mm]（面材の側から見た材の幅）。
    pub width: f64,
}

impl Member {
    pub fn new(direction: Direction, label: &str, position: f64, width: f64) -> Member {
        Member {
            direction,
            label: label.to_string(),
            position,
            width,
        }
    }

    /// 材が占める範囲（材心 ± 見付け幅の半分）。
    pub fn span(&self) -> (f64, f64) {
        let half = self.width / 2.0;
        (self.position - half, self.position + half)
    }

    /// その位置に釘を打てるか（材の上に来ているか）。
    pub fn covers(&self, at: f64) -> bool {
        let (low, high) = self.span();
        at >= low && at <= high
    }

    /// その位置に打った釘の縁端距離 [mm]（材の縁までの短いほう）。
    pub fn clearance_at(&self, at: f64) -> f64 {
        let (low, high) = self.span();
        (at - low).min(high - at)
    }

    /// 計算書に出す 1 行（「柱（見付け 105 mm）」）。
    pub fn label_with_width(&self) -> String {
        format!(
            "{}（見付け {} mm）",
            self.label,
            format_dimension(self.width)
        )
    }

    pub fn to_value(&self) -> Value {
        Value::obj([
            ("direction", self.direction.id().into()),
            ("label", self.label.clone().into()),
            ("position", self.position.into()),
            ("width", self.width.into()),
        ])
    }
}

/// 壁の軸組材の一覧。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Frame {
    pub members: Vec<Member>,
}

impl Frame {
    pub fn new(members: Vec<Member>) -> Frame {
        Frame { members }
    }

    pub fn is_empty(&self) -> bool {
        self.members.is_empty()
    }

    /// その向きの軸組材を、位置の順に返す。
    pub fn of(&self, direction: Direction) -> Vec<&Member> {
        let mut members: Vec<&Member> = self
            .members
            .iter()
            .filter(|member| member.direction == direction)
            .collect();
        members.sort_by(|left, right| {
            left.position
                .partial_cmp(&right.position)
                .expect("軸組材の位置は有限")
        });
        members
    }

    /// その位置の釘列を受ける軸組材（無ければ None）。
    ///
    /// 材が重なって入っている（抱き合わせの間柱など）ときは、縁端距離が
    /// いちばん大きく取れるものを採る。
    pub fn carrying(&self, direction: Direction, at: f64) -> Option<&Member> {
        self.members
            .iter()
            .filter(|member| member.direction == direction && member.covers(at))
            .max_by(|left, right| {
                left.clearance_at(at)
                    .partial_cmp(&right.clearance_at(at))
                    .expect("縁端距離は有限")
            })
    }

    /// 面材の内側（左右の縁を除く）を通る縦材の材心 [mm]。
    ///
    /// 釘の縦列はこの位置に入る（面材の左右の縁の釘列は、面材の側で決まる）。
    pub fn studs_between(&self, left: f64, right: f64) -> Vec<f64> {
        self.of(Direction::Vertical)
            .iter()
            .map(|member| member.position)
            .filter(|position| *position > left && *position < right)
            .collect()
    }

    /// 壁の内側に縦材が立っているか（せん断座屈の ξ を決める中間材の有無）。
    pub fn has_intermediate_stud(&self, wall_width: f64) -> bool {
        !self.studs_between(0.0, wall_width).is_empty()
    }

    /// 等間隔の軸組を組み立てる（尺モジュールのような一般的な壁の初期値）。
    ///
    /// 壁の両端に柱、その間に間柱をピッチで等間隔に立て、壁の上下に横架材を
    /// 置く。面材の継目に入れる受け材は納まりで決まるので、ここには入れない
    /// （画面で 1 本ずつ足す）。
    pub fn from_stud_pitch(width: f64, height: f64, stud_pitch: f64) -> Frame {
        let mut members = vec![Member::new(
            Direction::Vertical,
            COLUMN_LABEL,
            0.0,
            DEFAULT_COLUMN_WIDTH,
        )];
        if stud_pitch > 0.0 && width > 0.0 {
            // 桁を間違えたピッチで数え上げが止まらないよう、本数で頭を打つ。
            let count = (width / stud_pitch).ceil() as usize;
            for index in 1..count.min(MAX_MEMBERS) {
                let position = stud_pitch * index as f64;
                if position >= width {
                    break;
                }
                members.push(Member::new(
                    Direction::Vertical,
                    STUD_LABEL,
                    position,
                    DEFAULT_STUD_WIDTH,
                ));
            }
        }
        members.push(Member::new(
            Direction::Vertical,
            COLUMN_LABEL,
            width,
            DEFAULT_COLUMN_WIDTH,
        ));
        members.push(Member::new(
            Direction::Horizontal,
            BEAM_LABEL,
            0.0,
            DEFAULT_BEAM_WIDTH,
        ));
        members.push(Member::new(
            Direction::Horizontal,
            BEAM_LABEL,
            height,
            DEFAULT_BEAM_WIDTH,
        ));
        Frame::new(members)
    }

    /// その位置に軸組材が無ければ、継目の材として足す。
    ///
    /// 軸組材を持たない版で保存した入力を読むときに使う（当時は面材の継目に
    /// 材があるものとして計算していたので、その前提をそのまま形にする）。
    pub fn add_joint(&mut self, direction: Direction, position: f64) {
        if self.carrying(direction, position).is_some() {
            return;
        }
        self.members.push(Member::new(
            direction,
            JOINT_LABEL,
            position,
            DEFAULT_JOINT_WIDTH,
        ));
    }

    pub fn to_value(&self) -> Value {
        Value::Arr(self.members.iter().map(Member::to_value).collect())
    }
}

/// 釘列 1 本と、それを受ける軸組材の縁端距離。
#[derive(Debug, Clone, PartialEq)]
pub struct Clearance {
    /// どの釘列か（「左の縁」「中間の縦材（X = 455 mm）」など）。
    pub line: String,
    /// 受ける軸組材（無ければ None＝そこに釘を打てない）。
    pub member: Option<Member>,
    /// 縁端距離 [mm]（受ける材が無ければ None）。
    pub distance: Option<f64>,
}

impl Clearance {
    /// 必要な縁端距離に対する余裕 [mm]。受ける材が無ければ最も厳しい。
    pub fn margin(&self, required: f64) -> f64 {
        match self.distance {
            Some(distance) => distance - required,
            None => f64::NEG_INFINITY,
        }
    }

    pub fn ok(&self, required: f64) -> bool {
        // 表示の桁で切り上がって「足りているのに NG」に見えないよう、丸めの
        // 幅だけ許す（寸法は mm 単位の入力なので、この幅で判定は変わらない）。
        self.margin(required) >= -1e-9
    }

    /// 判定の根拠として読める 1 行。
    pub fn label(&self) -> String {
        match &self.member {
            Some(member) => format!("{} ／ {}", self.line, member.label_with_width()),
            None => format!("{} ／ 軸組材なし", self.line),
        }
    }

    /// 縁端距離の値（受ける材が無ければ「—」）。
    pub fn value(&self) -> String {
        match self.distance {
            Some(distance) => format!("{} mm", format_dimension(distance)),
            None => "—".to_string(),
        }
    }
}

/// 面材 1 枚が壁の中で占める領域と、その釘のへりあき。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placement {
    /// 壁の中でこの面材が占める領域 [mm]（壁の左下が原点）。
    pub left: f64,
    pub bottom: f64,
    pub right: f64,
    pub top: f64,
    /// へりあき（面材の縁から釘の中心まで）[mm]。
    pub edge_distance: f64,
}

/// 面材 1 枚の釘列を、受ける軸組材ごとの縁端距離にする。
///
/// 並びは釘配列図と同じく左から右・下から上（左の縁 → 中間の縦材 → 右の縁
/// → 下の縁 → 上の縁）。中間の縦材は、釘配列計算に入れた列だけを渡す
/// （3.3(1)⑧ で外した縦列は釘そのものを置いていない）。
pub fn clearances(placement: &Placement, frame: &Frame, studs: &[f64]) -> Vec<Clearance> {
    let edge = placement.edge_distance;
    let mut lines = vec![clearance_of(
        frame,
        Direction::Vertical,
        "左の縁".to_string(),
        placement.left + edge,
    )];
    for stud in studs {
        lines.push(clearance_of(
            frame,
            Direction::Vertical,
            format!(
                "中間の縦材（{} = {} mm）",
                Direction::Vertical.axis(),
                format_dimension(*stud)
            ),
            *stud,
        ));
    }
    lines.push(clearance_of(
        frame,
        Direction::Vertical,
        "右の縁".to_string(),
        placement.right - edge,
    ));
    lines.push(clearance_of(
        frame,
        Direction::Horizontal,
        "下の縁".to_string(),
        placement.bottom + edge,
    ));
    lines.push(clearance_of(
        frame,
        Direction::Horizontal,
        "上の縁".to_string(),
        placement.top - edge,
    ));
    lines
}

fn clearance_of(frame: &Frame, direction: Direction, line: String, at: f64) -> Clearance {
    match frame.carrying(direction, at) {
        Some(member) => Clearance {
            line,
            member: Some(member.clone()),
            distance: Some(member.clearance_at(at)),
        },
        None => Clearance {
            line,
            member: None,
            distance: None,
        },
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

/// 縁端距離がいちばん厳しい釘列（必要な値に対する余裕がいちばん小さいもの）。
pub fn worst(clearances: &[Clearance], required: f64) -> Clearance {
    clearances
        .iter()
        .fold(clearances[0].clone(), |worst, line| {
            if line.margin(required) < worst.margin(required) {
                line.clone()
            } else {
                worst
            }
        })
}

/// 軸組材の一覧を、計算書と画面に並べる 1 行ずつの表にする。
pub fn rows(frame: &Frame) -> Vec<Value> {
    DIRECTIONS
        .iter()
        .flat_map(|direction| frame.of(*direction))
        .map(|member| {
            Value::obj([
                ("label", member.label.clone().into()),
                (
                    "cells",
                    Value::Arr(
                        [
                            member.direction.label().to_string(),
                            format!(
                                "{} = {}",
                                member.direction.axis(),
                                format_int(member.position)
                            ),
                            format_dimension(member.width),
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

#[cfg(test)]
mod tests {
    use super::*;

    /// グレー本 3.3(3) の計算例の壁（W 910 × H 3000、間柱 @455）の軸組。
    fn example_frame() -> Frame {
        Frame::from_stud_pitch(910.0, 3000.0, 455.0)
    }

    fn panel(left: f64, bottom: f64, right: f64, top: f64) -> Placement {
        Placement {
            left,
            bottom,
            right,
            top,
            edge_distance: 10.0,
        }
    }

    #[test]
    fn an_even_frame_stands_columns_at_both_ends_and_studs_between() {
        let frame = example_frame();
        let verticals: Vec<(String, f64, f64)> = frame
            .of(Direction::Vertical)
            .iter()
            .map(|member| (member.label.clone(), member.position, member.width))
            .collect();
        assert_eq!(
            verticals,
            vec![
                ("柱".to_string(), 0.0, 105.0),
                ("間柱".to_string(), 455.0, 45.0),
                ("柱".to_string(), 910.0, 105.0),
            ]
        );
        let horizontals: Vec<f64> = frame
            .of(Direction::Horizontal)
            .iter()
            .map(|member| member.position)
            .collect();
        assert_eq!(horizontals, vec![0.0, 3000.0]);
    }

    #[test]
    fn members_can_stand_anywhere() {
        // 等間隔でない軸組（開口の脇に寄せた縦材と、窓台の受け材）。
        let frame = Frame::new(vec![
            Member::new(Direction::Vertical, "柱", 0.0, 105.0),
            Member::new(Direction::Vertical, "間柱", 600.0, 45.0),
            Member::new(Direction::Horizontal, "窓台", 800.0, 60.0),
        ]);
        assert_eq!(frame.studs_between(0.0, 910.0), vec![600.0]);
        assert_eq!(
            frame.carrying(Direction::Horizontal, 810.0).unwrap().label,
            "窓台"
        );
        // 材の外（材心 800・見付け 60 なので 770〜830 の外）は受けられない。
        assert!(frame.carrying(Direction::Horizontal, 840.0).is_none());
    }

    #[test]
    fn the_clearance_is_measured_from_the_edge_of_the_member() {
        let frame = example_frame();
        let lines = clearances(&panel(0.0, 0.0, 910.0, 1820.0), &frame, &[]);
        let line = |name: &str| {
            lines
                .iter()
                .find(|line| line.line.starts_with(name))
                .expect("その釘列がある")
                .clone()
        };
        // 柱（材心 0・見付け 105）に、へりあき 10 の釘 → 52.5 − 10。
        assert_eq!(line("左の縁").distance, Some(42.5));
        assert_eq!(line("右の縁").distance, Some(42.5));
        // 横架材（材心 0）も同じ。
        assert_eq!(line("下の縁").distance, Some(42.5));
        // 上の縁（Y = 1810）には材が無い＝面材の継目に受け材が入っていない。
        assert_eq!(line("上の縁").distance, None);
        assert_eq!(line("上の縁").label(), "上の縁 ／ 軸組材なし");
    }

    #[test]
    fn a_nail_on_an_intermediate_member_sits_on_its_centre() {
        let frame = example_frame();
        let lines = clearances(&panel(0.0, 0.0, 910.0, 910.0), &frame, &[455.0]);
        let stud = lines
            .iter()
            .find(|line| line.line.starts_with("中間の縦材"))
            .unwrap();
        assert_eq!(stud.line, "中間の縦材（X = 455 mm）");
        // 間柱 45 の心に打つので 22.5 mm（へりあきに依らない）。
        assert_eq!(stud.distance, Some(22.5));
        assert_eq!(
            stud.label(),
            "中間の縦材（X = 455 mm） ／ 間柱（見付け 45 mm）"
        );
    }

    /// 材心が面材の縁からずれていても、実際の材の縁から測る。
    #[test]
    fn a_member_off_the_panel_edge_is_measured_where_it_is() {
        // 面材の左端（X = 0）に対して、心が 30 mm 内側にずれた 105 の柱。
        let frame = Frame::new(vec![Member::new(Direction::Vertical, "柱", 30.0, 105.0)]);
        let lines = clearances(&panel(0.0, 0.0, 910.0, 910.0), &frame, &[]);
        // 釘は X = 10、材は −22.5〜82.5 なので、近いほうの縁まで 32.5 mm。
        assert_eq!(lines[0].distance, Some(32.5));
    }

    #[test]
    fn a_joint_can_be_added_where_no_member_stands() {
        let mut frame = example_frame();
        frame.add_joint(Direction::Horizontal, 1820.0);
        assert_eq!(
            frame.carrying(Direction::Horizontal, 1810.0).unwrap().label,
            "継目の材"
        );
        // すでに材があるところには足さない。
        let before = frame.members.len();
        frame.add_joint(Direction::Horizontal, 1820.0);
        frame.add_joint(Direction::Vertical, 0.0);
        assert_eq!(frame.members.len(), before);
    }

    #[test]
    fn overlapping_members_take_the_one_with_the_most_room() {
        let frame = Frame::new(vec![
            Member::new(Direction::Vertical, "間柱", 455.0, 45.0),
            Member::new(Direction::Vertical, "抱き間柱", 460.0, 105.0),
        ]);
        let member = frame.carrying(Direction::Vertical, 455.0).unwrap();
        assert_eq!(member.label, "抱き間柱");
        assert_eq!(member.clearance_at(455.0), 47.5);
    }

    #[test]
    fn the_required_clearance_is_twenty_millimetres_or_five_diameters() {
        // N-50（φ2.75）・N-65（φ3.05）・CN 釘 75（φ3.76）は 5d が 20 mm に
        // 届かないので 20 mm。
        assert_eq!(required_clearance(Some(2.75)), 20.0);
        assert_eq!(required_clearance(Some(3.05)), 20.0);
        assert_eq!(required_clearance(Some(3.76)), 20.0);
        // 太い接合具では 5d の側が効く。
        assert_eq!(required_clearance(Some(6.0)), 30.0);
        // 釘を選んでいない面材は 20 mm だけで確かめる。
        assert_eq!(required_clearance(None), 20.0);
    }

    #[test]
    fn the_worst_line_is_the_one_with_the_least_room() {
        let frame = example_frame();
        let lines = clearances(&panel(0.0, 0.0, 910.0, 1820.0), &frame, &[]);
        // 受ける材が無い釘列は、どんな縁端距離より厳しい。
        let least = worst(&lines, 20.0);
        assert_eq!(least.line, "上の縁");
        assert!(!least.ok(20.0));
        assert_eq!(least.value(), "—");

        // 受け材を入れれば、いちばん厳しいのは間柱（45 / 2）になる。
        let mut frame = frame;
        frame.add_joint(Direction::Horizontal, 1820.0);
        let lines = clearances(&panel(0.0, 0.0, 910.0, 1820.0), &frame, &[455.0]);
        let least = worst(&lines, 20.0);
        assert_eq!(least.distance, Some(22.5));
        assert!(least.ok(20.0));
    }

    /// 桁を間違えたピッチでも、軸組材の本数で頭打ちにする。
    #[test]
    fn an_absurd_pitch_does_not_run_away() {
        let frame = Frame::from_stud_pitch(910.0, 3000.0, 0.5);
        assert!(frame.members.len() <= MAX_MEMBERS + 3);
    }
}
