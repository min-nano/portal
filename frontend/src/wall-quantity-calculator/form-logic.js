// フォームの純粋ロジック（DOM 非依存）。vitest で単体テストする。
//
// 節・入力欄・選択肢・条件は、すべて /config が配る定義
// （backend/app/wall_quantity_mapping.json 由来）から来る。この画面には
// 項目を持たないので、配布物（表計算ツール）の改訂にはマッピングの編集
// だけで追従できる。

/** 選択肢の文字列を画面に出す形にする（配布物の選択肢は改行を含む）。 */
export function optionLabel(value) {
  return String(value === undefined || value === null ? '' : value)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' ');
}

/**
 * 条件（visible_when / required_when / fixed_when）を今の入力で判定する。
 *
 * @param {{field: string, in?: string[], not_in?: string[]}|undefined} condition
 * @param {Object} values key → 入力値
 */
export function conditionMet(condition, values) {
  if (!condition) return true;
  const actual = values[condition.field] === undefined ? '' : values[condition.field];
  if (condition.in) return condition.in.indexOf(actual) !== -1;
  if (condition.not_in) return condition.not_in.indexOf(actual) === -1;
  return true;
}

/** 節が使えるか（算定方法のチェックボックスが入りか）。 */
export function sectionEnabled(section, values) {
  if (!section.toggle) return true;
  return Boolean(values[section.toggle.key]);
}

/** かたまり（表・入力欄の並び）を表示するか。 */
export function blockVisible(section, block, values) {
  return sectionEnabled(section, values) && conditionMet(block.visible_when, values);
}

/** 入力欄を入力できるか。 */
export function fieldVisible(section, field, values) {
  return sectionEnabled(section, values) && conditionMet(field.visible_when, values);
}

/** 入力欄が必須か（条件つき必須を含む）。 */
export function fieldRequired(field, values) {
  if (field.required) return true;
  return Boolean(field.required_when) && conditionMet(field.required_when, values);
}

/**
 * 選択欄の候補。樹種等・等級等は、同じ行で選んだ JAS 規格で決まる
 * （配布物の INDIRECT を使ったプルダウンと同じ連動）。
 */
export function optionsFor(field, values, config) {
  if (field.type !== 'select') return [];
  if (field.cascade) {
    const jas = values[field.cascade.of] || '';
    const table = field.cascade.role === 'species' ? config.species : config.grade;
    return (table && table[jas]) || [];
  }
  return config.options[field.options_ref] || [];
}

/** 建物（平屋建て / 2階建て）の定義を取り出す。 */
export function buildingOf(config, buildingKey) {
  return config.buildings.filter((b) => b.key === buildingKey)[0] || null;
}

/** 建物の全入力欄を、節・かたまり・行つきで順に返す。 */
export function eachField(building) {
  const out = [];
  (building.sections || []).forEach((section) => {
    (section.blocks || []).forEach((block) => {
      if (block.kind === 'fields') {
        block.fields.forEach((field) => out.push({ section, block, row: null, field }));
      } else {
        block.rows.forEach((row) => {
          row.fields.forEach((field) => out.push({ section, block, row, field }));
        });
      }
    });
  });
  return out;
}

/**
 * 出力前の確認。足りない入力・選べない値を、直せる文言にして返す。
 *
 * バックエンドも同じ確認をする（サーバが正）が、往復する前に画面で気付ける
 * ようにここでも見る。
 *
 * @return {string[]} エラーメッセージ（空なら出力できる）
 */
