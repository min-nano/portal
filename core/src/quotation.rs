//! 見積書の計算と、業務ごとの摘要の組み立て。
//!
//! 見積書そのものは「明細を並べて、消費税を足す」だけの帳票で、難しい計算は
//! 無い。にもかかわらずここ（唯一の計算実装）に置いているのは、**画面が入力の
//! たびに出す金額と、PDF に刷られる金額が、別々の実装から出てくる状態を作らない**
//! ため。ファイル名の既定値も、有効期限の既定値も、同じ理由でここが決める。
//!
//! 金額は**円の整数**で持ち、浮動小数点を経由させない。率（消費税率・技術料等
//! 経費率）は万分率、倍数は千分率、数量は千分の一の整数に直してから掛け、
//! **丸めは割り算のときに 1 度だけ**起こす（docs/contract-formatter.md §6.6）。
//!
//! 摘要（項目の説明文）について
//! ----------------------------
//! このモジュールが組み立てるのは、**業界の標準的な語彙で書ける部分だけ**——
//! 規模・床面積・設計方法・診断法の行。事務所固有の言い回し（但し書き・
//! 免責・支払条件）は共有設定（Firestore）から `terms` として渡ってきて、
//! 末尾に足される。**リポジトリに事務所固有の文言を置かない**という決めごと
//! （docs/contract-formatter.md §8）に従うため。
//!
//! 組み立てるのはあくまで**候補**で、項目が持つのは利用者が確定させた文字列。
//! PDF に刷られるのはそちらで、設定を後から変えても過去の見積書は変わらない
//! （同 §7「印字する値はマスタを参照せず、入力された値を使います」）。

use crate::format;
use crate::json::Value;
use crate::kokuji670;

/// 1 通に並べられる明細の上限（PDF の頁組みが破綻しない範囲）。
pub const MAX_ITEMS: usize = 40;

/// 消費税率の既定（％）。法定の税率であって事務所が決めた値ではない。
pub const DEFAULT_TAX_RATE: f64 = 10.0;

/// 軽減税率の既定（％）。
pub const DEFAULT_REDUCED_TAX_RATE: f64 = 8.0;

// --- 丸め --------------------------------------------------------------------

/// 端数の寄せ方。消費税の端数処理は法令が定めていないので、事務所が選ぶ。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rounding {
    Floor,
    Round,
    Ceil,
}

impl Rounding {
    fn parse(text: &str) -> Rounding {
        match text {
            "round" => Rounding::Round,
            "ceil" => Rounding::Ceil,
            _ => Rounding::Floor,
        }
    }

    fn id(self) -> &'static str {
        match self {
            Rounding::Floor => "floor",
            Rounding::Round => "round",
            Rounding::Ceil => "ceil",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Rounding::Floor => "切り捨て",
            Rounding::Round => "四捨五入",
            Rounding::Ceil => "切り上げ",
        }
    }
}

/// `numerator / denominator` を整数へ寄せる（`denominator` は正）。
///
/// 値引きの行があると負の金額が出るので、負の側でも「切り捨て＝より小さい方へ」
/// 「四捨五入＝絶対値の 0.5 は絶対値の大きい方へ」と、符号によらず同じ意味に
/// なるようにしてある。
fn divide(numerator: i64, denominator: i64, rounding: Rounding) -> i64 {
    debug_assert!(denominator > 0);
    match rounding {
        Rounding::Floor => numerator.div_euclid(denominator),
        Rounding::Ceil => -((-numerator).div_euclid(denominator)),
        Rounding::Round => {
            let half = denominator / 2;
            if numerator >= 0 {
                (numerator + half).div_euclid(denominator)
            } else {
                -((-numerator + half).div_euclid(denominator))
            }
        }
    }
}

/// 四捨五入で整数へ（金額そのものの確定に使う）。
fn round_to_int(numerator: i64, denominator: i64) -> i64 {
    divide(numerator, denominator, Rounding::Round)
}

// --- 入力の解釈 --------------------------------------------------------------

/// 数値の欄を読む。JSON の数値でも、画面から来る文字列でも同じに読む。
///
/// 「284,000」「 1.5 」「¥120000」のように、人が打つ形をそのまま受ける。
fn number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Num(number)) if number.is_finite() => Some(*number),
        Some(Value::Str(text)) => {
            let cleaned: String = text
                .chars()
                .filter(|c| !matches!(c, ',' | ' ' | '\u{3000}' | '¥' | '￥' | '円'))
                .collect();
            let cleaned = cleaned.trim();
            if cleaned.is_empty() {
                return None;
            }
            cleaned.parse::<f64>().ok().filter(|n| n.is_finite())
        }
        _ => None,
    }
}

fn number_or(value: Option<&Value>, fallback: f64) -> f64 {
    number(value).unwrap_or(fallback)
}

fn text(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// 複数行の欄（摘要・備考・共通文）。行末の空白だけ落として改行は残す。
fn multiline(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim_matches('\n')
        .to_string()
}

/// 率（％）を万分率の整数にする。10% → 1000。
fn rate_to_basis_points(percent: f64) -> i64 {
    (percent * 100.0).round() as i64
}

/// 倍数を千分率の整数にする。1.1 → 1100。
fn multiplier_to_permille(multiplier: f64) -> i64 {
    (multiplier * 1000.0).round() as i64
}

// --- 消費税の設定 ------------------------------------------------------------

/// 見積書が使う税の条件。**設定ではなく見積書そのものが持つ**（設定は初期値）。
#[derive(Debug, Clone, PartialEq)]
pub struct TaxTerms {
    pub rate_bp: i64,
    pub reduced_rate_bp: i64,
    pub rounding: Rounding,
}

impl TaxTerms {
    fn from_value(value: Option<&Value>) -> TaxTerms {
        let empty = Value::Null;
        let source = value.unwrap_or(&empty);
        TaxTerms {
            rate_bp: rate_to_basis_points(number_or(source.get("taxRate"), DEFAULT_TAX_RATE)),
            reduced_rate_bp: rate_to_basis_points(number_or(
                source.get("reducedTaxRate"),
                DEFAULT_REDUCED_TAX_RATE,
            )),
            rounding: Rounding::parse(&text(source.get("taxRounding"))),
        }
    }

    fn to_value(&self) -> Value {
        Value::obj([
            ("taxRate", (self.rate_bp as f64 / 100.0).into()),
            ("reducedTaxRate", (self.reduced_rate_bp as f64 / 100.0).into()),
            ("taxRounding", self.rounding.id().into()),
        ])
    }

    fn rate_bp_of(&self, category: TaxCategory) -> i64 {
        match category {
            TaxCategory::Standard => self.rate_bp,
            TaxCategory::Reduced => self.reduced_rate_bp,
            TaxCategory::Exempt => 0,
        }
    }
}

/// 明細ごとの税の区分。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaxCategory {
    /// 標準税率の対象。
    Standard,
    /// 軽減税率の対象。
    Reduced,
    /// 課税の対象外（立替金など）。
    Exempt,
}

