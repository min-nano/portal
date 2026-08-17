// 見積書 作成ツールの、画面とデータの往復。
//
// 明細の入力欄は数が変わるので組み立てる。業務のテンプレートも選択肢も
// /config が配る定義（＝計算実装が持っている単一の情報源）から作るので、
// ここには業務の名前も設計方法の名前も出てこない。
//
// 入力欄は data-field で自分の在り処を名乗り（`unitPrice`・`spec.scale` の
// ような点つなぎ）、読み書きはその名前だけで行う。欄が増えても、ここの
// 読み書きの関数は増えない。

const ITEM_FIELDS = [
  'templateId',
  'title',
  'body',
  'unitPrice',
  'quantity',
  'taxCategory',
  'spec.scale',
  'spec.areaMode',
  'spec.floorArea',
  'spec.method',
  'spec.diagnosisMethod',
  'spec.note',
  'spec.inspectionCost',
  'spec.specialCost',
];

/** 見積書 1 通ぶんの、明細以外の入力欄（画面の id → データの在り処）。 */
const HEADER_FIELDS = {
  quoteNumber: 'number',
  issuedOn: 'issuedOn',
  expiresOn: 'expiresOn',
  subject: 'subject',
  clientName: 'client.name',
  clientHonorific: 'client.honorific',
  clientPostalCode: 'client.postalCode',
  clientAddress: 'client.address',
  clientDepartment: 'client.department',
  clientContactName: 'client.contactName',
  clientContactHonorific: 'client.contactHonorific',
  issuerName: 'issuer.name',
  issuerPostalCode: 'issuer.postalCode',
  issuerAddress: 'issuer.address',
  issuerTel: 'issuer.tel',
  issuerPersonName: 'issuer.personName',
  taxRate: 'tax.taxRate',
  reducedTaxRate: 'tax.reducedTaxRate',
  taxRounding: 'tax.taxRounding',
  remarks: 'remarks',
};

function read(target, path) {
  return path.split('.').reduce((value, key) => (value == null ? value : value[key]), target);
}

function write(target, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const owner = keys.reduce((value, key) => {
    if (!value[key]) value[key] = {};
    return value[key];
  }, target);
  owner[last] = value;
}

/** 同じ値を書き戻さない（入力中の欄でカーソルが飛ばないようにする）。 */
function setValue(element, value) {
  const text = value === undefined || value === null ? '' : String(value);
  if (element.value !== text) element.value = text;
}

// --- 明細以外の入力欄 --------------------------------------------------------

/** 見積書の内容を入力欄へ写す。 */
export function applyForm(doc, data, config) {
  fillOptions(doc.getElementById('taxRounding'), config.roundings);
  Object.entries(HEADER_FIELDS).forEach(([id, path]) => {
    const element = doc.getElementById(id);
    if (element) setValue(element, read(data, path));
  });
}

/** 入力欄の内容を見積書へ書き戻す（明細は readItems が受け持つ）。 */
export function readForm(doc, data) {
  Object.entries(HEADER_FIELDS).forEach(([id, path]) => {
    const element = doc.getElementById(id);
    if (element) write(data, path, element.value);
  });
  data.items = readItems(doc, data.items);
  return data;
}

function fillOptions(select, options) {
  if (!select || !options) return;
  const current = select.value;
  select.textContent = '';
  options.forEach((option) => {
    const node = select.ownerDocument.createElement('option');
    node.value = option.id;
    node.textContent = option.label;
    select.appendChild(node);
  });
  if (current) select.value = current;
}

// --- 明細 --------------------------------------------------------------------

/**
 * 明細の入力欄を組み立て直す。
 *
 * 呼ぶのは行が増減したときと業務を変えたときだけ（打鍵のたびに作り直すと、
 * 入力中の欄から焦点が外れる）。値の反映は syncItems が行う。
 */
export function renderItems(doc, items, config) {
  const container = doc.getElementById('items');
  container.textContent = '';
  container.appendChild(datalists(doc, config));
  items.forEach((item, index) => {
    const block = itemBlock(doc, item, index, items.length, config);
    container.appendChild(block);
    // 組み立てた欄に、その明細の値を入れる。ここを忘れると、読み込んだ
    // 見積書が空の欄で上書きされてしまう（次の readItems が空を読むため）。
    applyItemValues(block, item);
  });
}

function applyItemValues(block, item) {
  ITEM_FIELDS.forEach((path) => {
    const element = block.querySelector(`[data-field="${path}"]`);
    if (element) setValue(element, read(item, path));
  });
}

