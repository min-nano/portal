// 見積書 作成ツール。
//
// 設計等業務の見積書を作り、PDF で Drive へ保存する。ファイル操作の考え方は
// 他の PDF ツールと同じ「新規作成 / 開く / 保存 / 別名で保存」で、共通部分は
// ../pdf-file-ops.js・../save-dialogs.js にある。
//
// 編集中の計算は画面の中で完結する（../core.js が読み込む wasm を呼ぶだけで、
// 入力のたびの往復が無い）。その wasm はサーバが計算に使っているものと同じ
// バイト列なので、計算の実装は 1 つしかない。保存のときはサーバも同じ計算を
// して、画面が出していた金額と突き合わせる（食い違えば警告を出す）。
//
// 耐震診断・耐震補強設計は、平成27年国土交通省告示第670号の標準業務人・時間数
// から参考額を出せる。**出るのは参考額**で、押して初めて単価に入る。人件費
// 単価と技術料等経費率は告示に定めが無く、共有設定の値を使う。
//
// 成果物の PDF そのものが保存形式。フォーム入力は PDF の文書情報へ埋め込まれる
// ので、保存した見積書を開き直せば続きを編集できる。

import '../styles.css';
import './tool.css';
import '../components/index.js';
import { startPage } from '../page-start.js';
import { apiGet, apiGetBytes, apiPostFile, apiSendJson } from '../api.js';
import { pickFile, preloadPicker } from '../google-picker.js';
import { askSaveAs, askUnsaved } from '../save-dialogs.js';
import {
  canOverwrite,
  confirmSaveMessage,
  ensurePdfExtension,
  saveHintMessage,
  saveModeFor,
  unsavedPromptMessage,
} from '../pdf-file-ops.js';
import {
  applyForm,
  applySettings,
  readForm,
  readSettings,
  renderItems,
  renderSeismicEstimate,
  renderTotals,
  showOfficeChip,
  syncItems,
} from './form-dom.js';
import {
  applySuggestions,
  canRemoveItem,
  defaultSaveName,
  emptyFormData,
  formSignature,
  issuerHint,
  makeItem,
  mergeFormData,
  seismicWorkOf,
  toRequestBody,
  verificationOf,
  verificationWarning,
} from './form-logic.js';
import { loadCore } from '../core.js';

const TOOL_API = '/api/tools/quotation-formatter';
const PDF_MIME = 'application/pdf';

// 打鍵のたびに描き直さないよう、ひと呼吸おいてからまとめて計算する。
const CALCULATE_DEBOUNCE_MS = 60;

let config = null; // /config の応答（業務のテンプレート・選択肢・計算実装の在り処）
let core = null; // 計算実装（wasm）。サーバと同じバイト列。
let settings = null; // 共有設定（事務所の情報・定型文・単価）
let data = null; // 画面が編集中の見積書
let computed = { items: [], totals: {} }; // 金額の計算結果
let suggestionMemo = {}; // 明細の key → 直前に配った品名・摘要の候補
let calculateTimer = null;

let sourceFile = null; // 開いているファイル（Drive 上の PDF）。{ id, name }
let documentName = ''; // 今開いている文書の名前。保存ダイアログの初期値。
let lastFolder = null; // 直前に保存したフォルダ（続けて保存するとき用）。
let savedSignature = ''; // 最後に保存・読み込みした時点の内容。

function showMessage(text, color) {
  const msg = document.getElementById('message');
  msg.style.color = color;
  msg.innerText = text;
}

function showResult(link, fileName) {
  const box = document.getElementById('result');
  const anchor = document.getElementById('resultLink');
  box.hidden = !link;
  if (link) {
    anchor.href = link;
    anchor.textContent = `Google Drive で「${fileName}」を開く`;
  }
}

// --- 画面 ↔ データ ----------------------------------------------------------

/** 明細の入力欄を組み立て直す（行が増減したとき・業務を変えたとき）。 */
function rebuildItems() {
  renderItems(document, data.items, config);
  calculate();
}

/** 見積書の全体を入力欄へ写す（読み込み・新規作成のとき）。 */
function renderAll() {
  applyForm(document, data, config);
  renderItems(document, data.items, config);
  showIssuerHint();
  calculate();
}

function showIssuerHint() {
  const hint = document.getElementById('issuerHint');
  const message = issuerHint(data);
  hint.hidden = !message;
  hint.textContent = message;
}

// --- 計算（画面の中で完結する） ---------------------------------------------

function scheduleCalculate() {
  clearTimeout(calculateTimer);
  calculateTimer = setTimeout(calculate, CALCULATE_DEBOUNCE_MS);
}

