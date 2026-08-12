//! 面材張り耐力要素 釘配列諸定数の**唯一の計算実装**。
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
//! {"op": "computeAll", "data": {...}}  → {"ok": true,  "walls": [...]}
//! {"op": "validate",   "data": {...}}  → {"ok": true,  "walls": [...]}
//! {"op": "normalize",  "data": {...}}  → {"ok": true,  "data": {...}}
//! {"op": "presets"}                    → {"ok": true,  "presets": [...]}
//! {"op": "preset",     "data": {...}}  → {"ok": true,  "preset": {...}, "panel": {...}}
//! {"op": "materials"}                  → {"ok": true,  "materials": [...]}
//! {"op": "grades"}                     → {"ok": true,  "grades": [...]}
//! {"op": "config"}                     → {"ok": true,  "version": "1.0.0", ...}
//! 失敗                                  → {"ok": false, "error": "利用者に見せる日本語"}
//! ```
//!
//! 釘配列諸定数（3.2）は壁の計算（3.3）の一部なので、壁ごとの応答の中に
//! 面材 1 枚ずつの結果（`panelReports`）として入る。
//!
//! wasm としての受け渡し（線形メモリの確保・解放）は abi.rs にある。

pub mod abi;
pub mod format;
pub mod json;
pub mod layout;
pub mod nail_array;
pub mod presets;
pub mod report;
pub mod wall;

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
        // グレー本 表 3.2.1 の標準的な配列。一覧には釘座標を載せず
        // （106 通りある）、選ばれた 1 つだけを "preset" で組み立てる。
        "presets" => Ok(Value::obj([(
            "presets",
            Value::Arr(
                presets::all()
                    .iter()
                    .map(presets::Preset::to_value)
                    .collect(),
            ),
        )])),
        "preset" => {
            let id = data()
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| "呼び出す釘配列の id がありません。".to_string())?;
            let preset = presets::find(id).ok_or_else(|| format!("知らない釘配列です: {id}"))?;
            Ok(Value::obj([
                ("preset", preset.to_value()),
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
                            // 釘の呼び径（JIS A 5508）。計算には使わないが、
                            // 面材ごとのへりあきを決めるときの手がかりになる。
                            ("nailDiameter", material.nail_diameter.into()),
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
        // 割り付けの型（川型・山型・ロ型・日型）。画面の選択肢になる。
        "arrangements" => Ok(Value::obj([("arrangements", report::arrangements())])),
        "config" => Ok(Value::obj([
            ("version", VERSION.into()),
            ("maxNails", report::MAX_NAILS.into()),
            ("maxWalls", report::MAX_WALLS.into()),
            ("maxWallPanels", report::MAX_WALL_PANELS.into()),
            ("defaultEdgeDistance", layout::DEFAULT_EDGE_DISTANCE.into()),
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
                   {"wallId": "w1", "height": 3000, "width": 910, "thickness": 12,
                    "shearModulus": 0.4, "k": 0.483, "deltaV": 2.3, "deltaU": 17,
                    "deltaPv": 1.13, "tauMax": 3.6, "e1": 3500, "e2": 5500,
                    "hasIntermediateStud": true,
                    "panels": [{"width": 910, "height": 610, "mode": "grid",
                                "gridX": "10, 455, 900",
                                "gridY": "10, 155, 305, 455, 600"}]},
                   {"wallId": "w2", "height": 3000, "width": 910, "thickness": 12,
                    "shearModulus": 0.4, "k": 0.483, "deltaV": 2.3, "deltaU": 17,
                    "deltaPv": 1.13, "tauMax": 3.6, "e1": 3500, "e2": 5500,
                    "hasIntermediateStud": true, "panels": []}
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
        assert_eq!(materials[0].get("id").unwrap().as_str(), Some("plywood12-n50"));
        assert_eq!(materials[0].get("shearModulus").unwrap().as_f64(), Some(0.40));
        assert_eq!(materials[0].get("deltaPv").unwrap().as_f64(), Some(0.91));
        // へりあきを決めるための釘の呼び径も一緒に配る。
        assert_eq!(materials[0].get("nailDiameter").unwrap().as_f64(), Some(2.75));
    }

    #[test]
    fn validate_refuses_a_wall_that_cannot_be_calculated() {
        let response = call_json(
            r#"{"op": "validate", "data": {
                 "walls": [{"wallName": "南面", "height": 3000, "width": 910,
                            "thickness": 12, "shearModulus": 0.4, "k": 0.483,
                            "deltaV": 2.3, "deltaU": 17, "deltaPv": 1.13,
                            "tauMax": 3.6, "e1": 3500, "e2": 5500,
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
                 {"wallName": "南面", "height": 3000, "width": 910, "thickness": 12,
                  "shearModulus": 0.4, "k": 0.483, "deltaV": 2.3, "deltaU": 17,
                  "deltaPv": 1.13, "tauMax": 3.6, "e1": 3500, "e2": 5500,
                  "panels": [{"panelName": "下段", "width": 910, "height": 610}]}]}}"#,
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

    #[test]
    fn presets_list_the_arrangements_of_the_book_table() {
        let response = call_json(r#"{"op": "presets"}"#);

        let presets = response.get("presets").unwrap().as_array().unwrap();
        assert_eq!(presets.len(), 106);
        assert_eq!(
            presets[0].get("id").unwrap().as_str(),
            Some("910x3030-s455-n150-kawa")
        );
        // 一覧は選ぶための情報だけ（釘座標は "preset" で組み立てる）。
        assert_eq!(presets[0].get("coords"), None);
    }

    /// 呼び出した配列は、面材 1 枚の割り付けの欄（寸法・型・ピッチ・
    /// へりあき）へそのまま入る。
    #[test]
    fn preset_builds_a_panel_that_can_be_calculated() {
        let response = call_json(r#"{"op": "preset", "data": {"id": "910x610-s455-n150-kawa"}}"#);

        let panel = response.get("panel").unwrap();
        assert_eq!(panel.get("width").unwrap().as_f64(), Some(910.0));
        assert_eq!(panel.get("height").unwrap().as_f64(), Some(610.0));
        assert_eq!(panel.get("mode").unwrap().as_str(), Some("layout"));
        assert_eq!(panel.get("arrangement").unwrap().as_str(), Some("kawa"));
        assert_eq!(panel.get("nailPitch").unwrap().as_f64(), Some(150.0));
        assert_eq!(panel.get("edgeDistance").unwrap().as_f64(), Some(10.0));
        assert_eq!(
            response
                .get("preset")
                .unwrap()
                .get("nailCount")
                .unwrap()
                .as_f64(),
            Some(15.0)
        );
    }

    /// 割り付けの型は、画面が選択肢として並べられる形で配る。
    #[test]
    fn arrangements_are_listed_for_the_form() {
        let response = call_json(r#"{"op": "arrangements"}"#);
        let arrangements = response.get("arrangements").unwrap().as_array().unwrap();
        assert_eq!(arrangements.len(), 4);
        assert_eq!(arrangements[0].get("id").unwrap().as_str(), Some("kawa"));
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
        for request in ["", "{}", r#"{"op": "なにか"}"#, r#"{"op": "computeAll", "data": 1}"#] {
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