impl TaxCategory {
    fn parse(text: &str) -> TaxCategory {
        match text {
            "reduced" => TaxCategory::Reduced,
            "exempt" => TaxCategory::Exempt,
            _ => TaxCategory::Standard,
        }
    }

    fn id(self) -> &'static str {
        match self {
            TaxCategory::Standard => "standard",
            TaxCategory::Reduced => "reduced",
            TaxCategory::Exempt => "exempt",
        }
    }

    fn label(self) -> &'static str {
        match self {
            TaxCategory::Standard => "標準税率",
            TaxCategory::Reduced => "軽減税率",
            TaxCategory::Exempt => "対象外",
        }
    }
}

// --- 業務のテンプレート ------------------------------------------------------

/// 摘要の組み立て方。テンプレートごとに、どの行を作るかが決まる。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Composition {
    /// 設計・計算の業務（規模と設計方法の行を作る）。
    Design,
    /// 耐震診断・耐震補強設計（規模と診断法の行を作る）。
    Seismic,
    /// 自由記述だけ（変更設計料・実費など）。
    Free,
}

impl Composition {
    fn id(self) -> &'static str {
        match self {
            Composition::Design => "design",
            Composition::Seismic => "seismic",
            Composition::Free => "free",
        }
    }
}

/// 業務のテンプレート。品名の既定と、摘要の組み立て方を持つ。
pub struct Template {
    pub id: &'static str,
    /// 選択肢に出す名前。
    pub name: &'static str,
    /// 品名（明細の 1 行目）の既定。
    pub title: &'static str,
    pub composition: Composition,
    /// 面積の欄の見出し（業務によって呼び名が違う）。
    pub area_label: &'static str,
    /// 告示第670号 別添二 別表第二の、どの行に当たるか（当たらなければ空）。
    pub seismic_work: &'static str,
}

/// 扱う業務の一覧。
///
/// 品名も面積の呼び名も、建築の一般的な語彙の範囲に収めてある。事務所固有の
/// 言い回しはここに書かず、共有設定の共通文（`terms`）として重ねる。
pub const TEMPLATES: [Template; 8] = [
    Template {
        id: "structural-design",
        name: "構造設計（構造計算＋構造図）",
        title: "新築木造軸組建築物の構造計算及び構造図作成",
        composition: Composition::Design,
        area_label: "構造床面積",
        seismic_work: "",
    },
    Template {
        id: "structural-calculation",
        name: "構造計算のみ",
        title: "新築木造軸組建築物の構造計算",
        composition: Composition::Design,
        area_label: "構造床面積",
        seismic_work: "",
    },
    Template {
        id: "wall-quantity-design",
        name: "壁量計算＋基礎構造図",
        title: "新築木造軸組建築物の壁量計算及び基礎構造図作成",
        composition: Composition::Design,
        area_label: "構造床面積",
        seismic_work: "",
    },
    Template {
        id: "foundation-design",
        name: "基礎の構造設計",
        title: "新築木造軸組建築物基礎の構造計算及び構造図作成",
        composition: Composition::Design,
        area_label: "水平投影面積",
        seismic_work: "",
    },
    Template {
        id: "seismic-diagnosis",
        name: "耐震診断",
        title: "木造住宅の耐震診断",
        composition: Composition::Seismic,
        area_label: "延べ面積",
        seismic_work: "diagnosis",
    },
    Template {
        id: "seismic-retrofit-design",
        name: "耐震補強設計",
        title: "木造住宅の耐震補強設計",
        composition: Composition::Seismic,
        area_label: "延べ面積",
        seismic_work: "retrofit-design",
    },
    Template {
        id: "design-change",
        name: "変更設計料",
        title: "変更設計料",
        composition: Composition::Free,
        area_label: "",
        seismic_work: "",
    },
    Template {
        id: "other",
        name: "その他（自由記述）",
        title: "",
        composition: Composition::Free,
        area_label: "",
        seismic_work: "",
    },
];

fn template(id: &str) -> &'static Template {
    TEMPLATES
        .iter()
        .find(|t| t.id == id)
        .unwrap_or(&TEMPLATES[TEMPLATES.len() - 1])
}

/// 規模の欄に並べる候補。
pub const SCALE_OPTIONS: [&str; 4] = ["平屋建て", "2階建て", "3階建て", "地下1階地上2階建て"];

/// 設計方法の欄に並べる候補（建築基準法の設計ルート）。
pub const METHOD_OPTIONS: [&str; 4] = [
    "仕様規定(壁量計算)",
    "許容応力度計算(ルート1)",
    "許容応力度等計算(ルート2)",
    "限界耐力計算",
];

/// 耐震診断の方法の候補（日本建築防災協会の診断法）。
pub const DIAGNOSIS_METHOD_OPTIONS: [&str; 3] = ["一般診断法", "精密診断法", "保有耐力診断法"];

/// 床面積の書き方。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AreaMode {
    /// 約 N㎡（実施設計で動く前提の書き方）。
    Approximate,
    /// N㎡以下（上限だけを約束する書き方）。
    AtMost,
    /// N㎡（確定している場合）。
    Exact,
}

impl AreaMode {
    fn parse(text: &str) -> AreaMode {
        match text {
            "atMost" => AreaMode::AtMost,
            "exact" => AreaMode::Exact,
            _ => AreaMode::Approximate,
        }
    }

    fn id(self) -> &'static str {
        match self {
            AreaMode::Approximate => "approx",
            AreaMode::AtMost => "atMost",
            AreaMode::Exact => "exact",
        }
    }

    fn label(self) -> &'static str {
        match self {
            AreaMode::Approximate => "約〇㎡",
            AreaMode::AtMost => "〇㎡以下",
            AreaMode::Exact => "〇㎡（確定）",
        }
    }

    fn render(self, area: f64) -> String {
        let value = format::format_dimension(area);
        match self {
            AreaMode::Approximate => format!("約{value}㎡"),
            AreaMode::AtMost => format!("{value}㎡以下"),
            AreaMode::Exact => format!("{value}㎡"),
        }
    }
}

// --- 見積書の中身 ------------------------------------------------------------