export function collectErrors(config, buildingKey, values) {
  const building = buildingOf(config, buildingKey);
  if (!building) return ['建物の種別を選んでください。'];

  const usageValues = config.usage.options.map((o) => o.value);
  if (usageValues.indexOf(values.usage) === -1) {
    return [`「${config.usage.title}」を 1 つ選んでください。`];
  }

  const missing = [];
  const invalid = [];
  eachField(building).forEach(({ section, row, field }) => {
    if (!fieldVisible(section, field, values)) return;
    const value = values[field.key];
    const empty = value === undefined || value === null || String(value).trim() === '';
    if (fieldRequired(field, values) && empty) {
      const where = row ? `${row.label} ` : '';
      missing.push(`${section.title}の「${where}${field.label}」`);
      return;
    }
    if (empty) return;
    if (field.type === 'select') {
      if (optionsFor(field, values, config).indexOf(value) === -1) {
        invalid.push(`「${field.label}」に選べない値が入っています。`);
      }
    } else if (field.type === 'number' && !isFinite(toNumber(value))) {
      invalid.push(`「${field.label}」には数値を入力してください。`);
    }
  });

  const errors = [];
  if (missing.length > 0) {
    errors.push('次の入力が足りません: ' + missing.join('、'));
  }
  return errors.concat(invalid);
}

/** モバイル IME の全角数字も数値として解釈する（バックエンドの NFKC と揃える）。 */
export function toNumber(value) {
  if (value === undefined || value === null) return NaN;
  let text = String(value).trim();
  if (text === '') return NaN;
  if (text.normalize) text = text.normalize('NFKC');
  return Number(text);
}

/**
 * 送信データを組み立てる。
 *
 * 入力できない欄（用途で消える欄・使わない算定方法・条件を満たさない任意入力）は
 * 送らない。バックエンドも同じ判断で空にするので、画面に残っていた値が
 * 配布物へ紛れ込むことはない。
 */
export function buildPayload(config, buildingKey, values) {
  const building = buildingOf(config, buildingKey);
  const out = {};
  eachField(building).forEach(({ section, field }) => {
    if (!fieldVisible(section, field, values)) return;
    const value = values[field.key];
    if (value === undefined || value === null || String(value) === '') return;
    out[field.key] = String(value);
  });

  const toggles = {};
  (building.sections || []).forEach((section) => {
    if (section.toggle) toggles[section.toggle.key] = Boolean(values[section.toggle.key]);
  });

  return {
    building: buildingKey,
    usage: values.usage || '',
    toggles,
    values: { ...out, property_name: values.property_name || '' },
  };
}

/**
 * 応答の Content-Disposition が読めなかったときのファイル名。
 * バックエンドの wall_quantity.file_name と同じ組み立て方にする。
 */
export function fallbackFileName(config, buildingKey, propertyName) {
  const building = buildingOf(config, buildingKey);
  const label = building ? building.label : '';
  const naming = config.file_name;
  let name = `${naming.prefix}（${label}）`;
  const property = String(propertyName || '')
    .split('')
    .filter((ch) => '\\/:*?"<>|'.indexOf(ch) === -1)
    .join('')
    .trim();
  if (property) name += `_${property}`;
  return name + naming.extension;
}

/** 今日の日付を <input type="date"> の値（YYYY-MM-DD）にする。 */
export function isoToday(now) {
  const d = now || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 画面を開いたときの初期値。
 *
 * 配布物が最初から入れている値（標準せん断力係数 0.2、地震地域係数と
 * 多雪区域の「ー」、断熱材の初期値）に揃えるので、そのまま出力すれば
 * 配布物を手で開いたときと同じ状態から始まる。
 */
export function defaultValues(config, buildingKey, now) {
  const building = buildingOf(config, buildingKey);
  const values = { usage: '', property_name: '' };
  if (!building) return values;

  eachField(building).forEach(({ field }) => {
    values[field.key] = '';
    if (field.type === 'date') values[field.key] = isoToday(now);
    if (field.type === 'select' && field.options_ref) {
      const options = config.options[field.options_ref] || [];
      // 「ー」「初期値」と書かれた選択肢、標準せん断力係数は配布物の初期値。
      if (field.options_ref === 'base_shear') values[field.key] = options[0] || '';
      if (field.options_ref === 'seismic_zone' || field.options_ref === 'heavy_snow') {
        values[field.key] = options[0] || '';
      }
      if (
        field.options_ref === 'ceiling_insulation' ||
        field.options_ref === 'wall_insulation'
      ) {
        values[field.key] = options[0] || '';
      }
    }
  });
  (building.sections || []).forEach((section) => {
    if (section.toggle) values[section.toggle.key] = false;
  });
  return values;
}