/** 今の入力を計算し直す（待ちが入っていれば、それを取り消して今すぐ行う）。 */
function calculate() {
  clearTimeout(calculateTimer);
  // 計算実装を受け取る前に打ち込まれた分。読み込めたところで描き直される。
  if (!core) return;
  readForm(document, data);

  try {
    const body = toRequestBody(data);
    // 品名と摘要の候補。書き換えていない欄だけが、これに追従する。
    const suggestions = core.call({
      op: 'quotationSuggest',
      data: { ...body, terms: (settings && settings.terms) || {} },
    }).suggestions;
    const applied = applySuggestions(data.items, suggestionMemo, suggestions);
    data.items = applied.items;
    suggestionMemo = applied.memo;

    computed = core.call({ op: 'quotation', data: toRequestBody(data) });
  } catch (error) {
    computed = { items: [], totals: {}, warnings: [] };
    showMessage(error.message, 'red');
  }

  syncItems(document, data.items, computed);
  renderTotals(document, computed);
  showIssuerHint();
  updateSeismicEstimates();
}

/** 耐震の明細それぞれについて、告示第670号による参考額を出し直す。 */
function updateSeismicEstimates() {
  if (!core) return;
  data.items.forEach((item, index) => {
    const work = seismicWorkOf(config.templates, item.templateId);
    if (!work) return;
    let estimate;
    try {
      estimate = core.call({
        op: 'seismicFee',
        data: {
          work,
          // 別表第一（S 造・RC 造・SRC 造）は未実装なので、戸建木造のみ。
          structure: 'detached-timber-house',
          floorArea: item.spec.floorArea,
          inspectionCost: item.spec.inspectionCost,
          specialCost: item.spec.specialCost,
          settings: (settings && settings.fee) || {},
        },
      });
    } catch (error) {
      estimate = { applicable: false, reason: error.message, rows: [] };
    }
    renderSeismicEstimate(document, index, estimate);
  });
}

/** 参考額を、その明細の単価へ入れる（入れたあとは手で直せる）。 */
function applySeismicFee(index) {
  // 打鍵の直後に押されることがあるので、待ちに入っている読み取りを先に済ませる。
  readForm(document, data);
  const item = data.items[index];
  const work = seismicWorkOf(config.templates, item.templateId);
  if (!work) return;
  const estimate = core.call({
    op: 'seismicFee',
    data: {
      work,
      structure: 'detached-timber-house',
      floorArea: item.spec.floorArea,
      inspectionCost: item.spec.inspectionCost,
      specialCost: item.spec.specialCost,
      settings: (settings && settings.fee) || {},
    },
  });
  if (!estimate.applicable) return;
  const field = document.querySelector(
    `[data-item-index="${index}"] [data-field="unitPrice"]`
  );
  if (field) field.value = String(estimate.amount);
  calculate();
}

// --- 明細の増減 --------------------------------------------------------------

function addItem() {
  readForm(document, data);
  if (data.items.length >= (config.maxItems || 40)) {
    showMessage(`明細は ${config.maxItems} 行までです。`, 'red');
    return;
  }
  data.items.push(makeItem(data.items[data.items.length - 1]));
  rebuildItems();
}

function removeItem(index) {
  if (!canRemoveItem(data)) return;
  readForm(document, data);
  data.items.splice(index, 1);
  rebuildItems();
}

/** 手で書き換えた品名・摘要を捨てて、候補に戻す。 */
function resetItemText(index) {
  readForm(document, data);
  data.items[index] = { ...data.items[index], title: '', body: '' };
  delete suggestionMemo[data.items[index].key];
  syncItems(document, data.items, computed);
  calculate();
}

function watchInputs() {
  const form = document.getElementById('quotationForm');
  form.addEventListener('input', scheduleCalculate);
  form.addEventListener('change', (event) => {
    // 業務を変えると、出す入力欄そのものが変わる（設計方法 ↔ 診断法、
    // 告示第670号の参考額の有無）ので、その行を組み立て直す。
    if (event.target.dataset && event.target.dataset.field === 'templateId') {
      readForm(document, data);
      rebuildItems();
      return;
    }
    scheduleCalculate();
  });
  // 明細の行は数が変わるので、行ごとではなく容器で受ける。
  form.addEventListener('click', (event) => {
    const dataset = event.target.dataset || {};
    if (dataset.removeItem !== undefined) removeItem(Number(dataset.removeItem));
    else if (dataset.resetItem !== undefined) resetItemText(Number(dataset.resetItem));
    else if (dataset.applyFee !== undefined) applySeismicFee(Number(dataset.applyFee));
  });

  document.getElementById('addItemBtn').addEventListener('click', addItem);
  document.getElementById('expiryBtn').addEventListener('click', () => {
    readForm(document, data);
    const suggested = core.call({ op: 'quotation', data: toRequestBody(data) })
      .suggestedExpiresOn;
    if (suggested) {
      document.getElementById('expiresOn').value = suggested;
      calculate();
    }
  });
  document.getElementById('loadOfficeBtn').addEventListener('click', () => {
    readForm(document, data);
    data.issuer = { ...emptyFormData(settings).issuer };
    applyForm(document, data, config);
    calculate();
  });
}