/// 明細ごとの入力（テンプレートが読む欄）。
#[derive(Debug, Clone, PartialEq)]
pub struct Spec {
    pub scale: String,
    pub area_mode: AreaMode,
    pub floor_area: f64,
    pub method: String,
    pub diagnosis_method: String,
    /// 提出図書など、その明細だけの追加の行（自由記述）。
    pub note: String,
    /// 耐震の参考額を出すときの実費（検査費・特別経費）。
    pub inspection_cost: i64,
    pub special_cost: i64,
}

impl Spec {
    fn from_value(value: Option<&Value>) -> Spec {
        let empty = Value::Null;
        let source = value.unwrap_or(&empty);
        Spec {
            scale: text(source.get("scale")),
            area_mode: AreaMode::parse(&text(source.get("areaMode"))),
            floor_area: number_or(source.get("floorArea"), 0.0).max(0.0),
            method: text(source.get("method")),
            diagnosis_method: text(source.get("diagnosisMethod")),
            note: multiline(source.get("note")),
            inspection_cost: number_or(source.get("inspectionCost"), 0.0).round() as i64,
            special_cost: number_or(source.get("specialCost"), 0.0).round() as i64,
        }
    }

    fn to_value(&self) -> Value {
        Value::obj([
            ("scale", self.scale.clone().into()),
            ("areaMode", self.area_mode.id().into()),
            ("floorArea", self.floor_area.into()),
            ("method", self.method.clone().into()),
            ("diagnosisMethod", self.diagnosis_method.clone().into()),
            ("note", self.note.clone().into()),
            ("inspectionCost", (self.inspection_cost as f64).into()),
            ("specialCost", (self.special_cost as f64).into()),
        ])
    }
}

/// 明細 1 行。
#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub template_id: String,
    pub spec: Spec,
    /// 品名。組み立てた候補をそのまま使うことも、書き換えることもできる。
    pub title: String,
    /// 摘要（複数行）。同上。
    pub body: String,
    pub unit_price: i64,
    /// 数量。千分の一を単位とする整数で持つ（0.5 のような数量を扱うため）。
    pub quantity_milli: i64,
    pub tax_category: TaxCategory,
}

impl Item {
    fn from_value(value: &Value) -> Item {
        let template_id = text(value.get("templateId"));
        let template_id = if template_id.is_empty() {
            TEMPLATES[0].id.to_string()
        } else {
            template_id
        };
        Item {
            template_id,
            spec: Spec::from_value(value.get("spec")),
            title: text(value.get("title")),
            body: multiline(value.get("body")),
            unit_price: number_or(value.get("unitPrice"), 0.0).round() as i64,
            quantity_milli: (number_or(value.get("quantity"), 1.0) * 1000.0).round() as i64,
            tax_category: TaxCategory::parse(&text(value.get("taxCategory"))),
        }
    }

    fn to_value(&self) -> Value {
        Value::obj([
            ("templateId", self.template_id.clone().into()),
            ("spec", self.spec.to_value()),
            ("title", self.title.clone().into()),
            ("body", self.body.clone().into()),
            ("unitPrice", (self.unit_price as f64).into()),
            ("quantity", (self.quantity_milli as f64 / 1000.0).into()),
            ("taxCategory", self.tax_category.id().into()),
        ])
    }

    /// 金額＝単価 × 数量。数量が千分の一単位なので、最後に 1 度だけ丸める。
    fn amount(&self) -> i64 {
        round_to_int(self.unit_price * self.quantity_milli, 1000)
    }
}

/// 宛先。**保存も参照もしない。見積書ごとの入力そのもの。**
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Client {
    pub name: String,
    /// 御中／様／（なし）。法人か個人かで変わるので選ばせる。
    pub honorific: String,
    pub postal_code: String,
    pub address: String,
    pub department: String,
    pub contact_name: String,
    pub contact_honorific: String,
}

impl Client {
    fn from_value(value: Option<&Value>) -> Client {
        let empty = Value::Null;
        let source = value.unwrap_or(&empty);
        Client {
            name: text(source.get("name")),
            honorific: text(source.get("honorific")),
            postal_code: text(source.get("postalCode")),
            address: text(source.get("address")),
            department: text(source.get("department")),
            contact_name: text(source.get("contactName")),
            contact_honorific: text(source.get("contactHonorific")),
        }
    }

    fn to_value(&self) -> Value {
        Value::obj([
            ("name", self.name.clone().into()),
            ("honorific", self.honorific.clone().into()),
            ("postalCode", self.postal_code.clone().into()),
            ("address", self.address.clone().into()),
            ("department", self.department.clone().into()),
            ("contactName", self.contact_name.clone().into()),
            ("contactHonorific", self.contact_honorific.clone().into()),
        ])
    }

    /// 宛名の 1 行目（名称 + 敬称）。
    pub fn addressee(&self) -> String {
        join_non_empty(&[&self.name, &self.honorific], " ")
    }

    /// 担当者の行（役職・氏名 + 敬称）。
    pub fn contact_line(&self) -> String {
        join_non_empty(&[&self.contact_name, &self.contact_honorific], " ")
    }
}

/// 発行元。共有設定が初期値を配るが、**刷るのは見積書が持っている値**。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Issuer {
    pub name: String,
    pub postal_code: String,
    pub address: String,
    pub tel: String,
    pub person_name: String,
}

impl Issuer {
    fn from_value(value: Option<&Value>) -> Issuer {
        let empty = Value::Null;
        let source = value.unwrap_or(&empty);
        Issuer {
            name: text(source.get("name")),
            postal_code: text(source.get("postalCode")),
            address: text(source.get("address")),
            tel: text(source.get("tel")),
            person_name: text(source.get("personName")),
        }
    }

    fn to_value(&self) -> Value {
        Value::obj([
            ("name", self.name.clone().into()),
            ("postalCode", self.postal_code.clone().into()),
            ("address", self.address.clone().into()),
            ("tel", self.tel.clone().into()),
            ("personName", self.person_name.clone().into()),
        ])
    }
}

/// 見積書 1 通ぶんの入力。これがそのまま PDF の文書情報に入る。
#[derive(Debug, Clone, PartialEq)]
pub struct Form {
    pub number: String,
    pub issued_on: String,
    pub expires_on: String,
    pub subject: String,
    pub client: Client,
    pub issuer: Issuer,
    pub items: Vec<Item>,
    pub remarks: String,
    pub tax: TaxTerms,
}

