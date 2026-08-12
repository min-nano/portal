// 小規模木造建築物 必要壁量 計算ツール（表計算ツールへの記入）。
//
// フォームに入力すると、日本住宅・木材技術センターが配布している
// 「壁量等の基準(令和7年施行)に対応した表計算ツール（多機能版）」に
// その値を書き込んだ **Excel ファイル** をダウンロードする。提出物は
// 配布物そのものなので、Google スプレッドシート等へは変換しない。
//
// 出力される xlsx の中の計算は配布物の数式が行う（このツールは数式に手を
// 入れない）。一方この画面では、配布物の数式を写した計算実装（Rust → wasm。
// 面材張り大壁と同じ .wasm）で入力のたびに計算し、「出力結果」をその場で
// 出す。Excel で開くまで結果を待たなくてよく、入力の間違いにも早く気付ける。
// 保存のときはサーバーも同じ .wasm で計算し、画面の値と突き合わせる。

import '../styles.css';
import '../components/index.js';
import { requireSignIn } from '../auth.js';
import { redirectToCanonicalHost } from '../canonical-host.js';
import { apiGet, apiGetBytes, apiPostForBlob } from '../api.js';
import { loadCore } from '../core.js';
import {
  buildForm,
  buildResults,
  readValues,
  refresh,
  revealMissingFields,
  writeValues,
} from './form-dom.js';
import {
  buildPayload,
  collectErrors,
  defaultValues,
  fallbackFileName,
  verificationFromHeaders,
  verificationOf,
  verificationWarning,
} from './form-logic.js';

const TOOL_API = '/api/tools/wall-quantity-calculator';

let config = null;
let building = null;
let values = {};
let core = null; // 計算実装（wasm）。サーバーと同じバイト列。
let result = null; // 最後に計算した出力結果。

function showMessage(text, color) {
  const msg = document.getElementById('message');
  msg.style.color = color;
  msg.innerText = text;
}

function showErrors(errors) {
  const box = document.getElementById('errors');
  box.textContent = '';
  box.hidden = errors.length === 0;
  errors.forEach((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    box.appendChild(li);
  });
}

function formRoot() {
  return document.getElementById('formArea');
}

/** 今の入力を読み、連動と入力可否を整えてから覚えておく。 */
function syncFromDom() {
  values = { ...values, ...readValues(formRoot()) };
  values = refresh(formRoot(), config, building, values);
  writeValues(formRoot(), values);
  recalculate();
}

/**
 * 今の入力で計算し、出力結果を描き直す。
 *
 * 入力が足りないところは配布物と同じく空欄になるだけなので、編集の途中でも
 * そのまま呼べる（往復が無いので、打つたびに呼んでも速い）。
 */
function recalculate() {
  const area = document.getElementById('results');
  if (!core || !building) return;
  try {
    result = core.call({
      op: 'wallQuantity',
      data: buildPayload(config, building, values),
    }).result;
  } catch (error) {
    // 計算実装が入力を受け取れないとき（用途が未選択など）は、
    // その場で直せる案内を出す。
    result = null;
    area.textContent = '';
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = error.message;
    area.appendChild(hint);
    return;
  }
  area.textContent = '';
  area.appendChild(buildResults(document, result));
}

function renderBuilding(key) {
  building = key;
  const root = formRoot();
  root.textContent = '';
  root.appendChild(buildForm(document, config, key));

  // 建物を切り替えても、共通の項目（作成者・用途など）は引き継ぐ。
  const defaults = defaultValues(config, key);
  values = { ...defaults, ...pickKnown(values, defaults) };
  writeValues(root, values);
  syncFromDom();
  showErrors([]);
}

/** 前の建物の入力のうち、新しい建物にも同じ key がある分だけ残す。 */
function pickKnown(previous, defaults) {
  const kept = {};
  Object.keys(defaults).forEach((key) => {
    if (previous[key] !== undefined && previous[key] !== '') kept[key] = previous[key];
  });
  if (previous.usage) kept.usage = previous.usage;
  if (previous.property_name) kept.property_name = previous.property_name;
  return kept;
}

async function submitForm() {
  const btn = document.getElementById('submitBtn');
  syncFromDom();

  const errors = collectErrors(config, building, values);
  showErrors(errors);
  if (errors.length > 0) {
    // 折り畳んだ節の中に入力漏れが隠れないよう、その節を開いてから知らせる。
    revealMissingFields(formRoot());
    showMessage('入力を確認してください。', 'red');
    return;
  }

  btn.disabled = true;
  btn.innerText = '作成中...';
  showMessage('', '#333');
  try {
    const payload = {
      ...buildPayload(config, building, values),
      // 画面で見えていた出力結果。サーバーが同じ .wasm で計算し直して
      // 突き合わせ、食い違えば応答ヘッダで知らせてくる。
      verify: core ? verificationOf(core.version, result) : undefined,
    };
    const { blob, fileName, headers } = await apiPostForBlob(
      `${TOOL_API}/worksheets`,
      payload,
      fallbackFileName(config, building, values.property_name)
    );

    const link = document.createElement('a');
    link.href = window.URL.createObjectURL(blob);
    link.download = fileName;
    link.click();

    const warning = verificationWarning(verificationFromHeaders(headers));
    showErrors(warning ? [warning] : []);
    showMessage(`ダウンロードが完了しました（${fileName}）。`, 'green');
  } catch (error) {
    showMessage('ファイルの生成に失敗しました: ' + error.message, 'red');
  } finally {
    btn.disabled = false;
    btn.innerText = 'Excel出力';
  }
}

function renderWorksheetInfo() {
  const info = config.worksheet;
  const chip = document.getElementById('worksheetInfo');
  chip.textContent = '';
  const version = document.createElement('span');
  version.className = 'name';
  version.textContent = info.version || '版の記載なし';
  chip.appendChild(version);
  const link = document.createElement('a');
  link.href = info.pageUrl;
  link.target = '_blank';
  link.rel = 'noreferrer noopener';
  link.textContent = '配布元';
  chip.appendChild(link);
  chip.title = `${info.name}（${info.publisher}）`;
}

async function start() {
  if (redirectToCanonicalHost()) return;

  const clerk = await requireSignIn();
  if (!clerk) return;

  try {
    config = await apiGet(`${TOOL_API}/config`);
    // 計算実装（wasm）。サーバーが自分の計算に使っているものと同じバイト列で、
    // URL には中身のハッシュが付いている（変わらないうちはキャッシュから）。
    core = await loadCore(config.core.url, apiGetBytes);
  } catch (error) {
    showMessage(error.message, 'red');
    return;
  }

  renderWorksheetInfo();

  const selector = document.getElementById('buildingSelect');
  config.buildings.forEach((b) => {
    const option = document.createElement('option');
    option.value = b.key;
    option.textContent = b.label;
    selector.appendChild(option);
  });
  selector.value = config.buildings[0].key;
  selector.addEventListener('change', () => renderBuilding(selector.value));

  // 入力のたびに連動プルダウンと入力可否を整え、出力結果を計算し直す。
  formRoot().addEventListener('change', syncFromDom);
  formRoot().addEventListener('input', (event) => {
    if (event.target && event.target.dataset && event.target.dataset.field) {
      values[event.target.dataset.field] = event.target.value;
      // 数値欄は打っている間 change が来ないので、ここでも計算する。
      recalculate();
    }
  });
  document.getElementById('submitBtn').addEventListener('click', submitForm);

  renderBuilding(selector.value);
  document.getElementById('submitBtn').disabled = false;
}

start().catch(function (error) {
  showMessage(error.message, 'red');
});
