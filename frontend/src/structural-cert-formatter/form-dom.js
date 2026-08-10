// フォームの組み立てと、DOM ↔ フォームデータの受け渡し。
//
// 項目は /config が backend/app/structural_cert_mapping.json から導出して
// 配信する定義（text_fields / choice_groups / sections）だけを元に作る。
// この画面には項目を持たないので、雛形の改訂にはマッピングの編集だけで
// 追従できる。

import {
  dateFieldsFromIso,
  emptyFormData,
  formatCertificateDate,
  isoFromDateFields,
} from './form-logic.js';

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

/**
 * 証明日の入力欄。見えているのは日付ピッカーひとつで、証明書に刷る和暦の
 * 3 欄（年号年 / 月 / 日）は隠し入力に持たせる。
 *
 * 3 欄を実体にしているのは、読み込んだ PDF の日付が和暦として解釈できない
 * ときでも中身を失わないため。その場合ピッカーは空のままだが、保存すれば
 * 元の値がそのまま出る（何が刷られるかは下の確認欄に出す）。
 */
export function buildDateField(doc, spec, fieldsByKey) {
  const wrap = doc.createElement('div');
  wrap.className = 'cert-field cert-date';

  const required = [spec.era_year, spec.month, spec.day].some(
    (key) => fieldsByKey.get(key) && fieldsByKey.get(key).required
  );
  const label = doc.createElement('label');
  label.setAttribute('for', 'certDate');
  label.textContent = (spec.label || '日付') + (required ? ' *' : '');
  wrap.appendChild(label);

  const picker = doc.createElement('input');
  picker.type = 'date';
  picker.id = 'certDate';
  picker.dataset.datePicker = '';
  picker.dataset.eraYearField = spec.era_year;
  picker.dataset.monthField = spec.month;
  picker.dataset.dayField = spec.day;
  wrap.appendChild(picker);

  [spec.era_year, spec.month, spec.day].forEach((key) => {
    const hidden = doc.createElement('input');
    hidden.type = 'hidden';
    hidden.dataset.field = key;
    wrap.appendChild(hidden);
  });

  const preview = doc.createElement('p');
  preview.className = 'hint';
  preview.dataset.datePreview = '';
  wrap.appendChild(preview);
  return wrap;
}

/** 日付ピッカーの選択を、証明書に刷る和暦の 3 欄へ反映する。 */
export function syncFieldsFromPicker(root) {
  const picker = root.querySelector('[data-date-picker]');
  if (!picker) return;
  const fields = dateFieldsFromIso(picker.value);
  if (!fields) return;
  setFieldValue(root, picker.dataset.eraYearField, fields.era_year);
  setFieldValue(root, picker.dataset.monthField, fields.month);
  setFieldValue(root, picker.dataset.dayField, fields.day);
  refreshDatePreview(root);
}

/** 和暦の 3 欄から日付ピッカーの表示を復元する（戻せなければ空のまま）。 */
export function syncPickerFromFields(root) {
  const picker = root.querySelector('[data-date-picker]');
  if (!picker) return;
  picker.value = isoFromDateFields({
    era_year: getFieldValue(root, picker.dataset.eraYearField),
    month: getFieldValue(root, picker.dataset.monthField),
    day: getFieldValue(root, picker.dataset.dayField),
  });
  refreshDatePreview(root);
}

/** 証明書に刷られる日付を確認欄に出す。 */
export function refreshDatePreview(root) {
  const picker = root.querySelector('[data-date-picker]');
  const preview = root.querySelector('[data-date-preview]');
  if (!picker || !preview) return;
  const printed = formatCertificateDate({
    era_year: getFieldValue(root, picker.dataset.eraYearField),
    month: getFieldValue(root, picker.dataset.monthField),
    day: getFieldValue(root, picker.dataset.dayField),
  });
  preview.textContent = printed
    ? `証明書には「${printed}」と印字されます。`
    : '日付を選択してください。';
}

function getFieldValue(root, key) {
  const input = root.querySelector(`[data-field="${key}"]`);
  return input ? input.value : '';
}

function setFieldValue(root, key, value) {
  const input = root.querySelector(`[data-field="${key}"]`);
  if (input) input.value = value;
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
      } else if (item.date) {
        wrap.appendChild(buildDateField(doc, item.date, fieldsByKey));
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
  // 隠し入力に入れた和暦から、日付ピッカーの表示を合わせ直す。
  syncPickerFromFields(root);
}