/// 空の見積書（画面の「新規作成」の初期状態と同じもの）。
pub fn empty_form() -> Form {
    Form {
        number: String::new(),
        issued_on: String::new(),
        expires_on: String::new(),
        subject: String::new(),
        client: Client::default(),
        issuer: Issuer::default(),
        items: vec![empty_item()],
        remarks: String::new(),
        tax: TaxTerms {
            rate_bp: rate_to_basis_points(DEFAULT_TAX_RATE),
            reduced_rate_bp: rate_to_basis_points(DEFAULT_REDUCED_TAX_RATE),
            rounding: Rounding::Floor,
        },
    }
}

fn empty_item() -> Item {
    Item {
        template_id: TEMPLATES[0].id.to_string(),
        spec: Spec {
            scale: String::new(),
            area_mode: AreaMode::Approximate,
            floor_area: 0.0,
            method: String::new(),
            diagnosis_method: String::new(),
            note: String::new(),
            inspection_cost: 0,
            special_cost: 0,
        },
        title: String::new(),
        body: String::new(),
        unit_price: 0,
        quantity_milli: 1000,
        tax_category: TaxCategory::Standard,
    }
}

/// 受け取った入力を、このモジュールが扱う形へ整える。
///
/// 知らないキーは捨て、明細は 1 行以上に整える（空のフォームでも「明細が
/// 1 行ある」状態から始められるようにする）。
pub fn normalize(data: &Value) -> Result<Form, String> {
    let mut form = Form {
        number: text(data.get("number")),
        issued_on: text(data.get("issuedOn")),
        expires_on: text(data.get("expiresOn")),
        subject: text(data.get("subject")),
        client: Client::from_value(data.get("client")),
        issuer: Issuer::from_value(data.get("issuer")),
        items: data
            .get("items")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(Item::from_value).collect())
            .unwrap_or_default(),
        remarks: multiline(data.get("remarks")),
        tax: TaxTerms::from_value(data.get("tax")),
    };

    if form.items.len() > MAX_ITEMS {
        return Err(format!("明細は {MAX_ITEMS} 行までです。"));
    }
    if form.items.is_empty() {
        form.items.push(empty_item());
    }
    Ok(form)
}

impl Form {
    pub fn to_value(&self) -> Value {
        Value::obj([
            ("number", self.number.clone().into()),
            ("issuedOn", self.issued_on.clone().into()),
            ("expiresOn", self.expires_on.clone().into()),
            ("subject", self.subject.clone().into()),
            ("client", self.client.to_value()),
            ("issuer", self.issuer.to_value()),
            (
                "items",
                Value::Arr(self.items.iter().map(Item::to_value).collect()),
            ),
            ("remarks", self.remarks.clone().into()),
            ("tax", self.tax.to_value()),
        ])
    }
}

// --- 摘要の組み立て ----------------------------------------------------------

fn join_non_empty(parts: &[&str], separator: &str) -> String {
    parts
        .iter()
        .map(|part| part.trim())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(separator)
}

/// 品名の候補（テンプレートの既定）。
pub fn suggested_title(item: &Item) -> String {
    template(&item.template_id).title.to_string()
}

/// その明細に足す共通の但し書きを選ぶ。
///
/// 設定は業務の系統（設計／耐震）ごとに文言を持つので、テンプレートの
/// 組み立て方でどちらを使うかが決まる。1 つの文字列が来たときは全部に足す。
pub fn terms_for<'a>(terms: &'a Value, item: &Item) -> &'a str {
    match terms {
        Value::Str(text) => text,
        Value::Obj(_) => terms
            .get(template(&item.template_id).composition.id())
            .and_then(Value::as_str)
            .unwrap_or_default(),
        _ => "",
    }
}

/// 摘要の候補を組み立てる。
///
/// `terms` は共有設定から渡ってくる、事務所の共通の但し書き。
/// **その中身をこのモジュールは知らない**（改行区切りの文字列として足すだけ）。
pub fn suggested_body(item: &Item, terms: &str) -> String {
    let found = template(&item.template_id);
    let spec = &item.spec;
    let mut lines: Vec<String> = Vec::new();

    let area = if spec.floor_area > 0.0 {
        format!("{}{}", found.area_label, spec.area_mode.render(spec.floor_area))
    } else {
        String::new()
    };

    match found.composition {
        Composition::Design => {
            let scope = join_non_empty(&[&spec.scale, &area], "、");
            if !scope.is_empty() {
                lines.push(scope);
            }
            if !spec.method.is_empty() {
                lines.push(format!("{}による設計とします。", spec.method));
            }
        }
        Composition::Seismic => {
            let scope = join_non_empty(&[&spec.scale, &area], "、");
            if !scope.is_empty() {
                lines.push(scope);
            }
            if !spec.diagnosis_method.is_empty() {
                lines.push(if found.id == "seismic-retrofit-design" {
                    format!(
                        "{}による耐震診断の結果に基づき、耐震補強設計を行います。",
                        spec.diagnosis_method
                    )
                } else {
                    format!("{}により耐震診断を行います。", spec.diagnosis_method)
                });
            }
        }
        Composition::Free => {}
    }

    if !spec.note.is_empty() {
        lines.extend(spec.note.lines().map(str::to_string));
    }
    // 自由記述のテンプレートには共通の但し書きを足さない（実費や値引きの行に
    // 業務の約束事が付いてくると、書面として読めなくなる）。
    if found.composition != Composition::Free && !terms.trim().is_empty() {
        lines.extend(
            terms
                .lines()
                .map(str::trim_end)
                .filter(|line| !line.is_empty())
                .map(str::to_string),
        );
    }

    lines.join("\n")
}

// --- 日付 --------------------------------------------------------------------

fn parse_date(text: &str) -> Option<(i64, u32, u32)> {
    let mut parts = text.split('-');
    let year = parts.next()?.parse::<i64>().ok()?;
    let month = parts.next()?.parse::<u32>().ok()?;
    let day = parts.next()?.parse::<u32>().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some((year, month, day))
}

fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if is_leap_year(year) => 29,
        _ => 28,
    }
}

/// 有効期限の既定＝**発行日の翌月末日**。
///
/// 過去の見積書のほとんどがこの日付になっている。合わないときは画面で直す。
pub fn suggested_expiry(issued_on: &str) -> String {
    let Some((year, month, _)) = parse_date(issued_on) else {
        return String::new();
    };
    let (year, month) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    format!("{year:04}-{month:02}-{:02}", days_in_month(year, month))
}

/// 日付を書面の表記（YYYY/MM/DD）にする。読めない値はそのまま返す。
pub fn format_date(text: &str) -> String {
    match parse_date(text) {
        Some((year, month, day)) => format!("{year:04}/{month:02}/{day:02}"),
        None => text.to_string(),
    }
}