// --- 設定 -------------------------------------------------------------------

function openSettings() {
  const dialog = document.getElementById('settingsDialog');
  applySettings(document, settings, config);
  document.getElementById('settingsMessage').textContent = '';
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

async function saveSettings() {
  const message = document.getElementById('settingsMessage');
  message.textContent = '保存しています...';
  try {
    settings = await apiSendJson(`${TOOL_API}/settings`, 'PUT', readSettings(document));
    showOfficeChip(document, settings);
    document.getElementById('settingsDialog').close();
    showMessage('設定を保存しました。', 'green');
    // 定型文と単価が変われば、候補と参考額も変わる。
    calculate();
  } catch (error) {
    message.textContent = error.message;
  }
}

function watchSettings() {
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('settingsSaveBtn').addEventListener('click', saveSettings);
  document
    .getElementById('settingsCancelBtn')
    .addEventListener('click', () => document.getElementById('settingsDialog').close());
}

// --- Drive からの選択（公式 Google Picker） ---------------------------------

const PICKERS = {
  source: { title: '編集する見積書 PDF を選択', mimeTypes: PDF_MIME },
  destination: { title: 'PDF の保存先フォルダを選択', selectFolder: true },
};

async function chooseFromDrive(kind) {
  try {
    return await pickFile(PICKERS[kind]);
  } catch (error) {
    showMessage(error.message, 'red');
    return null;
  }
}

// --- 開いているファイル -----------------------------------------------------

function setSourceFile(file) {
  sourceFile = file;
  document.getElementById('sourceName').textContent = file
    ? file.name
    : 'なし（新規作成）';
  document.getElementById('submitBtn').innerText = canOverwrite(file)
    ? '上書き保存'
    : '保存';
  document.getElementById('saveHint').textContent = saveHintMessage(file);

  const note = document.getElementById('sourceNote');
  note.hidden = Boolean(file) || !documentName;
  note.textContent = note.hidden
    ? ''
    : 'アップロードした PDF は Drive 上のファイルではないため、上書きはできません。' +
      '「保存」を押すと保存先を選んで新しいファイルとして保存します。';
}

function markSaved() {
  readForm(document, data);
  savedSignature = formSignature(data);
}

function hasUnsavedChanges() {
  if (!data) return false;
  readForm(document, data);
  return formSignature(data) !== savedSignature;
}

async function confirmDiscardChanges(action) {
  if (!hasUnsavedChanges()) return true;
  const choice = await askUnsaved(unsavedPromptMessage(sourceFile, action));
  if (choice === 'cancel') return false;
  if (choice === 'save') return saveCurrent();
  return true;
}

async function newDocument() {
  if (!(await confirmDiscardChanges('新規作成'))) return;
  data = emptyFormData(settings);
  suggestionMemo = {};
  documentName = '';
  setSourceFile(null);
  renderAll();
  showResult('', '');
  showMessage('新規作成にしました。', '#333');
  markSaved();
}

function applyParsed(parsed) {
  data = mergeFormData(parsed);
  suggestionMemo = {};
  documentName = parsed.suggestedFileName || '';
  setSourceFile(parsed.file && parsed.file.id ? parsed.file : null);
  renderAll();
  showResult('', '');
  showMessage('読み込みました。内容を編集して保存してください。', 'green');
  markSaved();
}

async function openFromDrive() {
  if (!(await confirmDiscardChanges('読み込み'))) return;
  const file = await chooseFromDrive('source');
  if (!file) return;
  showMessage('読み込んでいます...', '#333');
  try {
    applyParsed(
      await apiSendJson(`${TOOL_API}/quotations/parse-drive`, 'POST', { fileId: file.id })
    );
  } catch (error) {
    showMessage(error.message, 'red');
  }
}

async function openUploaded() {
  if (!(await confirmDiscardChanges('読み込み'))) return;
  document.getElementById('uploadInput').click();
}

async function uploadFile(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  // 同じファイルを選び直したときも change が起きるようにしておく。
  event.target.value = '';
  showMessage('PDF を読み込んでいます...', '#333');
  try {
    applyParsed(await apiPostFile(`${TOOL_API}/quotations/parse`, file));
  } catch (error) {
    showMessage(error.message, 'red');
  }
}

// --- 保存 -------------------------------------------------------------------

function saveCurrent() {
  return save(saveModeFor(sourceFile));
}

async function save(mode) {
  // 待ちに入っている再計算を先に済ませ、画面に出ている金額と、これから
  // サーバへ「画面はこう計算した」と伝える値を揃える。
  calculate();

  if (mode === 'overwrite') {
    const fileName = sourceFile.name;
    if (!window.confirm(confirmSaveMessage(mode, fileName, sourceFile))) return false;
    return sendSaveRequest({ mode, fileName, fileId: sourceFile.id });
  }

  const chosen = await askSaveAs({
    title: canOverwrite(sourceFile) ? '別名で保存' : '保存',
    defaultName: defaultSaveName(computed, documentName),
    initialFolder: lastFolder,
    pickFolder: () => chooseFromDrive('destination'),
    ensureName: (name) => ensurePdfExtension(name, config.default_file_name),
  });
  if (!chosen) return false; // ダイアログをキャンセルした。
  lastFolder = chosen.folder;
  return sendSaveRequest({
    mode: 'new',
    fileName: chosen.fileName,
    folderId: chosen.folder.id,
  });
}

async function sendSaveRequest(saveSpec) {
  const buttons = [
    document.getElementById('submitBtn'),
    document.getElementById('saveAsBtn'),
  ];
  buttons.forEach((b) => {
    b.disabled = true;
  });
  buttons[0].innerText = '作成中...';
  showMessage('', '#333');
  showResult('', '');
  try {
    const result = await apiSendJson(`${TOOL_API}/quotations`, 'POST', {
      ...toRequestBody(data),
      save: saveSpec,
      verify: verificationOf(core.version, computed),
    });
    const warning = verificationWarning(result.verification);
    const saved =
      saveSpec.mode === 'overwrite'
        ? `上書き保存しました: ${result.fileName}`
        : `保存しました: ${result.fileName}`;
    showMessage(warning ? `${saved}\n${warning}` : saved, warning ? '#b45309' : 'green');
    showResult(result.webViewLink, result.fileName);
    // 保存したファイルを、そのまま「開いているファイル」として続けて編集できる
    // ようにする（次の「保存」はこのファイルへの上書きになる）。
    documentName = result.fileName;
    setSourceFile({ id: result.fileId, name: result.fileName });
    markSaved();
    return true;
  } catch (error) {
    showMessage('見積書の作成に失敗しました: ' + error.message, 'red');
    return false;
  } finally {
    buttons.forEach((b) => {
      b.disabled = false;
    });
    setSourceFile(sourceFile);
  }
}

// --- 初期化 -----------------------------------------------------------------

async function prepare() {
  // Picker の準備は、ボタンが押される前に始めておく（google-picker.js 参照）。
  preloadPicker();

  document.getElementById('newBtn').addEventListener('click', newDocument);
  document.getElementById('loadBtn').addEventListener('click', openFromDrive);
  document.getElementById('uploadBtn').addEventListener('click', openUploaded);
  document.getElementById('uploadInput').addEventListener('change', uploadFile);
  document.getElementById('submitBtn').addEventListener('click', saveCurrent);
  document.getElementById('saveAsBtn').addEventListener('click', () => save('new'));
  watchInputs();
  watchSettings();

  // ページを閉じる・再読み込みするときも、未保存の入力があれば引き止める。
  window.addEventListener('beforeunload', (event) => {
    if (!hasUnsavedChanges()) return;
    event.preventDefault();
    event.returnValue = '';
  });

  [config, settings] = await Promise.all([
    apiGet(`${TOOL_API}/config`),
    apiGet(`${TOOL_API}/settings`),
  ]);
  // 計算実装（wasm）は、サーバが自分の計算に使っているものと同じバイト列。
  core = await loadCore(config.core.url, apiGetBytes);

  showOfficeChip(document, settings);
  data = emptyFormData(settings);
  setSourceFile(null);
  renderAll();
  // 組み立て直後の状態を基準にする（これ以降の入力が「未保存の変更」）。
  markSaved();
}

startPage({ prepare, usesApi: true, preparing: '見積書の準備をしています…' });
