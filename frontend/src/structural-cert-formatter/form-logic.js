// 構造計算安全証明書フォームの純粋ロジック（DOM に依存しない部分）。
//
// 項目の定義そのものは /config が backend/app/structural_cert_mapping.json
// から導出して配信するため、ここには「配られた定義をどう扱うか」だけを置く。
// バリデーションはバックエンドでも同じ内容を行っている（こちらは、送信して
// から差し戻されるのを避けるための先回りの案内）。
//
// 「保存 / 別名で保存 / 未保存の確認」といったファイル操作の判断と文言は、
// PDF を成果物とする他のツールと共通なので ../pdf-file-ops.js にある。

import { sanitizeFileName } from '../pdf-file-ops.js';

/** すべてのキーを空文字で持つフォームデータを作る。 */
export function emptyFormData(config) {
  const fields = {};
  config.text_fields.forEach((f) => {
    fields[f.key] = '';
  });
  const choices = {};
  config.choice_groups.forEach((g) => {
    choices[g.key] = '';
  });
  return { fields, choices };
}

/**
 * 解析結果（PDF から読み込んだ内容）を、現在の項目定義に合わせて整える。
 * 定義に無いキーは捨て、足りないキーは空文字で埋める。
 */
export function mergeFormData(config, parsed) {
  const data = emptyFormData(config);
  const parsedFields = (parsed && parsed.fields) || {};
  const parsedChoices = (parsed && parsed.choices) || {};

  Object.keys(data.fields).forEach((key) => {
    if (parsedFields[key] != null) data.fields[key] = String(parsedFields[key]);
  });
  config.choice_groups.forEach((group) => {
    const value = parsedChoices[group.key];
    const known = group.options.some((o) => o.value === value);
    data.choices[group.key] = known ? value : '';
  });
  return data;
}

/** 未入力の必須項目を日本語のラベルで列挙する。 */
export function validateFormData(config, data) {
  const missing = [];

  config.text_fields.forEach((field) => {
    if (field.required && !String(data.fields[field.key] || '').trim()) {
      missing.push(field.label);
    }
  });

  config.choice_groups.forEach((group) => {
    if (group.required && !data.choices[group.key]) {
      missing.push(group.label);
    }
    // 「６ その他」のように、選んだときだけ必要になる入力欄。
    group.options.forEach((option) => {
      if (!option.requires_field) return;
      if (data.choices[group.key] !== option.value) return;
      if (String(data.fields[option.requires_field] || '').trim()) return;
      const dependent = config.text_fields.find(
        (f) => f.key === option.requires_field
      );
      missing.push(dependent ? dependent.label : option.requires_field);
    });
  });

  return missing;
}

// --- 証明日 -----------------------------------------------------------------
//
// 証明書には和暦（{{年号年}} 年 {{月}} 月 {{日}} 日）で刷るが、入力は日付
// ピッカー（input[type=date]）で受け取る。西暦 → 和暦は Intl の和暦カレンダー
// に任せる（改元も「元年」の表記もブラウザ側が正しく扱う）。逆向きは年号ごとの
// 起点だけあれば足りるので、こちらで表を持つ。

const ERA_BASE_YEARS = {
  令和: 2018,
  平成: 1988,
  昭和: 1925,
  大正: 1911,
  明治: 1867,
};

// 和暦の最初の年は「元年」と書く。Intl もその表記で返す。
const FIRST_YEAR = '元';

const eraYearFormatter = new Intl.DateTimeFormat('ja-JP-u-ca-japanese', {
  era: 'long',
  year: 'numeric',
});

function toHalfWidth(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .trim();
}

/** "2026-08-10" のような値を Date にする。日付として成立しなければ null。 */
function parseIsoDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  // 2026-02-30 のような存在しない日付は、繰り上がって別の日になる。
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

/** 日付ピッカーの値から、証明書に刷る 3 つの欄の値を作る。 */
export function dateFieldsFromIso(iso) {
  const date = parseIsoDate(iso);
  if (!date) return null;
  // Intl は "令和8年" / "令和元年" を返す。雛形が「年」を刷るのでそれは落とし、
  // 元号と年数の間には半角スペースを入れる（「令和 8」）。
  const eraYear = eraYearFormatter
    .format(date)
    .replace(/年$/, '')
    .replace(/^(.+?)(元|\d+)$/, '$1 $2');
  return {
    era_year: eraYear,
    month: String(date.getUTCMonth() + 1),
    day: String(date.getUTCDate()),
  };
}

/** 証明書の 3 つの欄から、日付ピッカーに戻せる値を作る。戻せなければ空文字。 */
export function isoFromDateFields(fields) {
  const eraYear = toHalfWidth(fields && fields.era_year);
  const month = Number(toHalfWidth(fields && fields.month));
  const day = Number(toHalfWidth(fields && fields.day));
  if (!eraYear || !Number.isInteger(month) || !Number.isInteger(day)) return '';

  const match = /^(令和|平成|昭和|大正|明治)?\s*(元|\d+)$/.exec(eraYear);
  if (!match) return '';
  const [, era, rawYear] = match;
  const yearInEra = rawYear === FIRST_YEAR ? 1 : Number(rawYear);

  let year;
  if (era) {
    year = ERA_BASE_YEARS[era] + yearInEra;
  } else if (yearInEra >= 1868) {
    // 年号なしで書かれていた場合は西暦とみなす。
    year = yearInEra;
  } else {
    return '';
  }

  const iso =
    `${String(year).padStart(4, '0')}-` +
    `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return parseIsoDate(iso) ? iso : '';
}

/** 証明書に刷られる日付の文字列（画面での確認用）。 */
export function formatCertificateDate(fields) {
  const eraYear = String((fields && fields.era_year) || '').trim();
  const month = String((fields && fields.month) || '').trim();
  const day = String((fields && fields.day) || '').trim();
  if (!eraYear || !month || !day) return '';
  return `${eraYear}年${month}月${day}日`;
}

/**
 * 入力内容から既定のファイル名を組み立てる。
 * template は /config が配る "構造計算安全証明書_{building_name}.pdf" のような文字列。
 */
export function suggestedFileName(template, data, fallback) {
  const filled = String(template || '').replace(/\{([a-z_]+)\}/g, (whole, key) => {
    const value = data.fields[key];
    return value == null ? '' : String(value);
  });
  const name = sanitizeFileName(filled).replace('_.pdf', '.pdf');
  return name || fallback;
}

/**
 * 保存ダイアログに最初から入れておくファイル名。
 *
 * 既に名前が決まっている（Drive から開いた・手元の PDF を開いた・一度保存した）
 * ならその名前、まだ無ければフォームの入力から組み立てた候補を使う。
 */
export function defaultSaveName(config, data, documentName) {
  return (
    documentName ||
    suggestedFileName(config.file_name_template, data, config.default_file_name)
  );
}

/**
 * 未保存の入力があるかを判定するための、フォーム内容の指紋。
 *
 * 読み込み直後・保存直後の値と比べて、変わっていれば「編集中」とみなす。
 */
export function formSignature(data) {
  return JSON.stringify({ fields: data.fields, choices: data.choices });
}
