// フォームの組み立てと、DOM ↔ 入力値の受け渡し。
//
// 画面に出る項目は /config が配る定義だけを元に作る（form-logic.js の
// 説明を参照）。ここは「定義どおりに DOM を作る」「DOM から値を読む」
// 「今の入力に合わせて入力できる／できないを切り替える」の 3 つだけを行う。

// 節・入力欄・選択肢は画面の共通部品で作る（src/components/form-field.js）。
import { revealSection } from '../components/collapsible-section.js';
import {
  buildChoiceOption,
  buildField as buildSharedField,
  buildFieldGroup,
  buildSection as buildSharedSection,
  buildChoiceGroup,
} from '../components/form-field.js';
import {
  blockVisible,
  eachField,
  fieldRequired,
  fieldVisible,
  optionLabel,
  optionsFor,
  sectionEnabled,
} from './form-logic.js';

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * 入力欄 1 つ。
 *
 * 形は共通部品が作り、ここが足すのは連動プルダウンの印だけ（その行の
 * JAS 規格から候補を作り直すために、どの列のどの役かを覚えておく）。
 * 表の桝目に入る欄（compact）は、列の見出しが名前を担うのでラベルを出さない。
 */
export function buildField(doc, field, { compact } = {}) {
  const { wrap, control } = buildSharedField(doc, field, {
    hideLabel: compact,
    ariaLabel: compact ? field.label : '',
  });
  if (field.type === 'select' && field.cascade) {
    control.dataset.cascadeRole = field.cascade.role;
    control.dataset.cascadeOf = field.cascade.of;
  }
  return wrap;
}

function buildFieldsBlock(doc, block) {
  const wrap = buildFieldGroup(doc, { label: block.label, note: block.note });
  wrap.dataset.block = block.label || '';
  block.fields.forEach((field) => wrap.appendChild(buildField(doc, field)));
  return wrap;
}

function buildTableBlock(doc, block) {
  const wrap = buildFieldGroup(doc, { label: block.label, note: block.note });
  wrap.dataset.block = block.label || '';

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
  const { wrap } = buildSharedSection(doc, { title: section.title });
  wrap.dataset.section = section.key;
  if (section.note) wrap.appendChild(el(doc, 'p', 'hint', section.note));

  // 算定方法の入切。選択肢と同じ「行ごと押せる札」にする。
  if (section.toggle) {
    const toggle = buildChoiceOption(doc, {
      type: 'checkbox',
      text: section.toggle.label,
    });
    toggle.control.id = `field-${section.toggle.key}`;
    toggle.control.dataset.field = section.toggle.key;
    toggle.control.dataset.toggle = 'true';
    wrap.appendChild(toggle.wrap);
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
  const { wrap, controls } = buildChoiceGroup(doc, {
    legend: usage.title,
    name: 'usage',
    options: usage.options.map((option) => ({ value: option.value, text: option.label })),
    note: usage.note,
  });
  // 用途は他の欄（data-field）とは別に読み書きするので、専用の印を付ける。
  controls.forEach((radio) => {
    radio.dataset.usage = radio.value;
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
