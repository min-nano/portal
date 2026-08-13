// フォームの組み立てと、DOM ↔ 入力値の受け渡し。
//
// 画面に出る項目は /config が配る定義だけを元に作る（form-logic.js の
// 説明を参照）。ここは「定義どおりに DOM を作る」「DOM から値を読む」
// 「今の入力に合わせて入力できる／できないを切り替える」の 3 つだけを行う。

// 節は折り畳めるセクション（<portal-section>）で作る。
import { revealSection } from '../components/collapsible-section.js';
import {
  blockVisible,
  eachField,
  fieldRequired,
  fieldVisible,
  optionLabel,
  optionsFor,
  sectionEnabled,
} from './form-logic.js';

// 単位から入力モード（スマートフォンのキーパッド）を決める。
const NUMERIC_UNITS = ['mm', '寸'];

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildSelect(doc, field) {
  const select = doc.createElement('select');
  select.id = `field-${field.key}`;
  select.dataset.field = field.key;
  if (field.cascade) {
    select.dataset.cascadeRole = field.cascade.role;
    select.dataset.cascadeOf = field.cascade.of;
  }
  return select;
}

function buildInput(doc, field) {
  const input = doc.createElement('input');
  input.id = `field-${field.key}`;
  input.dataset.field = field.key;
  if (field.type === 'date') {
    input.type = 'date';
  } else if (field.type === 'number') {
    input.type = 'number';
    input.inputMode = NUMERIC_UNITS.indexOf(field.unit) === -1 ? 'decimal' : 'numeric';
    if (field.step) input.step = field.step;
    if (field.min !== undefined) input.min = String(field.min);
  } else {
    input.type = 'text';
  }
  return input;
}

/** 入力欄 1 つ（ラベル・入力・単位・注意書き）。 */
export function buildField(doc, field, { compact } = {}) {
  const wrap = el(doc, 'div', 'wq-field');
  wrap.dataset.fieldWrap = field.key;

  if (!compact) {
    const label = el(doc, 'label', null, field.label);
    label.setAttribute('for', `field-${field.key}`);
    wrap.appendChild(label);
  }

  const row = el(doc, 'div', 'field-row');
  const control = field.type === 'select' ? buildSelect(doc, field) : buildInput(doc, field);
  if (compact) control.setAttribute('aria-label', field.label);
  row.appendChild(control);
  if (field.unit) row.appendChild(el(doc, 'span', 'unit', field.unit));
  wrap.appendChild(row);

  if (field.note) wrap.appendChild(el(doc, 'p', 'hint', field.note));
  return wrap;
}

function buildFieldsBlock(doc, block) {
  const wrap = el(doc, 'div', 'wq-block');
  wrap.dataset.block = block.label || '';
  if (block.label) wrap.appendChild(el(doc, 'h4', null, block.label));
  if (block.note) wrap.appendChild(el(doc, 'p', 'hint', block.note));
  block.fields.forEach((field) => wrap.appendChild(buildField(doc, field)));
  return wrap;
}

