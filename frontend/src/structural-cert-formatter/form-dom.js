// フォームの組み立てと、DOM ↔ フォームデータの受け渡し。
//
// 項目は /config が backend/app/structural_cert_mapping.json から導出して
// 配信する定義（text_fields / choice_groups / sections）だけを元に作る。
// この画面には項目を持たないので、雛形の改訂にはマッピングの編集だけで
// 追従できる。

// 節は折り畳めるセクション（<portal-section>）で作る。
import { revealSection } from '../components/collapsible-section.js';
import {
  dateFieldsFromIso,
  emptyFormData,
  fieldDependencies,
  formatCertificateDate,
  isoFromDateFields,
} from './form-logic.js';

// 単位から入力モード（スマートフォンのキーパッド）を決める。値は文字列の
// まま扱う（"62.10" の末尾 0 や全角入力をそのまま雛形へ差し込むため、
// input[type=number] は使わない）。
const NUMERIC_UNITS = ['月', '日', '階'];
const DECIMAL_UNITS = ['m', 'm²'];

/**
 * 記入欄。
 *
 * dependency を渡した欄は、その選択肢が選ばれているときだけ入力できる
 * （「６ その他」の内容など。refreshDependencies を参照）。
 */
export function buildField(doc, field, { hideLabel, labelledBy, dependency } = {}) {
  const wrap = doc.createElement('div');
  wrap.className = 'cert-field';
  // 未入力のまま保存しようとしたとき、その項目を含む節を開いて示すための目印。
  if (field.required) wrap.dataset.required = '';

  // セクションの見出しと同じ名前なら、ラベルは出さない（見出しが名前を担う）。
  if (!hideLabel) {
    const label = doc.createElement('label');
    label.setAttribute('for', `field-${field.key}`);
    label.textContent = field.label + (field.required ? ' *' : '');
    wrap.appendChild(label);
  }

  const row = doc.createElement('div');
  row.className = 'field-row';
  const input = doc.createElement('input');
  input.type = 'text';
  input.id = `field-${field.key}`;
  input.dataset.field = field.key;
  if (hideLabel && labelledBy) input.setAttribute('aria-labelledby', labelledBy);
  if (field.hint) input.placeholder = field.hint;
  if (NUMERIC_UNITS.includes(field.unit)) input.inputMode = 'numeric';
  if (DECIMAL_UNITS.includes(field.unit)) input.inputMode = 'decimal';
  if (dependency) {
    input.dataset.requiresChoice = dependency.choice;
    input.dataset.requiresValue = dependency.option.value;
  }
  row.appendChild(input);
  if (field.unit) {
    const unit = doc.createElement('span');
    unit.className = 'unit';
    unit.textContent = field.unit;
    row.appendChild(unit);
  }
  wrap.appendChild(row);

  if (dependency) {
    const hint = doc.createElement('p');
    hint.className = 'hint';
    hint.textContent = `「${optionText(dependency.option)}」を選んだときに入力できます。`;
    wrap.appendChild(hint);
  }
  return wrap;
}

/**
 * 前提のある項目（記入欄・選択肢）の有効・無効を、今の入力に合わせる。
 *
 * 前提が外れている間の入力は証明書に載らない（バックエンドも空にする）ため、
 * 入力そのものをさせず、前提が外れたときは入力・選択を消す。
 *
 * 前提は「記入欄 → 選択肢 → 記入欄」（プログラムの名称 → 大臣の認定 →
 * 認定番号）と連鎖するので、選択肢・記入欄の順に見る。
 */
export function refreshDependencies(root) {
  // 「その欄を入力したときだけ選べる」選択肢。入力が消えていれば選択も外す。
  root.querySelectorAll('[data-requires-field]').forEach((group) => {
    const source = root.querySelector(`[data-field="${group.dataset.requiresField}"]`);
    const active = Boolean(source && source.value.trim());
    group.classList.toggle('disabled', !active);
    group.querySelectorAll('[data-choice]').forEach((radio) => {
      radio.disabled = !active;
      if (!active) radio.checked = false;
    });
  });

  // 「その選択肢を選んだときだけ入力できる」記入欄。
  root.querySelectorAll('[data-requires-choice]').forEach((input) => {
    const selected = root.querySelector(
      `[data-choice="${input.dataset.requiresChoice}"]:checked`
    );
    const active = Boolean(selected) && selected.value === input.dataset.requiresValue;
    input.disabled = !active;
    if (!active) input.value = '';
    const wrap = input.closest('.cert-field');
    if (wrap) wrap.classList.toggle('disabled', !active);
  });
}