/// 日付をファイル名の表記（YYYYMMDD）にする。
fn compact_date(text: &str) -> String {
    match parse_date(text) {
        Some((year, month, day)) => format!("{year:04}{month:02}{day:02}"),
        None => String::new(),
    }
}

// --- 計算 --------------------------------------------------------------------

/// 税率の区分ごとの内訳（見積書の「内訳 10%対象」の行）。
struct Bucket {
    category: TaxCategory,
    base: i64,
    tax: i64,
    rate_bp: i64,
}

/// 見積書の金額を計算する。
pub fn compute(form: &Form) -> Value {
    let items: Vec<(&Item, i64)> = form.items.iter().map(|item| (item, item.amount())).collect();
    let subtotal: i64 = items.iter().map(|(_, amount)| *amount).sum();

    // 税率の区分ごとに集めてから 1 度だけ税額を出す。行ごとに丸めて足すと、
    // 「内訳の税額」と「合計の税額」が食い違う書面になる。
    let mut buckets: Vec<Bucket> = Vec::new();
    for category in [TaxCategory::Standard, TaxCategory::Reduced, TaxCategory::Exempt] {
        let base: i64 = items
            .iter()
            .filter(|(item, _)| item.tax_category == category)
            .map(|(_, amount)| *amount)
            .sum();
        if base == 0 {
            continue;
        }
        let rate_bp = form.tax.rate_bp_of(category);
        let tax = divide(base * rate_bp, 10_000, form.tax.rounding);
        buckets.push(Bucket { category, base, tax, rate_bp });
    }

    let tax_total: i64 = buckets.iter().map(|bucket| bucket.tax).sum();
    let total = subtotal + tax_total;

    let item_values: Vec<Value> = items
        .iter()
        .map(|(item, amount)| {
            Value::obj([
                ("amount", (*amount as f64).into()),
                ("amountText", format::format_yen(*amount).into()),
                ("unitPriceText", format::format_yen(item.unit_price).into()),
                (
                    "quantityText",
                    format::format_dimension(item.quantity_milli as f64 / 1000.0).into(),
                ),
                ("taxCategory", item.tax_category.id().into()),
            ])
        })
        .collect();

    let bucket_values: Vec<Value> = buckets
        .iter()
        .map(|bucket| {
            let rate = bucket.rate_bp as f64 / 100.0;
            Value::obj([
                ("category", bucket.category.id().into()),
                (
                    "label",
                    if bucket.category == TaxCategory::Exempt {
                        "対象外".to_string()
                    } else {
                        format!("{}%対象", format::format_dimension(rate))
                    }
                    .into(),
                ),
                ("base", (bucket.base as f64).into()),
                ("baseText", format::format_yen(bucket.base).into()),
                ("tax", (bucket.tax as f64).into()),
                ("taxText", format::format_yen(bucket.tax).into()),
            ])
        })
        .collect();

    Value::obj([
        ("items", Value::Arr(item_values)),
        (
            "totals",
            Value::obj([
                ("subtotal", (subtotal as f64).into()),
                ("subtotalText", format::format_yen(subtotal).into()),
                ("tax", (tax_total as f64).into()),
                ("taxText", format::format_yen(tax_total).into()),
                ("total", (total as f64).into()),
                ("totalText", format::format_yen(total).into()),
                ("buckets", Value::Arr(bucket_values)),
                ("roundingLabel", form.tax.rounding.label().into()),
            ]),
        ),
        ("defaultFileName", default_file_name(form, total).into()),
        ("suggestedExpiresOn", suggested_expiry(&form.issued_on).into()),
        ("warnings", Value::Arr(warnings(form, total))),
    ])
}

/// 保存できない入力（PDF を作らせない条件）を確かめる。
///
/// 見積書は努力義務の書面なので、止めるのは「書面として成り立たない」ものだけ。
pub fn validate(form: &Form) -> Result<(), String> {
    if form.number.trim().is_empty() {
        return Err("見積書番号を入力してください。".to_string());
    }
    if form.issued_on.trim().is_empty() {
        return Err("発行日を入力してください。".to_string());
    }
    if form.client.name.trim().is_empty() {
        return Err("宛先（取引先の名称）を入力してください。".to_string());
    }
    if form.issuer.name.trim().is_empty() {
        return Err(
            "発行元が未設定です。画面の「設定」から事務所の名称・所在地を登録してください。"
                .to_string(),
        );
    }
    if form.items.iter().all(|item| item.title.trim().is_empty()) {
        return Err("明細の品名を入力してください。".to_string());
    }
    Ok(())
}

/// 止めはしないが、書面として気になるところ。
fn warnings(form: &Form, total: i64) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    if total <= 0 {
        out.push("御見積金額が 0 円以下です。単価と数量を確かめてください。".into());
    }
    if form.subject.trim().is_empty() {
        out.push("件名が未入力です。".into());
    }
    if !form.expires_on.is_empty()
        && !form.issued_on.is_empty()
        && form.expires_on < form.issued_on
    {
        out.push("有効期限が発行日より前になっています。".into());
    }
    for (index, item) in form.items.iter().enumerate() {
        if item.title.trim().is_empty() && item.unit_price != 0 {
            out.push(format!("{} 行目の品名が未入力です。", index + 1).into());
        }
    }
    out
}

/// 既定のファイル名 `YYYYMMDD_取引先名_金額.pdf`。
///
/// 電子帳簿保存法の検索要件（取引年月日・取引先・取引金額）に、そのまま
/// 保存するだけで備えられる形にしておく（docs/contract-formatter.md §7.2）。
fn default_file_name(form: &Form, total: i64) -> String {
    let date = compact_date(&form.issued_on);
    let client = form.client.name.trim();
    let parts = [date.as_str(), client, &total.to_string()];
    let joined = parts
        .iter()
        .map(|part| part.trim())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("_");
    if joined.is_empty() {
        "見積書.pdf".to_string()
    } else {
        format!("{joined}.pdf")
    }
}

// --- 耐震診断・耐震補強設計の参考額（告示第670号） ---------------------------

/// 参考額を出すときに要る、事務所の設定値。**告示に定めが無いもの。**
struct FeeSettings {
    personnel_unit_price: i64,
    technical_fee_rate_bp: i64,
    overhead_multiplier_permille: i64,
}

