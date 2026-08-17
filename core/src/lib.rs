//! ポータルの計算の**唯一の実装**（面材張り大壁と、小規模木造建築物の必要壁量）。
//!
//! この crate をビルドした 1 つの .wasm を、画面（ブラウザ）とサーバ
//! （Cloud Run の FastAPI）の両方が読み込んで動かす。同じバイト列を同じ
//! 引数で呼ぶので、編集中に画面が出す数値と、保存時にサーバが計算書 PDF へ
//! 刷る数値は本来ぴったり一致する（それでも保存時に突き合わせて、食い違えば
//! 警告を出す。README「計算の一元管理（Rust → wasm）」参照）。
//!
//! 呼び出し口は 1 つだけで、JSON の要求を渡すと JSON の応答が返る:
//!
//! ```text
//! 面材張り大壁（グレー本 3.2・3.3）
//! {"op": "computeAll", "data": {...}}  → {"ok": true,  "walls": [...]}
//! {"op": "validate",   "data": {...}}  → {"ok": true,  "walls": [...]}
//! {"op": "normalize",  "data": {...}}  → {"ok": true,  "data": {...}}
//! {"op": "presets"}                    → {"ok": true,  "presets": [...]}
//! {"op": "preset",     "data": {...}}  → {"ok": true,  "preset": {...}, "wall": {...}, "panel": {...}}
//! {"op": "materials"}                  → {"ok": true,  "materials": [...]}
//! {"op": "grades"}                     → {"ok": true,  "grades": [...]}
//!
//! 必要壁量（表計算ツールの数式）
//! {"op": "wallQuantity",       "data": {...}} → {"ok": true, "result": {...}}
//! {"op": "wallQuantityInputs", "data": {...}} → {"ok": true, "inputKeys": [...], ...}
//!
//! 見積書（明細の金額・消費税・合計、摘要の組み立て、告示第670号の参考額）
//! {"op": "quotation",         "data": {...}} → {"ok": true, "items": [...], "totals": {...}, ...}
//! {"op": "quotationNormalize","data": {...}} → {"ok": true, "data": {...}}
//! {"op": "quotationValidate", "data": {...}} → {"ok": true, "data": {...}}
//! {"op": "quotationSuggest",  "data": {...}} → {"ok": true, "suggestions": [...]}
//! {"op": "quotationForm"}                    → {"ok": true, "templates": [...], ...}
//! {"op": "seismicFee",        "data": {...}} → {"ok": true, "applicable": true, "rows": [...]}
//!
//! {"op": "config"}                     → {"ok": true,  "version": "1.0.0", ...}
//! 失敗                                  → {"ok": false, "error": "利用者に見せる日本語"}
//! ```
//!
//! 釘配列諸定数（3.2）は壁の計算（3.3）の一部なので、壁ごとの応答の中に
//! 面材 1 枚ずつの結果（`panelReports`）として入る。
//!
//! wasm としての受け渡し（線形メモリの確保・解放）は abi.rs にある。

pub mod abi;
pub mod column_strength;
pub mod format;
pub mod json;
pub mod kokuji670;
pub mod layout;
pub mod nail_array;
pub mod presets;
pub mod quotation;
pub mod report;
pub mod wall;
pub mod wall_layout;
pub mod wall_quantity;

use json::Value;

/// この計算実装の版。画面とサーバで食い違っていないかを保存時に確かめる
/// （画面が古いまま開きっぱなしのタブ、といった食い違いを拾うため）。
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// JSON の要求を処理して、JSON の応答を返す。
///
/// 応答は必ず `ok` を持つ。エラーは Result ではなく応答に載せる
/// （wasm の呼び出し側が、成功と失敗を同じ 1 回の呼び出しで受け取れる）。
pub fn call(request: &str) -> String {
    match dispatch(request) {
        Ok(Value::Obj(mut entries)) => {
            entries.insert(0, ("ok".to_string(), true.into()));
            Value::Obj(entries).to_json()
        }
        Ok(value) => value.to_json(),
        Err(error) => Value::obj([("ok", false.into()), ("error", error.into())]).to_json(),
    }
}