/** 日付ピッカーが受け持つ 3 欄のうち、ひとつでも必須なら必須扱いにする。 */
function isDateRequired(spec, fieldsByKey) {
  return [spec.era_year, spec.month, spec.day].some((key) => {
    const field = fieldsByKey.get(key);
    return Boolean(field && field.required);
  });
}

/**
 * 証明日の入力欄。見えているのは日付ピッカーひとつで、証明書に刷る和暦の
 * 3 欄（年号年 / 月 / 日）は隠し入力に持たせる。
 *
 * 3 欄を実体にしているのは、読み込んだ PDF の日付が和暦として解釈できない
 * ときでも中身を失わないため。その場合ピッカーは空のままだが、保存すれば
 * 元の値がそのまま出る（何が刷られるかは下の確認欄に出す）。
 */
export function buildDateField(doc, spec, fieldsByKey, { hideLabel, labelledBy } = {}) {
  const wrap = doc.createElement('div');
  wrap.className = 'cert-field cert-date';
  if (isDateRequired(spec, fieldsByKey)) wrap.dataset.required = '';

  // セクションの見出しと同じ名前なら、ラベルは出さない（見出しが名前を担う）。
  if (!hideLabel) {
    const label = doc.createElement('label');
    label.setAttribute('for', 'certDate');
    label.textContent = (spec.label || '日付') + (isDateRequired(spec, fieldsByKey) ? ' *' : '');
    wrap.appendChild(label);
  }

  const picker = doc.createElement('input');
  picker.type = 'date';
  picker.id = 'certDate';
  if (hideLabel && labelledBy) picker.setAttribute('aria-labelledby', labelledBy);
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
  // 読み取れた日付は、このツールの表記（「令和 8」）に揃えてから保存する。
  // 読み取れなかった場合は手を触れない（元の値をそのまま残す）。
  if (picker.value) syncFieldsFromPicker(root);
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

/**
 * 選択肢の表示名。
 *
 * 証明書と同じ番号を添えて、どの選択肢に印が付くのかを分かりやすくする。
 * 「有 / 無」のように値そのものが表示名になっている選択肢は、そのまま出す。
 */
function optionText(option) {
  return option.value && option.value !== option.label
    ? `${option.value}　${option.label}`
    : option.label;
}

/**
 * 選択肢のグループ。
 *
 * セクションの見出しがそのままこのグループの名前になっている場合
 * （建築物の区分など、セクションに選択肢しか無いとき）は、見出しと囲みが
 * 二重になるだけなので legend を出さず、枠も付けない。名前はセクションの
 * 見出しが担う（読み上げ用に aria-labelledby で結び付ける）。
 *
 * gate（前提となる記入欄の定義）を渡したグループは、その欄に入力が
 * あるときだけ選べる（refreshDependencies を参照）。
 */
export function buildChoiceGroup(doc, group, { hideLegend, labelledBy, gate } = {}) {
  const wrap = doc.createElement('fieldset');
  wrap.className = hideLegend ? 'cert-choices bare' : 'cert-choices';
  if (labelledBy) wrap.setAttribute('aria-labelledby', labelledBy);
  if (gate) wrap.dataset.requiresField = gate.key;
  if (group.required) wrap.dataset.required = '';

  if (!hideLegend) {
    const legend = doc.createElement('legend');
    legend.textContent = group.label + (group.required ? ' *' : '');
    wrap.appendChild(legend);
  }

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
    text.textContent = optionText(option);
    label.append(radio, text);
    wrap.appendChild(label);
  });

  if (gate) {
    const hint = doc.createElement('p');
    hint.className = 'hint';
    hint.textContent = `「${gate.label}」を入力したときに選べます。`;
    wrap.appendChild(hint);
  }
  return wrap;
}

