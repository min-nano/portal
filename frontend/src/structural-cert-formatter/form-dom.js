// フォームの組み立てと、DOM ↔ フォームデータの受け渡し。
//
// 項目は /config が backend/app/structural_cert_mapping.json から導出して
// 配信する定義（text_fields / choice_groups / sections）だけを元に作る。
// この画面には項目を持たないので、雛形の改訂にはマッピングの編集だけで
// 追従できる。

import { emptyFormData } from './form-logic.js';

// 単位から入力モード（スマートフォンのキーパッド）を決める。値は文字列の
// まま扱う（"62.10" の末尾 0 や全角入力をそのまま雛形へ差し込むため、
// input[type=number] は使わない）。
const NUMERIC_UNITS = ['月', '日', '階'];
const DECIMAL_UNITS = ['m', 'm²'];

export function buildField(doc, field) {
  const wrap = doc.createElement('div');
  wrap.className = 'cert-field';

  const label = doc.createElement('label');
  label.setAttribute('for', `field-${field.key}`);
  label.textContent = field.label + (field.required ? ' *' : '');
  wrap.appendChild(label);

  const row = doc.createElement('div');
  row.className = 'field-row';
  const input = doc.createElement('input');
  input.type = 'text';
  input.id = `field-${field.key}`;
  input.dataset.field = field.key;
  if (field.hint) input.placeholder = field.hint;
  if (NUMERIC_UNITS.includes(field.unit)) input.inputMode = 'numeric';
  if (DECIMAL_UNITS.includes(field.unit)) input.inputMode = 'decimal';
  row.appendChild(input);
  if (field.unit) {
    const unit = doc.createElement('span');
    unit.className = 'unit';
    unit.textContent = field.unit;
    row.appendChild(unit);
  }
  wrap.appendChild(row);
  return wrap;
}

export function buildChoiceGroup(doc, group) {
  const wrap = doc.createElement('fieldset');
  wrap.className = 'cert-choices';

  const legend = doc.createElement('legend');
  legend.textContent = group.label + (group.required ? ' *' : '');
  wrap.appendChild(legend);

  // 必須でないグループは「選ばない」状態にも戻せるようにする。
  const options = group.required
    ? group.options
    : [{ value: '', label: '（指定しない）' }].concat(group.options);

  options.forEach((option) => {
    const label = doc.createElement('label');
    label.className = 'choice-option';
    const radio = doc.createElement('input');
    radio.type = 'radio';
    radio.name = `choice-${group.key}`;
    radio.value = option.value;
    radio.dataset.choice = group.key;
    const text = doc.createElement('span');
    // 証明書と同じ番号を添えて、どの選択肢に印が付くのかを分かりやすくする。
    // 「有 / 無」のように値そのものが表示名になっている選択肢は、そのまま出す。
    text.textContent =
      option.value && option.value !== option.label
        ? `${option.value}　${option.label}`
        : option.label;
    label.append(radio, text);
    wrap.appendChild(label);
  });
  return wrap;
}

/** sections の並び（証明書の記載順）どおりにフォームを組み立てる。 */
export function buildForm(root, config) {
  const doc = root.ownerDocument;
  root.innerHTML = '';
  const fieldsByKey = new Map(config.text_fields.map((f) => [f.key, f]));
  const groupsByKey = new Map(config.choice_groups.map((g) => [g.key, g]));

  config.sections.forEach((section) => {
    const wrap = doc.createElement('section');
    wrap.className = 'cert-section';
    const heading = doc.createElement('h3');
    heading.textContent = section.title;
    wrap.appendChild(heading);
    section.items.forEach((item) => {
      if (item.field) {
        wrap.appendChild(buildField(doc, fieldsByKey.get(item.field)));
      } else {
        wrap.appendChild(buildChoiceGroup(doc, groupsByKey.get(item.choice)));
      }
    });
    root.appendChild(wrap);
  });

  // 未選択を既定にする（必須でないグループの「（指定しない）」を選んでおく）。
  applyFormData(root, emptyFormData(config));
}

export function collectFormData(root, config) {
  const data = emptyFormData(config);
  root.querySelectorAll('[data-field]').forEach((input) => {
    data.fields[input.dataset.field] = input.value.trim();
  });
  root.querySelectorAll('[data-choice]:checked').forEach((radio) => {
    data.choices[radio.dataset.choice] = radio.value;
  });
  return data;
}

export function applyFormData(root, data) {
  root.querySelectorAll('[data-field]').forEach((input) => {
    input.value = data.fields[input.dataset.field] || '';
  });
  root.querySelectorAll('[data-choice]').forEach((radio) => {
    radio.checked = radio.value === (data.choices[radio.dataset.choice] || '');
  });
}