function datalists(doc, config) {
  const fragment = doc.createDocumentFragment();
  [
    ['quoteScaleOptions', config.scaleOptions],
    ['quoteMethodOptions', config.methodOptions],
    ['quoteDiagnosisOptions', config.diagnosisMethodOptions],
  ].forEach(([id, values]) => {
    const list = doc.createElement('datalist');
    list.id = id;
    (values || []).forEach((value) => {
      const option = doc.createElement('option');
      option.value = value;
      list.appendChild(option);
    });
    fragment.appendChild(list);
  });
  return fragment;
}

function field(doc, labelText, control, className = 'cert-field') {
  const wrapper = doc.createElement('div');
  wrapper.className = className;
  const label = doc.createElement('label');
  label.textContent = labelText;
  label.setAttribute('for', control.id);
  wrapper.append(label, control);
  return wrapper;
}

function input(doc, id, path, type = 'text', extra = {}) {
  const node = doc.createElement(type === 'textarea' ? 'textarea' : 'input');
  if (type !== 'textarea') node.type = type;
  node.id = id;
  node.dataset.field = path;
  Object.entries(extra).forEach(([key, value]) => {
    if (value !== undefined) node.setAttribute(key, value);
  });
  return node;
}

function select(doc, id, path, options) {
  const node = doc.createElement('select');
  node.id = id;
  node.dataset.field = path;
  options.forEach((option) => {
    const item = doc.createElement('option');
    item.value = option.id === undefined ? option : option.id;
    item.textContent = option.label === undefined ? option : option.label;
    node.appendChild(item);
  });
  return node;
}

function itemBlock(doc, item, index, total, config) {
  const template =
    (config.templates || []).find((entry) => entry.id === item.templateId) ||
    (config.templates || [])[0] ||
    {};
  const block = doc.createElement('div');
  block.className = 'wall-panel quote-item';
  block.dataset.itemIndex = String(index);

  const heading = doc.createElement('h4');
  heading.textContent = `${index + 1} 行目`;
  const remove = doc.createElement('button');
  remove.type = 'button';
  remove.dataset.removeItem = String(index);
  remove.textContent = 'この行を削除';
  remove.disabled = total <= 1;
  const head = doc.createElement('div');
  head.className = 'quote-item-head';
  head.append(heading, remove);
  block.appendChild(head);

  const grid = doc.createElement('div');
  grid.className = 'field-grid';
  block.appendChild(grid);

  // テンプレートの一覧は「名前」で名乗るので、選択肢の形（id・label）に直す。
  const templateOptions = (config.templates || []).map((entry) => ({
    id: entry.id,
    label: entry.name,
  }));
  grid.appendChild(
    field(doc, '業務', select(doc, `itemTemplate${index}`, 'templateId', templateOptions))
  );

  if (template.composition !== 'free') {
    grid.appendChild(
      field(
        doc,
        '規模',
        input(doc, `itemScale${index}`, 'spec.scale', 'text', {
          list: 'quoteScaleOptions',
          placeholder: '2階建て',
        })
      )
    );
    const area = doc.createElement('div');
    area.className = 'cert-field';
    const areaLabel = doc.createElement('label');
    areaLabel.textContent = `${template.areaLabel || '床面積'} [㎡]`;
    areaLabel.setAttribute('for', `itemArea${index}`);
    const areaRow = doc.createElement('div');
    areaRow.className = 'field-row';
    areaRow.append(
      input(doc, `itemArea${index}`, 'spec.floorArea', 'number', { inputmode: 'decimal', step: '0.01' }),
      select(doc, `itemAreaMode${index}`, 'spec.areaMode', config.areaModes || [])
    );
    area.append(areaLabel, areaRow);
    grid.appendChild(area);

    if (template.composition === 'seismic') {
      grid.appendChild(
        field(
          doc,
          '診断法',
          input(doc, `itemDiagnosis${index}`, 'spec.diagnosisMethod', 'text', {
            list: 'quoteDiagnosisOptions',
            placeholder: '一般診断法',
          })
        )
      );
    } else {
      grid.appendChild(
        field(
          doc,
          '設計方法',
          input(doc, `itemMethod${index}`, 'spec.method', 'text', {
            list: 'quoteMethodOptions',
            placeholder: '仕様規定(壁量計算)',
          })
        )
      );
    }
  }

  grid.appendChild(
    field(
      doc,
      '摘要に足す行（提出図書など）',
      input(doc, `itemNote${index}`, 'spec.note', 'textarea', { rows: '2' }),
      'cert-field field-span'
    )
  );

  if (template.seismicWork) block.appendChild(seismicBlock(doc, index, config));

  const composed = doc.createElement('div');
  composed.className = 'field-grid';
  composed.appendChild(
    field(doc, '品名', input(doc, `itemTitle${index}`, 'title'), 'cert-field field-span')
  );
  composed.appendChild(
    field(
      doc,
      '摘要（見積書に印字されます）',
      input(doc, `itemBody${index}`, 'body', 'textarea', { rows: '6' }),
      'cert-field field-span'
    )
  );
  const reset = doc.createElement('button');
  reset.type = 'button';
  reset.className = 'secondary';
  reset.dataset.resetItem = String(index);
  reset.textContent = '品名と摘要を候補に戻す';
  const resetRow = doc.createElement('p');
  resetRow.className = 'hint field-span';
  resetRow.append(
    doc.createTextNode('上の欄を動かすと、書き換えていない品名と摘要は自動でついてきます。 '),
    reset
  );
  composed.appendChild(resetRow);
  block.appendChild(composed);

  const money = doc.createElement('div');
  money.className = 'panel-size';
  money.append(
    field(doc, '単価 [円]', input(doc, `itemUnitPrice${index}`, 'unitPrice', 'text', {
      inputmode: 'numeric',
      placeholder: '284000',
    })),
    field(doc, '数量', input(doc, `itemQuantity${index}`, 'quantity', 'text', { inputmode: 'decimal' })),
    field(doc, '税区分', select(doc, `itemTax${index}`, 'taxCategory', config.taxCategories || []))
  );
  block.appendChild(money);

  const amount = doc.createElement('p');
  amount.className = 'hint quote-amount';
  amount.dataset.amount = String(index);
  block.appendChild(amount);

  return block;
}

