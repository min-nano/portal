// 入力欄・選択肢・節の組み立て（画面の共通部品）。
//
// 構造計算安全証明書・必要壁量・面材張り大壁の 3 つは、どれも「サーバが配る
// 定義どおりに入力欄を並べる」という同じことをしていて、その骨格が
// それぞれの form-dom.js に 1 つずつあった。ここはその骨格 1 つぶんで、
// 作る形は次のとおり。
//
//   <div class="field" data-field-wrap="KEY">
//     <label for="field-KEY">ラベル</label>
//     <div class="field-row">
//       <input id="field-KEY" data-field="KEY"><span class="unit">mm</span>
//     </div>
//     <p class="hint">注意書き</p>
//   </div>
//
// ここが受け持つのは **形だけ** で、何を定義に書くか（条件・連動・和暦・
// 釘配列図）はツールの持ちもの。ツールごとに違う印（`data-panel-field` や
// `data-cascade-role`）は、戻り値の control に呼び出し側が足す。
//
// 必須の扱いが 2 通りあるのは、必須になる決まり方が 2 通りあるため。
//
//   data-required … 「この欄は必須」の目印。未入力のまま出力できなかった
//                   ときに、折り畳んだ節を開いて示すのに使う（証明書）
//   .required     … 「必須」の札を出す（デザインシステム側の見た目）。
//                   必要壁量は他の入力しだいで必須が変わるので、組み立て
//                   時ではなく refresh のたびに付け外しする
//
// 証明書は必須をラベルの「*」で示す決まりなので、札は出さない。

// 単位から入力モード（スマートフォンのキーパッド）を決める。
//
// 整数しか入らない単位は数字だけのキーパッド、小数の入る単位は小数点付き。
// どちらにも当てはまらない単位は型に従う（数値の欄なら小数点付き、
// 自由入力の欄はふつうのキーボード）。
const NUMERIC_UNITS = ['mm', '寸', '月', '日', '階'];
const DECIMAL_UNITS = ['m', 'm²'];

