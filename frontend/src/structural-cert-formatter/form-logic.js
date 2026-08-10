// 構造計算安全証明書フォームの純粋ロジック（DOM に依存しない部分）。
//
// 項目の定義そのものは /config が backend/app/structural_cert_mapping.json
// から導出して配信するため、ここには「配られた定義をどう扱うか」だけを置く。
// バリデーションはバックエンドでも同じ内容を行っている（こちらは、送信して
// から差し戻されるのを避けるための先回りの案内）。

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

/** ファイル名に使えない文字を落とす。バックエンドの整形と同じ規則。 */
export function sanitizeFileName(name) {
  return String(name || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .trim()
    .replace(/^\.+|\.+$/g, '');
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

/** 拡張子 .pdf を必ず付ける。 */
export function ensurePdfExtension(name, fallback) {
  const cleaned = sanitizeFileName(name);
  if (!cleaned) return fallback;
  return /\.pdf$/i.test(cleaned) ? cleaned : `${cleaned}.pdf`;
}

/** 保存前の確認文。上書きは取り消しづらいので、対象を明示する。 */
export function confirmSaveMessage(mode, fileName, sourceFile) {
  if (mode === 'overwrite') {
    const target = (sourceFile && sourceFile.name) || fileName;
    return (
      `Google Drive 上の「${target}」を上書きします。\n` +
      '（上書き前の内容は、しばらくの間は Drive の版履歴から復元できます）\n\nよろしいですか？'
    );
  }
  return `「${fileName}」という名前で新しく保存します。\n\nよろしいですか？`;
}

/** 上書き保存を選べるのは、Drive 上のファイルを読み込んだときだけ。 */
export function canOverwrite(sourceFile) {
  return Boolean(sourceFile && sourceFile.id);
}