fn dispatch(request: &str) -> Result<Value, String> {
    let request = json::parse(request)?;
    let operation = request
        .get("op")
        .and_then(Value::as_str)
        .ok_or_else(|| "要求に op がありません。".to_string())?;
    let data = || request.get("data").unwrap_or(&Value::Null);

    match operation {
        "computeAll" => {
            let form = report::normalize_data(data())?;
            Ok(Value::obj([("walls", report::compute_all_walls(&form))]))
        }
        "validate" => {
            let form = report::normalize_data(data())?;
            Ok(Value::obj([(
                "walls",
                Value::Arr(report::validate_walls(&form)?),
            )]))
        }
        "normalize" => {
            let form = report::normalize_data(data())?;
            Ok(Value::obj([("data", form.to_value())]))
        }
        // グレー本 表 3.2.1 の標準的な組み合わせ（面材寸法・間柱ピッチ・
        // 釘ピッチ）。配列の型は面材が壁のどこに来るかで決まるので、選択肢に
        // 並べるのは型を除いた 33 通り。
        "presets" => Ok(Value::obj([(
            "presets",
            Value::Arr(
                presets::catalogue()
                    .iter()
                    .map(presets::Preset::to_value)
                    .collect(),
            ),
        )])),
        // 選ばれた 1 つを、壁と面材それぞれへ入る値に組み立てる。
        "preset" => {
            let id = data()
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| "呼び出す釘配列の id がありません。".to_string())?;
            let preset = presets::find(id).ok_or_else(|| format!("知らない釘配列です: {id}"))?;
            Ok(Value::obj([
                ("preset", preset.to_value()),
                ("wall", preset.to_wall_value()),
                ("panel", preset.to_panel_value()),
            ]))
        }
        // グレー本 表 3.3.1「面材釘 1 本あたりの一面せん断の数値」。壁の計算の
        // 入力欄へ読み込んだあと、手で直せるようにするための一覧。
        "materials" => Ok(Value::obj([(
            "materials",
            Value::Arr(
                wall::materials()
                    .iter()
                    .map(|material| {
                        // 表 3.3.2 の既定の規格も一緒に配って、1 回の選択で
                        // せん断破壊・せん断座屈の検定まで数値がそろうようにする。
                        let sheathing = material.sheathing();
                        Value::obj([
                            ("id", material.id.into()),
                            ("label", material.label().into()),
                            ("panel", material.panel.into()),
                            ("nailLabel", material.nail_label.into()),
                            // 釘の呼び径（JIS A 5508）と、そこから決まる
                            // 面材のへりあきの最小値（適用範囲 3.3(1)④）。
                            ("nailDiameter", material.nail_diameter.into()),
                            ("minEdgeDistance", material.min_edge_distance().into()),
                            ("thickness", material.thickness.into()),
                            ("shearModulus", material.shear_modulus.into()),
                            ("k", material.nail.k.into()),
                            ("deltaV", material.nail.delta_v.into()),
                            ("deltaU", material.nail.delta_u.into()),
                            ("deltaPv", material.nail.delta_pv.into()),
                            ("gradeId", material.grade_id.into()),
                            ("tauMax", sheathing.tau_max.into()),
                            ("e1", sheathing.e1.into()),
                            ("e2", sheathing.e2.into()),
                        ])
                    })
                    .collect(),
            ),
        )])),
        // グレー本 表 3.3.2「面材のせん断強度及び曲げヤング係数」。
        // JAS 2 級の合板を使うときなど、規格だけを差し替えるための一覧。
        "grades" => Ok(Value::obj([(
            "grades",
            Value::Arr(
                wall::grades()
                    .iter()
                    .map(|grade| {
                        Value::obj([
                            ("id", grade.id.into()),
                            ("label", grade.label().into()),
                            ("panel", grade.panel.into()),
                            ("grade", grade.grade.into()),
                            ("tauMax", grade.tau_max.into()),
                            ("e1", grade.e1.into()),
                            ("e2", grade.e2.into()),
                        ])
                    })
                    .collect(),
            ),
        )])),
        // 小規模木造建築物の必要壁量（表計算ツールの数式）。入力が足りない
        // ところは配布物と同じく空欄で返るので、編集中もそのまま呼べる。
        "wallQuantity" => Ok(Value::obj([("result", wall_quantity::compute(data())?)])),
        // 計算が読む入力欄の key。マッピング（書き込み先のセル）とずれて
        // いないかを、backend のテストが突き合わせるのに使う。
        "wallQuantityInputs" => {
            let building = wall_quantity::Building::from_key(
                data().get("building").and_then(Value::as_str).unwrap_or(""),
            )?;
            Ok(Value::obj([
                (
                    "inputKeys",
                    Value::Arr(
                        wall_quantity::input_keys(building)
                            .into_iter()
                            .map(Value::Str)
                            .collect(),
                    ),
                ),
                (
                    "toggleKeys",
                    Value::Arr(
                        wall_quantity::toggle_keys()
                            .iter()
                            .map(|key| (*key).into())
                            .collect(),
                    ),
                ),
                (
                    "columnStrengths",
                    Value::Arr(
                        column_strength::TABLE
                            .iter()
                            .map(|(jas, species, grade, strength)| {
                                Value::obj([
                                    ("jas", (*jas).into()),
                                    ("species", (*species).into()),
                                    ("grade", (*grade).into()),
                                    ("strength", (*strength).into()),
                                ])
                            })
                            .collect(),
                    ),
                ),
            ]))
        }
        // 見積書（明細の金額・消費税・合計と、業務ごとの摘要の組み立て）。
        // 画面が入力のたびに出す金額と、PDF に刷られる金額を同じ実装から出す。
        "quotation" => {
            let form = quotation::normalize(data())?;
            Ok(quotation::compute(&form))
        }
        "quotationNormalize" => {
            let form = quotation::normalize(data())?;
            Ok(Value::obj([("data", form.to_value())]))
        }
        // 保存できる状態かを確かめる（欠けていれば PDF を作らせない）。
        "quotationValidate" => {
            let form = quotation::normalize(data())?;
            quotation::validate(&form)?;
            Ok(Value::obj([("data", form.to_value())]))
        }
        // 品名と摘要の候補。入力を動かすたびに組み立て直す。
        "quotationSuggest" => {
            let form = quotation::normalize(data())?;
            // 但し書きは業務の系統（設計／耐震）ごとに違う。設定がそのまま
            // { "design": "…", "seismic": "…" } の形で渡ってくる。
            let empty = Value::Null;
            let terms = data().get("terms").unwrap_or(&empty);
            Ok(Value::obj([(
                "suggestions",
                Value::Arr(
                    form.items
                        .iter()
                        .map(|item| {
                            Value::obj([
                                ("title", quotation::suggested_title(item).into()),
                                (
                                    "body",
                                    quotation::suggested_body(
                                        item,
                                        quotation::terms_for(terms, item),
                                    )
                                    .into(),
                                ),
                            ])
                        })
                        .collect(),
                ),
            )]))
        }
        // 業務のテンプレートと選択肢（画面の入力欄の単一の情報源）。
        "quotationForm" => Ok(quotation::form_definition()),
        // 平成27年国土交通省告示第670号による、耐震診断・耐震補強設計の参考額。
        "seismicFee" => Ok(quotation::seismic_fee(data())),
        "config" => Ok(Value::obj([
            ("version", VERSION.into()),
            ("maxNails", report::MAX_NAILS.into()),
            ("maxWalls", report::MAX_WALLS.into()),
            ("maxWallPanels", report::MAX_WALL_PANELS.into()),
            ("defaultEdgeDistance", layout::DEFAULT_EDGE_DISTANCE.into()),
            ("defaultStudPitch", report::DEFAULT_STUD_PITCH.into()),
            ("minEdgeDistance", wall::MIN_EDGE_DISTANCE.into()),
            ("allowableShearLimit", wall::ALLOWABLE_SHEAR_LIMIT.into()),
            ("significantDigits", format::SIGNIFICANT_DIGITS.into()),
        ])),
        other => Err(format!("知らない操作です: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call_json(request: &str) -> Value {
        json::parse(&call(request)).unwrap()
    }

    /// 壁 1 枚につき 1 つの結果が返り、その中に面材ごとの釘配列諸定数が入る。
    #[test]
    fn compute_all_returns_one_entry_per_wall() {
        let response = call_json(
            r#"{"op": "computeAll", "data": {"walls": [
                   {"wallId": "w1", "height": 3000, "width": 910, "studPitch": 455,
                    "panels": [{"left": 0, "bottom": 0, "right": 910, "top": 610,
                                "nailPitch": 150,
                                "thickness": 12, "shearModulus": 0.4, "k": 0.483,
                                "deltaV": 2.3, "deltaU": 17, "deltaPv": 1.13,
                                "tauMax": 3.6, "e1": 3500, "e2": 5500}]},
                   {"wallId": "w2", "height": 3000, "width": 910, "studPitch": 455,
                    "panels": []}
                 ]}}"#,
        );

        assert_eq!(response.get("ok"), Some(&Value::Bool(true)));
        let walls = response.get("walls").unwrap().as_array().unwrap();
        assert_eq!(walls.len(), 2);
        assert_eq!(walls[0].get("ok"), Some(&Value::Bool(true)));
        assert!(walls[0].get("result").unwrap().get("Pa").is_some());
        let panels = walls[0].get("panelReports").unwrap().as_array().unwrap();
        assert_eq!(panels.len(), 1);
        assert!(panels[0].get("result").unwrap().get("Ixy").is_some());
        // 面材を置いていない壁だけが ok: false（他の壁の結果は失わない）。
        assert_eq!(walls[1].get("ok"), Some(&Value::Bool(false)));
    }

    /// 空のフォームでも壁が 1 枚ある状態から編集を始められる。
    #[test]
    fn compute_all_gives_an_empty_form_one_wall() {
        let response = call_json(r#"{"op": "computeAll", "data": {}}"#);
        let walls = response.get("walls").unwrap().as_array().unwrap();
        assert_eq!(walls.len(), 1);
        assert_eq!(walls[0].get("ok"), Some(&Value::Bool(false)));
    }

    #[test]
    fn materials_list_the_combinations_of_the_book_table() {
        let response = call_json(r#"{"op": "materials"}"#);

        let materials = response.get("materials").unwrap().as_array().unwrap();
        assert_eq!(materials.len(), 12);
        assert_eq!(
            materials[0].get("id").unwrap().as_str(),
            Some("plywood12-n50")
        );
        assert_eq!(
            materials[0].get("shearModulus").unwrap().as_f64(),
            Some(0.40)
        );
        assert_eq!(materials[0].get("deltaPv").unwrap().as_f64(), Some(0.91));
        // へりあきを決めるための釘の呼び径と、その 5 倍（3.3(1)④）も配る。
        assert_eq!(
            materials[0].get("nailDiameter").unwrap().as_f64(),
            Some(2.75)
        );
        assert_eq!(
            materials[0].get("minEdgeDistance").unwrap().as_f64(),
            Some(13.75)
        );
    }

    #[test]
    fn validate_refuses_a_wall_that_cannot_be_calculated() {
        let response = call_json(
            r#"{"op": "validate", "data": {
                 "walls": [{"wallName": "南面", "height": 3000, "width": 910,
                            "panels": []}]}}"#,
        );

        assert_eq!(response.get("ok"), Some(&Value::Bool(false)));
        assert!(response
            .get("error")
            .unwrap()
            .as_str()
            .unwrap()
            .contains("「南面」を計算できません"));
    }

    #[test]
    fn validate_refuses_a_panel_that_cannot_be_calculated() {
        let response = call_json(
            r#"{"op": "validate", "data": {"walls": [
                 {"wallName": "南面", "height": 3000, "width": 910,
                  "panels": [{"panelName": "下段", "width": 910, "height": 610,
                              "thickness": 12, "shearModulus": 0.4, "k": 0.483,
                              "deltaV": 2.3, "deltaU": 17, "deltaPv": 1.13,
                              "tauMax": 3.6, "e1": 3500, "e2": 5500}]}]}}"#,
        );

        assert_eq!(response.get("ok"), Some(&Value::Bool(false)));
        let error = response.get("error").unwrap().as_str().unwrap();
        assert!(error.contains("「南面」を計算できません"), "{error}");
        assert!(error.contains("面材「下段」"), "{error}");
    }

    #[test]
    fn normalize_drops_unknown_keys_and_fills_in_defaults() {
        let response = call_json(r#"{"op": "normalize", "data": {"junk": 1}}"#);

        let data = response.get("data").unwrap();
        assert_eq!(data.get("projectName").unwrap().as_str(), Some(""));
        assert_eq!(data.get("junk"), None);
        assert_eq!(data.get("walls").unwrap().as_array().unwrap().len(), 1);
    }

    /// 一覧は、型を除いた 33 通り（配列の型は面材の位置で決まる）。
    #[test]
    fn presets_list_the_standard_combinations_of_the_book_table() {
        let response = call_json(r#"{"op": "presets"}"#);

        let presets = response.get("presets").unwrap().as_array().unwrap();
        assert_eq!(presets.len(), 33);
        assert_eq!(
            presets[0].get("id").unwrap().as_str(),
            Some("910x3030-s455-n150-hi")
        );
        assert_eq!(
            presets[0].get("label").unwrap().as_str(),
            Some("3030×910 縦置（間柱・根太 @455 / 釘 @150）")
        );
        // 一覧は選ぶための情報だけ（釘座標は "preset" で組み立てる）。
        assert_eq!(presets[0].get("coords"), None);
    }

    /// 呼び出した組み合わせは、壁（間柱ピッチ）と面材（釘ピッチ・大きさ）へ
    /// 分かれて入る。
    #[test]
    fn preset_loads_into_the_wall_and_the_panel() {
        let response = call_json(r#"{"op": "preset", "data": {"id": "910x610-s455-n150-hi"}}"#);

        assert_eq!(
            response.get("wall").unwrap().get("studPitch").unwrap().as_f64(),
            Some(455.0)
        );
        let panel = response.get("panel").unwrap();
        assert_eq!(panel.get("width").unwrap().as_f64(), Some(910.0));
        assert_eq!(panel.get("height").unwrap().as_f64(), Some(610.0));
        assert_eq!(panel.get("nailPitch").unwrap().as_f64(), Some(150.0));
        assert_eq!(panel.get("edgeDistance").unwrap().as_f64(), Some(10.0));
        assert_eq!(
            response
                .get("preset")
                .unwrap()
                .get("nailCount")
                .unwrap()
                .as_f64(),
            Some(23.0)
        );
    }

    #[test]
    fn an_unknown_preset_is_an_error_not_a_panic() {
        for request in [
            r#"{"op": "preset"}"#,
            r#"{"op": "preset", "data": {"id": "なにか"}}"#,
        ] {
            let response = call_json(request);
            assert_eq!(response.get("ok"), Some(&Value::Bool(false)));
        }
    }

    /// 必要壁量は、入力が足りなくても「空欄の出力結果」を返す
    /// （配布物と同じで、編集の途中でもそのまま画面に出せる）。
    #[test]
    fn wall_quantity_returns_the_output_of_the_worksheet() {
        let response = call_json(
            r#"{"op": "wallQuantity", "data": {
                 "building": "one_story", "usage": "standard",
                 "toggles": {},
                 "values": {"height_1f": "3", "ridge_minus_eaves": "0.5",
                            "base_shear": "0.2", "floor_area_1f": "60",
                            "eaves": "0.5", "roof_pitch": "4",
                            "roof_spec": "スレート屋根", "wall_spec": "サイディング",
                            "solar": "なし(0)",
                            "ceiling_insulation": "100\n（初期値・天井）",
                            "wall_insulation": "70（初期値）"}}}"#,
        );

        assert_eq!(response.get("ok"), Some(&Value::Bool(true)));
        let sections = response
            .get("result")
            .unwrap()
            .get("sections")
            .unwrap()
            .as_array()
            .unwrap();
        // 1. 必要壁量 と 2-1 / 2-2 / 2-3。
        assert_eq!(sections.len(), 4);
        let cell = &sections[0].get("tables").unwrap().as_array().unwrap()[0]
            .get("rows")
            .unwrap()
            .as_array()
            .unwrap()[0]
            .get("cells")
            .unwrap()
            .as_array()
            .unwrap()[0];
        assert_eq!(cell.get("key").unwrap().as_str(), Some("lw.1f.grade1"));
        assert_eq!(cell.get("value").unwrap().as_f64(), Some(17.0));
    }

    /// 入力欄の key と圧縮基準強度の表は、マッピング・配布物との
    /// 突き合わせのために配る。
    #[test]
    fn wall_quantity_inputs_list_the_keys_and_the_strength_table() {
        let response =
            call_json(r#"{"op": "wallQuantityInputs", "data": {"building": "two_story"}}"#);

        let keys = response.get("inputKeys").unwrap().as_array().unwrap();
        assert!(keys.contains(&Value::Str("height_2f".to_string())));
        assert_eq!(
            response.get("toggleKeys").unwrap().as_array().unwrap().len(),
            3
        );
        let table = response.get("columnStrengths").unwrap().as_array().unwrap();
        assert_eq!(table.len(), column_strength::TABLE.len());
        assert_eq!(table[0].get("strength").unwrap().as_f64(), Some(9.6));
    }

    #[test]
    fn config_carries_the_version_and_the_limits() {
        let response = call_json(r#"{"op": "config"}"#);

        assert_eq!(response.get("version").unwrap().as_str(), Some(VERSION));
        assert_eq!(response.get("maxWalls").unwrap().as_f64(), Some(50.0));
        assert_eq!(
            response.get("defaultEdgeDistance").unwrap().as_f64(),
            Some(10.0)
        );
    }

    #[test]
    fn broken_requests_come_back_as_an_error_not_a_panic() {
        for request in [
            "",
            "{}",
            r#"{"op": "なにか"}"#,
            r#"{"op": "computeAll", "data": 1}"#,
        ] {
            let response = call_json(request);
            assert_eq!(
                response.get("ok"),
                Some(&Value::Bool(false)),
                "{request} should fail"
            );
            assert!(response.get("error").unwrap().as_str().is_some());
        }
    }
}