function seismicBlock(doc, index, config) {
  const seismic = (config && config.seismic) || {};
  const block = doc.createElement('div');
  block.className = 'seismic-estimate';
  block.dataset.seismic = String(index);

  const heading = doc.createElement('h4');
  heading.textContent = '告示第670号による参考額';
  const hint = doc.createElement('p');
  hint.className = 'hint';
  hint.textContent =
    '平成27年国土交通省告示第670号 別添二 別表第二（戸建木造住宅、床面積の合計 ' +
    `${seismic.minArea || 75}㎡〜${seismic.maxArea || 250}㎡）の標準業務人・時間数から、` +
    '報酬（税抜）の参考額を出します。人件費単価と技術料等経費率は「設定」の値を使います。';
  block.append(heading, hint);

  const costs = doc.createElement('div');
  costs.className = 'panel-size';
  costs.append(
    field(
      doc,
      '検査費 [円]',
      input(doc, `itemInspection${index}`, 'spec.inspectionCost', 'text', { inputmode: 'numeric' })
    ),
    field(
      doc,
      '特別経費 [円]',
      input(doc, `itemSpecial${index}`, 'spec.specialCost', 'text', { inputmode: 'numeric' })
    )
  );
  block.appendChild(costs);

  const error = doc.createElement('p');
  error.className = 'result-error';
  error.dataset.seismicError = String(index);
  error.hidden = true;

  const table = doc.createElement('table');
  table.className = 'steps-table';
  table.dataset.seismicRows = String(index);
  table.appendChild(doc.createElement('tbody'));

  const apply = doc.createElement('button');
  apply.type = 'button';
  apply.dataset.applyFee = String(index);
  apply.textContent = 'この参考額を単価に入れる';
  apply.disabled = true;

  block.append(error, table, apply);
  return block;
}

/** 入力欄の内容を明細へ書き戻す。 */
export function readItems(doc, items) {
  return (items || []).map((item, index) => {
    const block = doc.querySelector(`[data-item-index="${index}"]`);
    if (!block) return item;
    const next = { ...item, spec: { ...item.spec } };
    ITEM_FIELDS.forEach((path) => {
      const element = block.querySelector(`[data-field="${path}"]`);
      if (element) write(next, path, element.value);
    });
    return next;
  });
}

/**
 * 計算し直した値を明細へ反映する（入力欄は組み立て直さない）。
 *
 * 反映するのは、候補から動いた品名・摘要と、金額。
 */
export function syncItems(doc, items, computed) {
  const amounts = (computed && computed.items) || [];
  items.forEach((item, index) => {
    const block = doc.querySelector(`[data-item-index="${index}"]`);
    if (!block) return;
    ['title', 'body'].forEach((path) => {
      const element = block.querySelector(`[data-field="${path}"]`);
      if (element) setValue(element, item[path]);
    });
    const amount = block.querySelector(`[data-amount="${index}"]`);
    if (amount) {
      const value = amounts[index] || {};
      amount.textContent = `金額: ${value.amountText || '0'} 円`;
    }
  });
}

