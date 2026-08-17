// 見積書 作成ツールの、画面に依らない部分。
//
// DOM も API も触らない純粋な関数だけを置く（テストしやすさのため。
// 他のツールの form-logic.js と同じ約束事）。
//
// **金額の計算と摘要の組み立てはここには無い。** それは唯一の計算実装
// （core/src/quotation.rs → wasm）が持っていて、画面もサーバも同じバイト列を
// 動かす。ここにあるのは、その周りの段取り——新規作成の初期値、未保存の判定、
// 候補と手入力の見分け、警告の文面。

/** 明細に付ける画面だけの識別子（保存されない。候補の追従に使う）。 */
let nextKey = 1;

function newKey() {
  nextKey += 1;
  return `item-${nextKey}`;
}

/** 端末の今日（YYYY-MM-DD）。テストから日付を差し込めるように引数で受ける。 */
export function todayIsoDate(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 明細 1 行。直前の行があれば、税の区分だけ引き継ぐ。 */
export function makeItem(previous = null) {
  return {
    key: newKey(),
    templateId: (previous && previous.templateId) || 'structural-design',
    spec: {
      scale: '',
      areaMode: 'approx',
      floorArea: '',
      method: (previous && previous.spec && previous.spec.method) || '',
      diagnosisMethod: (previous && previous.spec && previous.spec.diagnosisMethod) || '',
      note: '',
      inspectionCost: '',
      specialCost: '',
    },
    title: '',
    body: '',
    unitPrice: '',
    quantity: 1,
    taxCategory: (previous && previous.taxCategory) || 'standard',
  };
}

/**
 * 新規作成の初期状態。
 *
 * 発行元・備考・税の条件は共有設定から**写す**（参照ではなく写し）。
 * こうしておくと、設定を後から変えても、作成済みの見積書は変わらない
 * （docs/contract-formatter.md §7）。
 */
export function emptyFormData(settings, today = todayIsoDate()) {
  const office = (settings && settings.office) || {};
  const fee = (settings && settings.fee) || {};
  return {
    number: '',
    issuedOn: today,
    expiresOn: '',
    subject: '',
    client: {
      name: '',
      honorific: '御中',
      postalCode: '',
      address: '',
      department: '',
      contactName: '',
      contactHonorific: '様',
    },
    issuer: {
      name: office.name || '',
      postalCode: office.postalCode || '',
      address: office.address || '',
      tel: office.tel || '',
      personName: office.personName || '',
    },
    items: [makeItem()],
    remarks: (settings && settings.remarks) || '',
    tax: {
      taxRate: fee.taxRate === undefined ? 10 : fee.taxRate,
      reducedTaxRate: fee.reducedTaxRate === undefined ? 8 : fee.reducedTaxRate,
      taxRounding: fee.taxRounding || 'floor',
    },
  };
}

/** 読み込んだ見積書を、画面が扱う形へ整える（識別子を振り直す）。 */
export function mergeFormData(parsed) {
  const data = (parsed && parsed.data) || {};
  const items = Array.isArray(data.items) && data.items.length ? data.items : [makeItem()];
  return {
    ...emptyFormData(null, data.issuedOn || ''),
    ...data,
    items: items.map((item) => ({ ...makeItem(), ...item, key: newKey() })),
  };
}

/** 明細は 1 行以上ある（最後の 1 行は消せない）。 */
export function canRemoveItem(data) {
  return Boolean(data && data.items && data.items.length > 1);
}

/**
 * 未保存かどうかの判定に使う、内容の写し。
 *
 * 画面だけの識別子（key）は内容ではないので外す。
 */
export function formSignature(data) {
  return JSON.stringify(toRequestBody(data));
}

/** API と計算実装へ渡す形（画面だけの持ち物を落とす）。 */
export function toRequestBody(data) {
  if (!data) return {};
  return {
    ...data,
    items: (data.items || []).map(({ key, ...item }) => item),
  };
}

/**
 * 品名と摘要の候補を、入力欄へ反映する。
 *
 * **利用者が書き換えた欄は上書きしない。** 空欄か、直前の候補のままの欄だけを
 * 新しい候補にそろえる（規模や設計方法を動かすと摘要が付いてくるが、手で
 * 書き直した文はそのまま残る、という動き）。
 *
 * @param {Array} items 明細
 * @param {object} memo key → 直前に配った候補
 * @param {Array} suggestions 新しい候補（明細と同じ並び）
 * @returns {{items: Array, memo: object}}
 */
export function applySuggestions(items, memo, suggestions) {
  const nextMemo = {};
  const nextItems = (items || []).map((item, index) => {
    const before = memo[item.key] || { title: '', body: '' };
    const after = suggestions[index] || { title: '', body: '' };
    nextMemo[item.key] = after;
    return {
      ...item,
      title: !item.title || item.title === before.title ? after.title : item.title,
      body: !item.body || item.body === before.body ? after.body : item.body,
    };
  });
  return { items: nextItems, memo: nextMemo };
}

/** その明細のテンプレート定義（見つからなければ null）。 */
export function templateOf(templates, templateId) {
  return (templates || []).find((entry) => entry.id === templateId) || null;
}

/** 告示第670号の参考額を出せる明細か（耐震診断・耐震補強設計）。 */
export function seismicWorkOf(templates, templateId) {
  const found = templateOf(templates, templateId);
  return (found && found.seismicWork) || '';
}

/** 保存ダイアログの既定のファイル名。組み立てるのは計算実装。 */
export function defaultSaveName(computed, documentName) {
  return documentName || (computed && computed.defaultFileName) || '見積書.pdf';
}

/** サーバへ「画面はこう計算した」と伝える値。 */
export function verificationOf(coreVersion, computed) {
  const totals = (computed && computed.totals) || {};
  return {
    coreVersion,
    totals: {
      subtotal: totals.subtotal || 0,
      tax: totals.tax || 0,
      total: totals.total || 0,
    },
  };
}

/** 突き合わせの結果を、画面に出す 1 行の警告にする。合っていれば空文字。 */
export function verificationWarning(verification) {
  if (!verification || !verification.checked || verification.ok) return '';
  const versions = verification.coreVersion || {};
  if (versions.client && versions.server && versions.client !== versions.server) {
    return (
      '⚠ 画面とサーバーで計算実装の版が違います' +
      `（画面 ${versions.client} / サーバー ${versions.server}）。` +
      'ページを再読み込みして、金額を確かめてください。'
    );
  }
  const differences = verification.differences || [];
  if (!differences.length) return '';
  const detail = differences
    .map((row) => `${row.label}: 画面 ${row.client} / サーバー ${row.server}`)
    .join('、');
  return `⚠ 画面とサーバーの金額が食い違っています（${detail}）。PDF に記載されたのはサーバーの値です。`;
}

/** 発行元が未設定のときの案内（設定していないと保存できない）。 */
export function issuerHint(data) {
  if (data && data.issuer && data.issuer.name) return '';
  return (
    '発行元が未入力です。「設定」で事務所の名称・所在地を登録しておくと、' +
    '新規作成のたびに入ります。'
  );
}