impl FeeSettings {
    fn from_value(value: Option<&Value>) -> FeeSettings {
        let empty = Value::Null;
        let source = value.unwrap_or(&empty);
        FeeSettings {
            personnel_unit_price: number_or(source.get("personnelUnitPrice"), 0.0).round() as i64,
            technical_fee_rate_bp: rate_to_basis_points(number_or(
                source.get("technicalFeeRate"),
                0.0,
            )),
            overhead_multiplier_permille: multiplier_to_permille(number_or(
                source.get("overheadMultiplier"),
                kokuji670::STANDARD_OVERHEAD_MULTIPLIER,
            )),
        }
    }
}

fn fee_row(label: &str, amount: i64, note: &str) -> Value {
    Value::obj([
        ("label", label.into()),
        ("amount", (amount as f64).into()),
        ("amountText", format::format_yen(amount).into()),
        ("note", note.into()),
    ])
}

/// 告示第 670 号の略算方法で、耐震診断・耐震補強設計の報酬（税抜）を出す。
///
/// **出るのは参考額**で、そのまま単価になるわけではない。画面が「単価へ入れる」
/// を押したときに初めて明細へ入り、そのあとは手で直せる。
pub fn seismic_fee(data: &Value) -> Value {
    let work = text(data.get("work"));
    let structure = text(data.get("structure"));
    let floor_area = number_or(data.get("floorArea"), 0.0);
    let inspection_cost = number_or(data.get("inspectionCost"), 0.0).round() as i64;
    let special_cost = number_or(data.get("specialCost"), 0.0).round() as i64;
    let settings = FeeSettings::from_value(data.get("settings"));

    let not_applicable = |reason: String| {
        Value::obj([
            ("applicable", false.into()),
            ("reason", reason.into()),
            ("amount", 0.0.into()),
            ("amountText", "-".into()),
            ("rows", Value::Arr(Vec::new())),
        ])
    };

    // 別表第一（S 造・RC 造・SRC 造）は原文の照合が済むまで実装しない。
    if !structure.is_empty() && structure != "detached-timber-house" {
        return not_applicable(
            "告示第670号 別添二 別表第一（鉄骨造・鉄筋コンクリート造・鉄骨鉄筋コンクリート造）\
             は未実装です。実費を積み上げて単価を入れてください。"
                .to_string(),
        );
    }

    let (hours, work_label) = match kokuji670::detached_timber_house(&work, floor_area) {
        kokuji670::Applicability::Applicable { hours, label } => (hours, label),
        kokuji670::Applicability::OutOfScope(reason) => return not_applicable(reason),
    };

    if settings.personnel_unit_price <= 0 {
        return not_applicable(
            "一人・一時間当たりの人件費が未設定です。画面の「設定」から登録してください\
             （告示に定めが無く、事務所が決める値です）。"
                .to_string(),
        );
    }

    let direct_personnel = hours * settings.personnel_unit_price;
    let overhead = round_to_int(
        direct_personnel * settings.overhead_multiplier_permille,
        1000,
    );
    let technical = round_to_int(direct_personnel * settings.technical_fee_rate_bp, 10_000);
    let amount = direct_personnel + inspection_cost + special_cost + overhead + technical;

    let multiplier = settings.overhead_multiplier_permille as f64 / 1000.0;
    let technical_rate = settings.technical_fee_rate_bp as f64 / 100.0;

    let rows = vec![
        Value::obj([
            ("label", "標準業務人・時間数".into()),
            ("amount", (hours as f64).into()),
            ("amountText", format!("{hours} 人・時間").into()),
            (
                "note",
                format!("告示第670号 別添二 別表第二（{work_label}・戸建木造住宅）").into(),
            ),
        ]),
        fee_row(
            "直接人件費",
            direct_personnel,
            &format!(
                "{hours} 人・時間 × {} 円",
                format::format_yen(settings.personnel_unit_price)
            ),
        ),
        fee_row(
            "検査費",
            inspection_cost,
            "第三者へ委託する検査の費用（第二 ロ）。実費",
        ),
        fee_row("特別経費", special_cost, "建築主の特別の依頼に基づく費用。実費"),
        fee_row(
            "直接経費 + 間接経費",
            overhead,
            &format!(
                "直接人件費 × {}（告示第670号 第四 ロ。標準は 1.0）",
                format::format_dimension(multiplier)
            ),
        ),
        fee_row(
            "技術料等経費",
            technical,
            &format!(
                "直接人件費 × {}%（告示に率の定めは無い。事務所の設定値）",
                format::format_dimension(technical_rate)
            ),
        ),
        fee_row("業務報酬（税抜）", amount, "上の費目の合計"),
    ];

    Value::obj([
        ("applicable", true.into()),
        ("reason", "".into()),
        ("amount", (amount as f64).into()),
        ("amountText", format::format_yen(amount).into()),
        ("rows", Value::Arr(rows)),
    ])
}

// --- 画面が組み立てに使う定義 ------------------------------------------------