function buildTableBlock(doc, block) {
  const wrap = el(doc, 'div', 'wq-block');
  wrap.dataset.block = block.label || '';
  if (block.label) wrap.appendChild(el(doc, 'h4', null, block.label));
  if (block.note) wrap.appendChild(el(doc, 'p', 'hint', block.note));

  const table = el(doc, 'table', 'wq-table');
  const thead = doc.createElement('thead');
  const headRow = doc.createElement('tr');
  block.columns.forEach((column) => headRow.appendChild(el(doc, 'th', null, column)));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = doc.createElement('tbody');
  block.rows.forEach((row) => {
    const tr = doc.createElement('tr');
    tr.appendChild(el(doc, 'th', 'row-head', row.label));
    row.fields.forEach((field) => {
      const td = doc.createElement('td');
      td.appendChild(buildField(doc, field, { compact: true }));
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

/** 節 1 つ（見出し・算定方法のチェックボックス・かたまり）。折り畳める。 */
export function buildSection(doc, section) {
  const wrap = el(doc, 'portal-section', 'cert-section');
  wrap.dataset.section = section.key;
  // 見出しは折り畳んでも見えるところ（セクションの開閉の行）に置く。
  const heading = el(doc, 'h3', null, section.title);
  heading.slot = 'title';
  wrap.appendChild(heading);
  if (section.note) wrap.appendChild(el(doc, 'p', 'hint', section.note));

  if (section.toggle) {
    const label = el(doc, 'label', 'wq-toggle');
    const box = doc.createElement('input');
    box.type = 'checkbox';
    box.id = `field-${section.toggle.key}`;
    box.dataset.field = section.toggle.key;
    box.dataset.toggle = 'true';
    label.appendChild(box);
    label.appendChild(el(doc, 'span', null, section.toggle.label));
    wrap.appendChild(label);
  }

  (section.blocks || []).forEach((block) => {
    const node = block.kind === 'table' ? buildTableBlock(doc, block) : buildFieldsBlock(doc, block);
    node.dataset.blockIndex = String(section.blocks.indexOf(block));
    wrap.appendChild(node);
  });
  return wrap;
}

/** 「0. 設計の用途」のラジオ。配布物ではチェックボックスだが、選べるのは 1 つだけ。 */
export function buildUsage(doc, usage) {
  const wrap = el(doc, 'fieldset', 'cert-choices');
  wrap.appendChild(el(doc, 'legend', null, usage.title));
  if (usage.note) wrap.appendChild(el(doc, 'p', 'hint', usage.note));
  usage.options.forEach((option) => {
    const label = el(doc, 'label', 'choice-option');
    const radio = doc.createElement('input');
    radio.type = 'radio';
    radio.name = 'usage';
    radio.value = option.value;
    radio.dataset.usage = option.value;
    label.appendChild(radio);
    label.appendChild(el(doc, 'span', null, option.label));
    wrap.appendChild(label);
  });
  return wrap;
}

/** 建物 1 つぶんのフォーム全体を作る。 */
export function buildForm(doc, config, buildingKey) {
  const building = config.buildings.filter((b) => b.key === buildingKey)[0];
  const root = el(doc, 'div', 'wq-form');
  root.dataset.building = buildingKey;
  if (!building) return root;
  building.sections.forEach((section, index) => {
    root.appendChild(buildSection(doc, section));
    // 「0. 設計の用途」は最初の節（作成者）のすぐ後ろに置く。配布物の並びと同じ。
    if (index === 0) root.appendChild(buildUsage(doc, config.usage));
  });
  return root;
}

/**
 * 出力結果（配布物のオレンジの枠に当たるところ）を組み立てる。
 *
 * 計算は Rust → wasm（core/src/wall_quantity.rs）が行い、ここは返ってきた
 * 節・表・行・升目をそのまま並べるだけ。入力が足りないところは配布物と
 * 同じく空欄になるので、「—」を置いて空欄だと分かるようにする。
 */
export function buildResults(doc, result) {
  const root = el(doc, 'div', 'wq-results');
  if (!result) return root;

  (result.sections || []).forEach((section) => {
    const wrap = el(doc, 'div', 'wq-result-section');
    wrap.dataset.resultSection = section.key;
    wrap.appendChild(el(doc, 'h4', null, section.title));
    if (section.enabled === false) {
      // 算定方法のチェックボックスが切りのとき。配布物でも空欄になる。
      wrap.appendChild(el(doc, 'p', 'hint', '算定方法のチェックを入れると計算します。'));
      root.appendChild(wrap);
      return;
    }
    if (section.note) wrap.appendChild(el(doc, 'p', 'hint', section.note));
    (section.tables || []).forEach((table) => {
      wrap.appendChild(buildResultTable(doc, table));
    });
    root.appendChild(wrap);
  });
  return root;
}

function buildResultTable(doc, table) {
  const wrap = el(doc, 'div', 'wq-result-table');
  if (table.title) wrap.appendChild(el(doc, 'h5', null, table.title));

  const node = el(doc, 'table', 'wq-table');
  const thead = doc.createElement('thead');
  const headRow = doc.createElement('tr');
  headRow.appendChild(el(doc, 'th', null, ''));
  (table.columns || []).forEach((column) => {
    headRow.appendChild(el(doc, 'th', null, column.label));
  });
  thead.appendChild(headRow);
  node.appendChild(thead);

  const tbody = doc.createElement('tbody');
  (table.rows || []).forEach((row) => {
    const tr = doc.createElement('tr');
    tr.appendChild(el(doc, 'th', 'row-head', row.label));
    (row.cells || []).forEach((cell) => {
      const td = el(doc, 'td', 'wq-result-cell', cell.text === '' ? '—' : cell.text);
      td.dataset.resultKey = cell.key;
      if (cell.text === '') td.classList.add('empty');
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  node.appendChild(tbody);
  wrap.appendChild(node);
  return wrap;
}

/** DOM から入力値を読む。 */
export function readValues(root) {
  const values = {};
  root.querySelectorAll('[data-field]').forEach((node) => {
    values[node.dataset.field] =
      node.dataset.toggle === 'true' ? node.checked : node.value;
  });
  const usage = root.querySelector('[data-usage]:checked');
  values.usage = usage ? usage.value : '';
  return values;
}

/** 入力値を DOM に書き戻す（初期値の適用に使う）。 */
export function writeValues(root, values) {
  root.querySelectorAll('[data-field]').forEach((node) => {
    const value = values[node.dataset.field];
    if (node.dataset.toggle === 'true') {
      node.checked = Boolean(value);
    } else {
      node.value = value === undefined || value === null ? '' : String(value);
    }
  });
  root.querySelectorAll('[data-usage]').forEach((radio) => {
    radio.checked = radio.value === values.usage;
  });
}

/**
 * 未入力の必須欄がある節を開く。
 *
 * 節は折り畳めるので、閉じた中に入力漏れが隠れたままにならないよう、
 * 出力できなかったときに呼ぶ（必須の印は refresh が付けている）。
 */
export function revealMissingFields(root) {
  root.querySelectorAll('[data-field-wrap].required').forEach((wrap) => {
    const control = wrap.querySelector('[data-field]');
    if (control && !control.disabled && String(control.value).trim() === '') {
      revealSection(wrap);
    }
  });
}

/**
 * 今の入力に合わせて、入力できる欄・選択肢を整える。
 *
 * ここでやることは 3 つ:
 *   1. 連動プルダウン（樹種等・等級等）の候補を、その行の JAS 規格から作り直す
 *   2. 条件を満たさない欄・使わない算定方法を、入力できない状態にして値を消す
 *      （画面に残った値が配布物へ紛れ込まないように）
 *   3. 必須の欄に印を付ける
 */
export function refresh(root, config, buildingKey, values) {
  const building = config.buildings.filter((b) => b.key === buildingKey)[0];
  if (!building) return values;
  const next = { ...values };

  // 1. 連動プルダウン。
  eachField(building).forEach(({ field }) => {
    if (field.type !== 'select') return;
    const select = root.querySelector(`[data-field="${field.key}"]`);
    if (!select) return;
    const options = optionsFor(field, next, config);
    const wanted = ['', ...options];
    const current = Array.prototype.map.call(select.options, (o) => o.value);
    if (current.length !== wanted.length || wanted.some((v, i) => v !== current[i])) {
      const keep = next[field.key];
      select.textContent = '';
      wanted.forEach((value) => {
        const option = select.ownerDocument.createElement('option');
        option.value = value;
        option.textContent = value === '' ? '（未選択）' : optionLabel(value);
        select.appendChild(option);
      });
      // 規格を変えて候補から外れた選択は捨てる（配布物でも選び直しになる）。
      select.value = wanted.indexOf(keep) === -1 ? '' : keep;
      next[field.key] = select.value;
    }
  });

  // 2. 節・かたまり・欄の入力可否。
  building.sections.forEach((section) => {
    const sectionEl = root.querySelector(`[data-section="${section.key}"]`);
    if (!sectionEl) return;
    const enabled = sectionEnabled(section, next);
    sectionEl.classList.toggle('disabled', !enabled);

    (section.blocks || []).forEach((block, index) => {
      const blockEl = sectionEl.querySelector(`[data-block-index="${index}"]`);
      if (blockEl) blockEl.hidden = !blockVisible(section, block, next);
    });
  });

  eachField(building).forEach(({ section, field }) => {
    const control = root.querySelector(`[data-field="${field.key}"]`);
    if (!control) return;
    const usable = fieldVisible(section, field, next);
    control.disabled = !usable;
    if (!usable && control.value !== '') {
      control.value = '';
      next[field.key] = '';
    }
    const wrap = root.querySelector(`[data-field-wrap="${field.key}"]`);
    if (wrap) {
      wrap.hidden = !usable && Boolean(field.visible_when);
      wrap.classList.toggle('required', usable && fieldRequired(field, next));
    }
  });

  return next;
}