/** 告示第670号の参考額を、その明細の欄へ出す。 */
export function renderSeismicEstimate(doc, index, estimate) {
  const table = doc.querySelector(`[data-seismic-rows="${index}"]`);
  const error = doc.querySelector(`[data-seismic-error="${index}"]`);
  const apply = doc.querySelector(`[data-apply-fee="${index}"]`);
  if (!table || !error || !apply) return;

  const applicable = Boolean(estimate && estimate.applicable);
  error.hidden = applicable;
  error.textContent = applicable ? '' : (estimate && estimate.reason) || '';
  apply.disabled = !applicable;

  const body = table.tBodies[0];
  body.textContent = '';
  table.hidden = !applicable;
  if (!applicable) return;

  (estimate.rows || []).forEach((row) => {
    const tr = doc.createElement('tr');
    const label = doc.createElement('td');
    label.className = 'step-label';
    label.textContent = row.label;
    const note = doc.createElement('td');
    note.className = 'step-eq';
    note.textContent = row.note || '';
    const value = doc.createElement('td');
    value.className = 'step-value';
    value.textContent = row.amountText;
    tr.append(label, note, value);
    body.appendChild(tr);
  });
}

// --- 金額（右の列） ----------------------------------------------------------

/** 御見積金額と内訳、そして警告を出す。 */
export function renderTotals(doc, computed) {
  const totals = (computed && computed.totals) || {};
  const box = doc.getElementById('quoteTotal');
  box.querySelector('.value').textContent = totals.totalText || '0';

  const body = doc.getElementById('quoteBreakdown').tBodies[0];
  body.textContent = '';
  const rows = [
    ['小計', totals.subtotalText, ''],
    ['消費税', totals.taxText, `端数は${totals.roundingLabel || ''}`],
  ];
  (totals.buckets || []).forEach((bucket) => {
    rows.push([`内訳 ${bucket.label}`, bucket.baseText, '']);
    if (bucket.category !== 'exempt') rows.push(['　消費税', bucket.taxText, '']);
  });
  rows.forEach(([label, value, note]) => {
    const tr = doc.createElement('tr');
    const labelCell = doc.createElement('td');
    labelCell.className = 'step-label';
    labelCell.textContent = label;
    const noteCell = doc.createElement('td');
    noteCell.className = 'step-eq';
    noteCell.textContent = note;
    const valueCell = doc.createElement('td');
    valueCell.className = 'step-value';
    valueCell.textContent = `${value || '0'} 円`;
    tr.append(labelCell, noteCell, valueCell);
    body.appendChild(tr);
  });

  const warnings = doc.getElementById('quoteWarnings');
  warnings.textContent = '';
  const messages = (computed && computed.warnings) || [];
  warnings.hidden = messages.length === 0;
  messages.forEach((message) => {
    const item = doc.createElement('li');
    item.textContent = message;
    warnings.appendChild(item);
  });
}

// --- 設定 --------------------------------------------------------------------

const SETTINGS_FIELDS = {
  setOfficeName: 'office.name',
  setOfficePostalCode: 'office.postalCode',
  setOfficeAddress: 'office.address',
  setOfficeTel: 'office.tel',
  setOfficePersonName: 'office.personName',
  setTermsDesign: 'terms.design',
  setTermsSeismic: 'terms.seismic',
  setRemarks: 'remarks',
  setTaxRate: 'fee.taxRate',
  setReducedTaxRate: 'fee.reducedTaxRate',
  setTaxRounding: 'fee.taxRounding',
  setPersonnelUnitPrice: 'fee.personnelUnitPrice',
  setTechnicalFeeRate: 'fee.technicalFeeRate',
  setOverheadMultiplier: 'fee.overheadMultiplier',
};

export function applySettings(doc, settings, config) {
  fillOptions(doc.getElementById('setTaxRounding'), config.roundings);
  Object.entries(SETTINGS_FIELDS).forEach(([id, path]) => {
    const element = doc.getElementById(id);
    if (element) setValue(element, read(settings, path));
  });
}

export function readSettings(doc) {
  const settings = {};
  Object.entries(SETTINGS_FIELDS).forEach(([id, path]) => {
    const element = doc.getElementById(id);
    if (element) write(settings, path, element.value);
  });
  return settings;
}

/** タイトル横の「発行元: ○○」。未設定なら、その旨を出す。 */
export function showOfficeChip(doc, settings) {
  const chip = doc.getElementById('officeChip');
  const name = (settings && settings.office && settings.office.name) || '';
  chip.textContent = name || '未設定';
  chip.className = name ? 'name' : 'unset';
}