/// 業務のテンプレート・選択肢・既定値を配る（フォーム定義の単一の情報源）。
pub fn form_definition() -> Value {
    let templates: Vec<Value> = TEMPLATES
        .iter()
        .map(|found| {
            Value::obj([
                ("id", found.id.into()),
                ("name", found.name.into()),
                ("title", found.title.into()),
                ("composition", found.composition.id().into()),
                ("areaLabel", found.area_label.into()),
                ("seismicWork", found.seismic_work.into()),
            ])
        })
        .collect();

    let options = |values: &[&str]| Value::Arr(values.iter().map(|v| (*v).into()).collect());

    let area_modes: Vec<Value> = [AreaMode::Approximate, AreaMode::AtMost, AreaMode::Exact]
        .iter()
        .map(|mode| Value::obj([("id", mode.id().into()), ("label", mode.label().into())]))
        .collect();

    let tax_categories: Vec<Value> =
        [TaxCategory::Standard, TaxCategory::Reduced, TaxCategory::Exempt]
            .iter()
            .map(|category| {
                Value::obj([
                    ("id", category.id().into()),
                    ("label", category.label().into()),
                ])
            })
            .collect();

    let roundings: Vec<Value> = [Rounding::Floor, Rounding::Round, Rounding::Ceil]
        .iter()
        .map(|rounding| {
            Value::obj([
                ("id", rounding.id().into()),
                ("label", rounding.label().into()),
            ])
        })
        .collect();

    let seismic_works: Vec<Value> = kokuji670::DETACHED_TIMBER_HOUSE
        .iter()
        .map(|(id, label, hours)| {
            Value::obj([
                ("id", (*id).into()),
                ("label", (*label).into()),
                ("hours", (*hours as f64).into()),
            ])
        })
        .collect();

    Value::obj([
        ("templates", Value::Arr(templates)),
        ("scaleOptions", options(&SCALE_OPTIONS)),
        ("methodOptions", options(&METHOD_OPTIONS)),
        ("diagnosisMethodOptions", options(&DIAGNOSIS_METHOD_OPTIONS)),
        ("areaModes", Value::Arr(area_modes)),
        ("taxCategories", Value::Arr(tax_categories)),
        ("roundings", Value::Arr(roundings)),
        ("maxItems", MAX_ITEMS.into()),
        (
            "seismic",
            Value::obj([
                ("works", Value::Arr(seismic_works)),
                ("minArea", kokuji670::DETACHED_TIMBER_HOUSE_MIN_AREA.into()),
                ("maxArea", kokuji670::DETACHED_TIMBER_HOUSE_MAX_AREA.into()),
                (
                    "standardOverheadMultiplier",
                    kokuji670::STANDARD_OVERHEAD_MULTIPLIER.into(),
                ),
            ]),
        ),
        (
            "defaults",
            Value::obj([
                ("taxRate", DEFAULT_TAX_RATE.into()),
                ("reducedTaxRate", DEFAULT_REDUCED_TAX_RATE.into()),
            ]),
        ),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json;

    fn form_from(text: &str) -> Form {
        normalize(&json::parse(text).expect("テストの JSON は妥当")).expect("正規化できる")
    }

    fn totals(form: &Form) -> (i64, i64, i64) {
        let computed = compute(form);
        let totals = computed.get("totals").expect("totals がある");
        (
            totals.get("subtotal").and_then(Value::as_f64).unwrap() as i64,
            totals.get("tax").and_then(Value::as_f64).unwrap() as i64,
            totals.get("total").and_then(Value::as_f64).unwrap() as i64,
        )
    }

    /// 過去の見積書と同じ金額になること（284,000 → 28,400 → 312,400）。
    #[test]
    fn adds_consumption_tax_to_the_subtotal() {
        let form = form_from(
            r#"{"items":[{"title":"構造設計","unitPrice":284000,"quantity":1}]}"#,
        );
        assert_eq!(totals(&form), (284_000, 28_400, 312_400));
    }

    /// 単価は文字列でも読む（画面の入力欄は 3 桁区切りのまま届くことがある）。
    #[test]
    fn reads_amounts_written_the_way_people_type_them() {
        let form = form_from(r#"{"items":[{"title":"x","unitPrice":"1,035,000"}]}"#);
        assert_eq!(totals(&form), (1_035_000, 103_500, 1_138_500));
    }

    /// 数量は小数でよく、金額は最後に 1 度だけ丸める。
    #[test]
    fn multiplies_by_a_fractional_quantity() {
        let form = form_from(r#"{"items":[{"title":"x","unitPrice":10001,"quantity":0.5}]}"#);
        assert_eq!(totals(&form).0, 5001); // 5000.5 → 5001
    }

    /// 税率の区分ごとに 1 度だけ税額を出す（行ごとに丸めて足さない）。
    #[test]
    fn rounds_the_tax_once_per_rate() {
        let form = form_from(
            r#"{"items":[
                 {"title":"a","unitPrice":105},
                 {"title":"b","unitPrice":105}
               ]}"#,
        );
        // 行ごとに切り捨てると 10 + 10 = 20 になるが、正しくは 210 × 10% = 21。
        assert_eq!(totals(&form), (210, 21, 231));
    }

    /// 対象外（立替金）には税を掛けない。
    #[test]
    fn keeps_exempt_lines_out_of_the_tax_base() {
        let form = form_from(
            r#"{"items":[
                 {"title":"報酬","unitPrice":100000},
                 {"title":"立替金","unitPrice":30000,"taxCategory":"exempt"}
               ]}"#,
        );
        assert_eq!(totals(&form), (130_000, 10_000, 140_000));
    }

    /// 端数の寄せ方は見積書が持つ（設定を変えても過去の書面は変わらない）。
    #[test]
    fn honours_the_rounding_stored_on_the_quotation() {
        let ceil = form_from(
            r#"{"tax":{"taxRounding":"ceil"},"items":[{"title":"x","unitPrice":105}]}"#,
        );
        assert_eq!(totals(&ceil).1, 11);
        let floor = form_from(r#"{"items":[{"title":"x","unitPrice":105}]}"#);
        assert_eq!(totals(&floor).1, 10);
    }

    #[test]
    fn composes_the_body_of_a_design_item() {
        let item = Item::from_value(
            &json::parse(
                r#"{"templateId":"structural-design",
                    "spec":{"scale":"2階建て","floorArea":238,"areaMode":"approx",
                            "method":"仕様規定(壁量計算)","note":"提出図面は、基礎伏図程度とします。"}}"#,
            )
            .unwrap(),
        );
        assert_eq!(
            suggested_title(&item),
            "新築木造軸組建築物の構造計算及び構造図作成"
        );
        assert_eq!(
            suggested_body(&item, "監理業務は含みません。"),
            "2階建て、構造床面積約238㎡\n\
             仕様規定(壁量計算)による設計とします。\n\
             提出図面は、基礎伏図程度とします。\n\
             監理業務は含みません。"
        );
    }

    #[test]
    fn composes_the_body_of_a_seismic_item() {
        let diagnosis = Item::from_value(
            &json::parse(
                r#"{"templateId":"seismic-diagnosis",
                    "spec":{"scale":"2階建て","floorArea":120,"diagnosisMethod":"一般診断法"}}"#,
            )
            .unwrap(),
        );
        assert_eq!(suggested_title(&diagnosis), "木造住宅の耐震診断");
        assert_eq!(
            suggested_body(&diagnosis, ""),
            "2階建て、延べ面積約120㎡\n一般診断法により耐震診断を行います。"
        );

        let retrofit = Item::from_value(
            &json::parse(
                r#"{"templateId":"seismic-retrofit-design",
                    "spec":{"floorArea":120,"diagnosisMethod":"一般診断法"}}"#,
            )
            .unwrap(),
        );
        assert_eq!(suggested_title(&retrofit), "木造住宅の耐震補強設計");
        assert_eq!(
            suggested_body(&retrofit, ""),
            "延べ面積約120㎡\n一般診断法による耐震診断の結果に基づき、耐震補強設計を行います。"
        );
    }

    /// 自由記述のテンプレートには、共通の但し書きを足さない。
    #[test]
    fn leaves_free_form_items_alone() {
        let item = Item::from_value(
            &json::parse(r#"{"templateId":"design-change","spec":{"note":"再提出"}}"#).unwrap(),
        );
        assert_eq!(suggested_title(&item), "変更設計料");
        assert_eq!(suggested_body(&item, "監理業務は含みません。"), "再提出");
    }

    /// 但し書きは業務の系統ごとに選ぶ（設計の文が耐震診断に付かない）。
    #[test]
    fn picks_the_terms_that_match_the_kind_of_work() {
        let terms =
            json::parse(r#"{"design":"設計の但し書き","seismic":"耐震の但し書き"}"#).unwrap();
        let design =
            Item::from_value(&json::parse(r#"{"templateId":"structural-design"}"#).unwrap());
        let seismic =
            Item::from_value(&json::parse(r#"{"templateId":"seismic-diagnosis"}"#).unwrap());
        assert_eq!(terms_for(&terms, &design), "設計の但し書き");
        assert_eq!(terms_for(&terms, &seismic), "耐震の但し書き");

        // 1 つの文字列で渡されたときは、どの明細にも同じものを足す。
        let single = json::parse(r#""共通の但し書き""#).unwrap();
        assert_eq!(terms_for(&single, &design), "共通の但し書き");
        assert_eq!(terms_for(&Value::Null, &design), "");
    }

    #[test]
    fn suggests_the_end_of_the_following_month_as_the_expiry() {
        assert_eq!(suggested_expiry("2025-09-17"), "2025-10-31");
        assert_eq!(suggested_expiry("2025-12-25"), "2026-01-31");
        assert_eq!(suggested_expiry("2026-01-14"), "2026-02-28");
        assert_eq!(suggested_expiry("2024-01-14"), "2024-02-29"); // 閏年
        assert_eq!(suggested_expiry(""), "");
    }

    /// 電帳法の検索要件に備えた既定のファイル名（§7.2）。
    #[test]
    fn builds_the_default_file_name_from_date_client_and_amount() {
        let form = form_from(
            r#"{"issuedOn":"2026-08-17","client":{"name":"架空建築設計"},
                "items":[{"title":"x","unitPrice":284000}]}"#,
        );
        let computed = compute(&form);
        assert_eq!(
            computed.get("defaultFileName").and_then(Value::as_str),
            Some("20260817_架空建築設計_312400.pdf")
        );
    }

    #[test]
    fn refuses_to_build_a_document_that_is_not_a_quotation() {
        let missing_number = form_from(r#"{"items":[{"title":"x"}]}"#);
        assert!(validate(&missing_number).is_err());

        let complete = form_from(
            r#"{"number":"20260099","issuedOn":"2026-08-17",
                "client":{"name":"架空建築設計"},"issuer":{"name":"架空設計事務所"},
                "items":[{"title":"構造設計","unitPrice":100000}]}"#,
        );
        assert!(validate(&complete).is_ok());
    }

    #[test]
    fn keeps_the_form_stable_through_a_round_trip() {
        let form = form_from(
            r#"{"number":"20260099","issuedOn":"2026-08-17","subject":"件名",
                "client":{"name":"架空建築設計","honorific":"御中"},
                "issuer":{"name":"架空設計事務所"},
                "items":[{"templateId":"seismic-diagnosis","title":"耐震診断",
                          "unitPrice":250000,"quantity":1,
                          "spec":{"floorArea":120,"diagnosisMethod":"一般診断法"}}]}"#,
        );
        let again = normalize(&form.to_value()).expect("書き出したものを読み戻せる");
        assert_eq!(form, again);
    }

    // --- 告示第670号による参考額 --------------------------------------------

    fn fee(request: &str) -> Value {
        seismic_fee(&json::parse(request).expect("テストの JSON は妥当"))
    }

    /// 45 人・時間 × 8,000 円 = 360,000 円。倍数 1.0 と技術料 10% を載せる。
    /// 単価と率は架空の値（事務所の実際の設定値ではない）。
    #[test]
    fn estimates_a_diagnosis_from_the_notification() {
        let result = fee(
            r#"{"work":"diagnosis","structure":"detached-timber-house","floorArea":120,
                "settings":{"personnelUnitPrice":8000,"technicalFeeRate":10,
                            "overheadMultiplier":1.0}}"#,
        );
        assert_eq!(result.get("applicable"), Some(&Value::Bool(true)));
        // 360,000（直接人件費）+ 360,000（直接経費+間接経費）+ 36,000（技術料）
        assert_eq!(
            result.get("amount").and_then(Value::as_f64),
            Some(756_000.0)
        );
    }

    /// 耐震改修に係る設計は 60 人・時間。検査費と特別経費は実費で足す。
    #[test]
    fn estimates_a_retrofit_design_with_actual_costs() {
        let result = fee(
            r#"{"work":"retrofit-design","structure":"detached-timber-house","floorArea":120,
                "inspectionCost":50000,"specialCost":20000,
                "settings":{"personnelUnitPrice":8000,"technicalFeeRate":0,
                            "overheadMultiplier":1.0}}"#,
        );
        // 480,000 + 50,000 + 20,000 + 480,000
        assert_eq!(
            result.get("amount").and_then(Value::as_f64),
            Some(1_030_000.0)
        );
    }

    #[test]
    fn refuses_to_estimate_outside_the_notification() {
        let out_of_range = fee(
            r#"{"work":"diagnosis","structure":"detached-timber-house","floorArea":300,
                "settings":{"personnelUnitPrice":8000}}"#,
        );
        assert_eq!(out_of_range.get("applicable"), Some(&Value::Bool(false)));

        let non_timber = fee(
            r#"{"work":"diagnosis","structure":"steel","floorArea":120,
                "settings":{"personnelUnitPrice":8000}}"#,
        );
        assert_eq!(non_timber.get("applicable"), Some(&Value::Bool(false)));

        // 人件費単価は事務所の設定値。無ければ算定しない（0 円で出さない）。
        let no_unit_price =
            fee(r#"{"work":"diagnosis","structure":"detached-timber-house","floorArea":120}"#);
        assert_eq!(no_unit_price.get("applicable"), Some(&Value::Bool(false)));
    }

    #[test]
    fn publishes_the_form_definition_from_one_place() {
        let definition = form_definition();
        let templates = definition
            .get("templates")
            .and_then(Value::as_array)
            .expect("テンプレートの一覧がある");
        assert_eq!(templates.len(), TEMPLATES.len());
        let ids: Vec<&str> = templates
            .iter()
            .filter_map(|t| t.get("id").and_then(Value::as_str))
            .collect();
        assert!(ids.contains(&"seismic-diagnosis"));
        assert!(ids.contains(&"seismic-retrofit-design"));
    }
}
