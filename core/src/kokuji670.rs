//! 平成 27 年国土交通省告示第 670 号（耐震診断・耐震改修の業務報酬基準）。
//!
//! 「建築物の耐震診断及び耐震改修に係る設計等に関する標準業務及び報酬」を
//! 定める告示。耐震診断と耐震改修に係る設計の報酬を、標準業務人・時間数から
//! 略算する道筋がここにある。
//!
//! **この表は告示（官報）に書いてあるものなので、リポジトリに置く。**
//! 事務所が独自に決めた係数（人件費単価・技術料等経費率）はここには無く、
//! 共有設定（Firestore）から式へ渡ってくる。分ける線は「原文があるかどうか」
//! で、その考え方は docs/contract-formatter.md §6 にある。
//!
//! 告示第 8 号（令和 6 年。設計・工事監理等）との違い:
//!
//! | | 告示第 8 号 | **この告示（第 670 号）** |
//! | --- | --- | --- |
//! | 業務経費の費目 | 直接人件費・特別経費・直接経費・間接経費 | **検査費が加わる** |
//! | 直接経費 + 間接経費の倍数 | 1.1 を標準 | **1.0 を標準** |
//! | 略算方法の対象 | 別添二の 15 類型 | **S 造・RC 造・SRC 造、又は戸建木造住宅** |
//!
//! **実装するのは戸建木造住宅（別添二 別表第二）だけ。** 別表第一
//! （S 造・RC 造・SRC 造）は 500㎡〜7,500㎡ の 8 刻みで、先行実装は刻みの間を
//! `A = a × S^b` で埋めているが、その係数の出どころを原文で確かめられていない。
//! 事務所が受けるのは戸建木造なので、確かめられるまで実装しない
//! （docs/contract-formatter.md §6.7・§10 の G）。
//!
//! > 告示第 98 号（平成 31 年）は、告示第 8 号 附則 2 項により廃止されている。
//! > 参照してはならない。

/// 別添二 別表第二（戸建木造住宅）の行。
///
/// (業務の id, 業務の名称, 標準業務人・時間数)。
///
/// **この表は床面積の範囲に対する 1 つの値であり、補間してはならない。**
/// 告示第 8 号の別表（100/150/200/300㎡ の離散点）と違い、刻みが無い。
pub const DETACHED_TIMBER_HOUSE: [(&str, &str, i64); 2] = [
    ("diagnosis", "耐震診断", 45),
    ("retrofit-design", "耐震改修に係る設計", 60),
];

/// 別表第二が対象とする床面積の合計の下限 [㎡]。
pub const DETACHED_TIMBER_HOUSE_MIN_AREA: f64 = 75.0;

/// 別表第二が対象とする床面積の合計の上限 [㎡]。
pub const DETACHED_TIMBER_HOUSE_MAX_AREA: f64 = 250.0;

/// 直接経費及び間接経費の、直接人件費に対する標準の倍数（第四 ロ）。
///
/// 告示第 8 号の 1.1 とは違う。共有設定で調整できる（通常の場合に比べ著しく
/// 異なる場合は倍数を調整してよい）が、既定はこの標準値。
pub const STANDARD_OVERHEAD_MULTIPLIER: f64 = 1.0;

/// この告示に基づく略算ができるかどうかと、できない理由。
pub enum Applicability {
    /// 略算方法を適用できる。標準業務人・時間数を返す。
    Applicable { hours: i64, label: &'static str },
    /// 略算方法の対象外。利用者に見せる理由を返す。
    OutOfScope(String),
}

/// 戸建木造住宅の標準業務人・時間数を引く。
///
/// 床面積が別表第二の範囲（75〜250㎡）を外れるときは、**参考値も出さない**。
/// 表が範囲に対する 1 つの値である以上、範囲の外へ延ばす根拠が無いため。
pub fn detached_timber_house(work: &str, floor_area: f64) -> Applicability {
    let found = DETACHED_TIMBER_HOUSE
        .iter()
        .find(|(id, _, _)| *id == work)
        .map(|(_, label, hours)| (*label, *hours));

    let Some((label, hours)) = found else {
        return Applicability::OutOfScope(format!(
            "告示第670号 別添二 別表第二に無い業務です（耐震診断・耐震改修に係る設計）: {work}"
        ));
    };

    if !floor_area.is_finite() || floor_area <= 0.0 {
        return Applicability::OutOfScope("床面積の合計を入力してください。".to_string());
    }
    if floor_area < DETACHED_TIMBER_HOUSE_MIN_AREA || floor_area > DETACHED_TIMBER_HOUSE_MAX_AREA {
        return Applicability::OutOfScope(format!(
            "床面積の合計が別表第二の範囲（{}㎡〜{}㎡）の外なので、\
             告示の略算方法は使えません。実費を積み上げて単価を入れてください。",
            DETACHED_TIMBER_HOUSE_MIN_AREA as i64, DETACHED_TIMBER_HOUSE_MAX_AREA as i64
        ));
    }

    Applicability::Applicable { hours, label }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hours(work: &str, area: f64) -> Option<i64> {
        match detached_timber_house(work, area) {
            Applicability::Applicable { hours, .. } => Some(hours),
            Applicability::OutOfScope(_) => None,
        }
    }

    /// 別添二 別表第二の値そのもの。ここが動いたら告示の転記を疑うこと。
    #[test]
    fn holds_the_values_of_the_notification_table() {
        assert_eq!(hours("diagnosis", 120.0), Some(45));
        assert_eq!(hours("retrofit-design", 120.0), Some(60));
    }

    /// 範囲に対する 1 つの値なので、面積を動かしても値は変わらない（補間しない）。
    #[test]
    fn does_not_interpolate_within_the_range() {
        assert_eq!(hours("diagnosis", 75.0), Some(45));
        assert_eq!(hours("diagnosis", 100.0), Some(45));
        assert_eq!(hours("diagnosis", 250.0), Some(45));
    }

    /// 範囲の外は、参考値も出さない（外挿の根拠が無い）。
    #[test]
    fn refuses_areas_outside_the_table() {
        assert_eq!(hours("diagnosis", 74.9), None);
        assert_eq!(hours("diagnosis", 250.1), None);
        assert_eq!(hours("diagnosis", 0.0), None);
        assert_eq!(hours("retrofit-construction-supervision", 120.0), None);
    }

    /// 告示第 8 号（1.1）と取り違えていないこと。
    #[test]
    fn uses_this_notifications_own_overhead_multiplier() {
        assert_eq!(STANDARD_OVERHEAD_MULTIPLIER, 1.0);
    }
}