/** 単位（と型）から input の inputmode を決める。当てはまらなければ空文字。 */
export function inputModeFor(unit, type) {
  if (unit && NUMERIC_UNITS.indexOf(unit) !== -1) return 'numeric';
  if (unit && DECIMAL_UNITS.indexOf(unit) !== -1) return 'decimal';
  return type === 'number' ? 'decimal' : '';
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function buildControl(doc, spec) {
  if (spec.type === 'select') {
    const select = doc.createElement('select');
    (spec.options || []).forEach((option) => {
      const node = doc.createElement('option');
      node.value = option.value;
      node.textContent = option.text;
      if (option.title) node.title = option.title;
      select.appendChild(node);
    });
    return select;
  }

  const input = doc.createElement('input');
  input.type = spec.type === 'number' || spec.type === 'date' ? spec.type : 'text';
  if (spec.placeholder) input.placeholder = spec.placeholder;
  if (spec.step) input.step = spec.step;
  if (spec.min !== undefined && spec.min !== null) input.min = String(spec.min);
  return input;
}

/**
 * 入力欄 1 つ（ラベル・欄・単位・注意書き）。
 *
 * spec:
 *   key         data-field と id（`field-<key>`）の元。省略すると付けない
 *   id          id を key から作らずに直に決める（面材のように同じ名前の欄が
 *               画面に何組も出るとき）
 *   label       ラベルの文字。必須の「*」を添えるかは呼び出し側が決める
 *   type        'text'（既定）/ 'number' / 'date' / 'select'
 *   unit        欄の右にくっつける単位
 *   note        欄の下に添える注意書き
 *   placeholder / step / min / options / value / inputMode
 *   required    必須の目印（data-required）を付ける
 *
 * options:
 *   hideLabel   ラベルを出さない（節の見出しや表の見出しが名前を担うとき）
 *   labelledBy  読み上げ用に、名前を担っている見出しの id を結び付ける
 *   ariaLabel   見出しも無いとき（表の桝目の中）の読み上げ名
 *   className   包む枠に足すクラス
 *
 * 戻り値は { wrap, control }。ツール固有の印は control に呼び出し側が足す。
 */
export function buildField(doc, spec, { hideLabel, labelledBy, ariaLabel, className } = {}) {
  const wrap = el(doc, 'div', className ? `field ${className}` : 'field');
  if (spec.key) wrap.dataset.fieldWrap = spec.key;
  if (spec.required) wrap.dataset.required = '';

  const id = spec.id || (spec.key ? `field-${spec.key}` : '');
  if (!hideLabel && spec.label) {
    const label = el(doc, 'label', null, spec.label);
    if (id) label.setAttribute('for', id);
    wrap.appendChild(label);
  }

  const control = buildControl(doc, spec);
  if (id) control.id = id;
  if (spec.key) control.dataset.field = spec.key;
  const inputMode =
    spec.inputMode === undefined ? inputModeFor(spec.unit, spec.type) : spec.inputMode;
  if (inputMode) control.inputMode = inputMode;
  if (labelledBy) control.setAttribute('aria-labelledby', labelledBy);
  else if (ariaLabel) control.setAttribute('aria-label', ariaLabel);
  if (spec.value !== undefined && spec.value !== null) control.value = String(spec.value);

  const row = el(doc, 'div', 'field-row');
  row.appendChild(control);
  if (spec.unit) row.appendChild(el(doc, 'span', 'unit', spec.unit));
  wrap.appendChild(row);

  if (spec.note) wrap.appendChild(el(doc, 'p', 'hint', spec.note));
  return { wrap, control };
}

/** 選択肢 1 つ（行ごと押せる札）。 */
export function buildChoiceOption(doc, { type, name, value, text, checked }) {
  const label = el(doc, 'label', 'choice-option');
  const control = doc.createElement('input');
  control.type = type || 'radio';
  if (name) control.name = name;
  if (value !== undefined) control.value = value;
  if (checked) control.checked = true;
  label.append(control, el(doc, 'span', null, text));
  return { wrap: label, control };
}

/**
 * 選択肢のグループ。
 *
 * 節の見出しがそのままこのグループの名前になっているときは legend を出さず、
 * 枠も付けない（同じ文言と囲みが二重になるだけなので）。名前は見出しが担い、
 * 読み上げ用に labelledBy で結び付ける。
 *
 * 戻り値は { wrap, controls }。
 */
export function buildChoiceGroup(
  doc,
  { legend, name, options, required, note, footnote },
  { hideLegend, labelledBy, className } = {}
) {
  const classes = ['choices'];
  if (hideLegend) classes.push('bare');
  if (className) classes.push(className);
  const wrap = el(doc, 'fieldset', classes.join(' '));
  if (labelledBy) wrap.setAttribute('aria-labelledby', labelledBy);
  if (required) wrap.dataset.required = '';

  if (!hideLegend && legend) wrap.appendChild(el(doc, 'legend', null, legend));
  // note は選ぶ前に読むもの（何を選ぶのか）、footnote は選べないときの
  // 理由なので、選択肢の前と後ろに分けて置く。
  if (note) wrap.appendChild(el(doc, 'p', 'hint', note));

  const controls = (options || []).map((option) => {
    const built = buildChoiceOption(doc, { ...option, name });
    wrap.appendChild(built.wrap);
    return built.control;
  });

  if (footnote) wrap.appendChild(el(doc, 'p', 'hint', footnote));
  return { wrap, controls };
}

/** 節の中の小見出し付きのかたまり（中身は桝目に並ぶ）。 */
export function buildFieldGroup(doc, { label, note, className } = {}) {
  const wrap = el(doc, 'div', className ? `field-group ${className}` : 'field-group');
  if (label) wrap.appendChild(el(doc, 'h4', null, label));
  if (note) wrap.appendChild(el(doc, 'p', 'hint', note));
  return wrap;
}

/**
 * 節（折り畳めるカード）。
 *
 * 見出しと操作ボタンは、折り畳んでも見えるところ（開閉の行）に置く。
 * 中身を桝目に並べるのは `.form-section` を付けたときだけ（面材 1 枚ぶんの
 * ように、縦に積みたい節もあるため）。
 *
 * 戻り値は { wrap, heading }。
 */
export function buildSection(
  doc,
  { title, titleTag, titleId, actions, className, grid } = {}
) {
  const classes = [];
  if (grid !== false) classes.push('form-section');
  if (className) classes.push(className);
  const wrap = el(doc, 'portal-section', classes.join(' ') || null);

  const heading = el(doc, titleTag || 'h3', null, title);
  heading.slot = 'title';
  if (titleId) heading.id = titleId;
  wrap.appendChild(heading);

  [].concat(actions || []).forEach((node) => {
    node.slot = 'actions';
    wrap.appendChild(node);
  });
  return { wrap, heading };
}