/** sections の並び（証明書の記載順）どおりにフォームを組み立てる。 */
export function buildForm(root, config) {
  const doc = root.ownerDocument;
  root.innerHTML = '';
  const fieldsByKey = new Map(config.text_fields.map((f) => [f.key, f]));
  const groupsByKey = new Map(config.choice_groups.map((g) => [g.key, g]));

  // 「その選択肢を選んだときだけ入力できる欄」の対応表（記入欄 → 選択肢）。
  const dependencyByField = fieldDependencies(config);

  config.sections.forEach((section, index) => {
    const wrap = doc.createElement('portal-section');
    wrap.className = 'cert-section';

    // 見出しがそのまま名前になっている項目は、セクションの見出しにまとめる
    // （同じ文言と囲みが二重にならないように）。
    const mergedChoice = section.items.find(
      (item) => item.choice && groupsByKey.get(item.choice).label === section.title
    );
    const mergedGroup = mergedChoice ? groupsByKey.get(mergedChoice.choice) : null;
    const mergedDate = section.items.find(
      (item) => item.date && item.date.label === section.title
    );
    const mergedField = section.items.find(
      (item) => item.field && fieldsByKey.get(item.field).label === section.title
    );

    const required =
      (mergedGroup && mergedGroup.required) ||
      (mergedDate && isDateRequired(mergedDate.date, fieldsByKey)) ||
      (mergedField && fieldsByKey.get(mergedField.field).required);
    const heading = doc.createElement('h3');
    heading.id = `cert-section-${index}`;
    heading.textContent = section.title + (required ? ' *' : '');
    // 見出しは折り畳んでも見えるところ（セクションの開閉の行）に置く。
    heading.slot = 'title';
    wrap.appendChild(heading);

    section.items.forEach((item) => {
      if (item.field) {
        wrap.appendChild(
          buildField(doc, fieldsByKey.get(item.field), {
            hideLabel: item === mergedField,
            labelledBy: heading.id,
            dependency: dependencyByField.get(item.field),
          })
        );
      } else if (item.date) {
        wrap.appendChild(
          buildDateField(doc, item.date, fieldsByKey, {
            hideLabel: item === mergedDate,
            labelledBy: heading.id,
          })
        );
      } else {
        const group = groupsByKey.get(item.choice);
        wrap.appendChild(
          buildChoiceGroup(doc, group, {
            hideLegend: group === mergedGroup,
            labelledBy: heading.id,
            gate: fieldsByKey.get(group.depends_on_field),
          })
        );
      }
    });
    root.appendChild(wrap);
  });

  // 前提のある項目は、その前提（選択・入力）が変わるたびに切り替える。
  root.querySelectorAll('[data-choice]').forEach((radio) => {
    radio.addEventListener('change', () => refreshDependencies(root));
  });
  root.querySelectorAll('[data-requires-field]').forEach((group) => {
    const source = root.querySelector(`[data-field="${group.dataset.requiresField}"]`);
    if (source) source.addEventListener('input', () => refreshDependencies(root));
  });

  // 未選択を既定にする（必須でないグループの「（指定しない）」を選んでおく）。
  applyFormData(root, emptyFormData(config));
}

/**
 * 未入力の必須項目がある節を開く。
 *
 * 節は折り畳めるので、閉じた中に入力漏れが隠れたままにならないよう、
 * 保存できなかったときに呼ぶ（どの項目が足りないかは画面下の文言が出す）。
 */
export function revealMissingFields(root) {
  root.querySelectorAll('[data-required]').forEach((wrap) => {
    // 前提が外れている項目（入力・選択できない状態）は、証明書にも載らない
    // ので数えない（validateFormData と同じ扱い）。
    if (wrap.classList.contains('disabled')) return;
    const missing = wrap.classList.contains('cert-choices')
      ? !wrap.querySelector('[data-choice]:checked')
      : Array.from(wrap.querySelectorAll('[data-field]')).some(
          (input) => !input.disabled && !input.value.trim()
        );
    if (missing) revealSection(wrap);
  });
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
  // 前提のある項目は、流し込んだ内容に合わせて有効・無効を決め直す。
  refreshDependencies(root);
  // 隠し入力に入れた和暦から、日付ピッカーの表示を合わせ直す。
  syncPickerFromFields(root);
}
