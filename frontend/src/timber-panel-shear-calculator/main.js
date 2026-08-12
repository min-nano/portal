// 面材張り耐力要素 釘配列諸定数 計算ツール。
//
// グレー本『木造軸組工法住宅の許容応力度設計』3.2 節に沿って、釘配列諸定数
// Ixy・Zxy・Cxy を求める。計算は入力のたびにバックエンドへ問い合わせ、
// 返ってきた値をそのまま並べる（画面と計算書 PDF で数値が食い違わないよう、
// 計算も桁の丸めもサーバ側の唯一の実装に任せる）。
//
// GAS 版はスプレッドシートへ現在値と履歴を書き出していたが、ここでは
// 構造計算安全証明書と同じく **成果物の PDF そのものが保存形式**になる。
// フォーム入力は PDF の文書情報へ埋め込まれるので、保存した PDF を開き直せば
// 続きを編集できる。ファイル操作の考え方も証明書と同じ「新規作成 / 開く /
// 保存 / 別名で保存」で、共通部分は ../pdf-file-ops.js・../save-dialogs.js。
//
// 1 ファイル = 1 物件、1 ページ = 1 パターン。物件の中の複数パターンは
// ページ送りで切り替えて編集する。

import '../styles.css';
import { requireSignIn } from '../auth.js';
import { redirectToCanonicalHost } from '../canonical-host.js';
import { apiGet, apiPostFile, apiSendJson } from '../api.js';
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
  applyPattern,
  readPattern,
  renderPatternBar,
  renderResult,
  showPanelArea,
  syncNailModeVisibility,
} from './form-dom.js';
import {
  canRemovePattern,
  defaultSaveName,
  emptyFormData,
  formSignature,
  indexAfterRemoval,
  makePattern,
  mergeFormData,
  patternLabel,
  toRequestBody,
} from './form-logic.js';

const TOOL_API = '/api/tools/timber-panel-shear-calculator';
const PDF_MIME = 'application/pdf';

// 入力のたびに計算を投げないよう、GAS 版と同じ間隔でまとめる。
const CALCULATE_DEBOUNCE_MS = 300;

let config = null; // /config の応答（既定ファイル名・計算例）
let data = null; // 画面が編集中の内容 { projectName, issuedOn, patterns }
let currentIndex = 0;
let reports = []; // /calculations の応答（パターンごとの計算結果）
let calculateTimer = null;
let calculateSequence = 0; // 応答の追い越しを捨てるための通し番号

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

function currentPattern() {
  return data.patterns[currentIndex];
}

/** 入力欄の内容を、編集中のパターンへ書き戻す。 */
function captureCurrentPattern() {
  Object.assign(currentPattern(), readPattern(document));
  data.projectName = document.getElementById('projectName').value.trim();
  data.issuedOn = document.getElementById('issuedOn').value;
}

/** 編集中のパターンを入力欄へ写し、タブと計算結果を描き直す。 */
function renderCurrent() {
  document.getElementById('projectName').value = data.projectName;
  document.getElementById('issuedOn').value = data.issuedOn;
  applyPattern(document, currentPattern());
  renderPatternBar(document, data.patterns, currentIndex, goToPattern);
  renderCurrentResult();
}

function renderCurrentResult() {
  const pattern = currentPattern();
  const report = reports.find((r) => r && r.patternId === pattern.patternId) || null;
  renderResult(document, report, pattern);
}

function goToPattern(index) {
  if (index < 0 || index >= data.patterns.length || index === currentIndex) return;
  captureCurrentPattern();
  currentIndex = index;
  renderCurrent();
}

function addPattern() {
  captureCurrentPattern();
  data.patterns.push(makePattern());
  currentIndex = data.patterns.length - 1;
  renderCurrent();
  scheduleCalculate();
}

function removePattern() {
  if (!canRemovePattern(data)) return;
  const name = patternLabel(currentPattern(), currentIndex);
  if (!window.confirm(`「${name}」を削除します。よろしいですか？`)) return;
  data.patterns.splice(currentIndex, 1);
  currentIndex = indexAfterRemoval(currentIndex, data.patterns.length);
  renderCurrent();
  scheduleCalculate();
}

/** グレー本 解説の計算例を、今のパターンへ読み込む。 */
function loadExample() {
  Object.assign(currentPattern(), config.example);
  renderCurrent();
  scheduleCalculate();
}

// --- 計算（入力のたびにサーバへ問い合わせる） -------------------------------

function scheduleCalculate() {
  clearTimeout(calculateTimer);
  calculateTimer = setTimeout(calculate, CALCULATE_DEBOUNCE_MS);
}

async function calculate() {
  captureCurrentPattern();
  renderPatternBar(document, data.patterns, currentIndex, goToPattern);
  const sequence = ++calculateSequence;
  try {
    const response = await apiSendJson(
      `${TOOL_API}/calculations`,
      'POST',
      toRequestBody(data)
    );
    // 入力が続いていて新しい問い合わせが出ていれば、古い応答は捨てる。
    if (sequence !== calculateSequence) return;
    reports = response.patterns || [];
    renderCurrentResult();
  } catch (error) {
    if (sequence !== calculateSequence) return;
    reports = [];
    renderCurrentResult();
    showMessage(error.message, 'red');
  }
}

/** 入力欄の変更を拾う。値の解釈はサーバに任せ、ここでは再計算を促すだけ。 */
function watchInputs() {
  const form = document.getElementById('calcForm');
  form.addEventListener('input', (event) => {
    if (event.target.name === 'nailMode') syncNailModeVisibility(document);
    showPanelArea(document);
    scheduleCalculate();
  });
  form.addEventListener('change', (event) => {
    if (event.target.name === 'nailMode') syncNailModeVisibility(document);
    scheduleCalculate();
  });
}

// --- Drive からの選択（公式 Google Picker） ---------------------------------

const PICKERS = {
  source: { title: '編集する計算書 PDF を選択', mimeTypes: PDF_MIME },
  destination: { title: 'PDF の保存先フォルダを選択', selectFolder: true },
};

/** Picker を開いて選択結果を返す。キャンセル・失敗はどちらも null。 */
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

/** 今の内容を「保存済み」として覚える（以降の変更が未保存の変更になる）。 */
function markSaved() {
  captureCurrentPattern();
  savedSignature = formSignature(data);
}

function hasUnsavedChanges() {
  if (!data) return false;
  captureCurrentPattern();
  return formSignature(data) !== savedSignature;
}

/**
 * 未保存の入力があるまま別のファイルへ移ってよいかを尋ねる。
 * 続けてよければ true、取りやめなら false。
 */
async function confirmDiscardChanges(action) {
  if (!hasUnsavedChanges()) return true;
  const choice = await askUnsaved(unsavedPromptMessage(sourceFile, action));
  if (choice === 'cancel') return false;
  if (choice === 'save') return saveCurrent();
  return true;
}

async function newDocument() {
  if (!(await confirmDiscardChanges('新規作成'))) return;
  data = emptyFormData();
  currentIndex = 0;
  reports = [];
  documentName = '';
  setSourceFile(null);
  renderCurrent();
  showResult('', '');
  showMessage('新規作成にしました。', '#333');
  markSaved();
  scheduleCalculate();
}

function applyParsed(parsed) {
  data = mergeFormData(parsed);
  currentIndex = 0;
  reports = [];
  documentName = parsed.suggestedFileName || '';
  setSourceFile(parsed.file && parsed.file.id ? parsed.file : null);
  renderCurrent();
  showResult('', '');
  showMessage('読み込みました。内容を編集して保存してください。', 'green');
  markSaved();
  scheduleCalculate();
}

async function openFromDrive() {
  if (!(await confirmDiscardChanges('読み込み'))) return;
  const file = await chooseFromDrive('source');
  if (!file) return;
  showMessage('読み込んでいます...', '#333');
  try {
    applyParsed(
      await apiSendJson(`${TOOL_API}/reports/parse-drive`, 'POST', { fileId: file.id })
    );
  } catch (error) {
    showMessage(error.message, 'red');
  }
}

// Drive ではなく手元の PDF から読み込む経路。Picker の「アップロード」は
// Drive へ保存してしまうため、解析するだけのこちらは別に用意する。
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
    applyParsed(await apiPostFile(`${TOOL_API}/reports/parse`, file));
  } catch (error) {
    showMessage(error.message, 'red');
  }
}

// --- 保存 -------------------------------------------------------------------

/** 「保存」。開いているファイルがあれば上書き、なければ保存先を選んで新規保存。 */
function saveCurrent() {
  return save(saveModeFor(sourceFile));
}

/** 保存する。保存できたら true。 */
async function save(mode) {
  captureCurrentPattern();

  if (mode === 'overwrite') {
    // 上書きは同じファイルへの書き戻しなので、名前も場所も尋ねない。
    const fileName = sourceFile.name;
    if (!window.confirm(confirmSaveMessage(mode, fileName, sourceFile))) return false;
    return sendSaveRequest({ mode, fileName, fileId: sourceFile.id });
  }

  const chosen = await askSaveAs({
    title: canOverwrite(sourceFile) ? '別名で保存' : '保存',
    defaultName: defaultSaveName(config, data, documentName),
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
    const result = await apiSendJson(`${TOOL_API}/reports`, 'POST', {
      ...toRequestBody(data),
      save: saveSpec,
    });
    showMessage(
      saveSpec.mode === 'overwrite'
        ? `上書き保存しました: ${result.fileName}`
        : `保存しました: ${result.fileName}`,
      'green'
    );
    showResult(result.webViewLink, result.fileName);
    // 保存したファイルを、そのまま「開いているファイル」として続けて編集できる
    // ようにする（次の「保存」はこのファイルへの上書きになる）。
    documentName = result.fileName;
    setSourceFile({ id: result.fileId, name: result.fileName });
    markSaved();
    return true;
  } catch (error) {
    showMessage('計算書の作成に失敗しました: ' + error.message, 'red');
    return false;
  } finally {
    buttons.forEach((b) => {
      b.disabled = false;
    });
    // 保存に成功していれば、ここでのラベルは「上書き保存」に変わる。
    setSourceFile(sourceFile);
  }
}

// --- 初期化 -----------------------------------------------------------------

async function start() {
  // .web.app へのアクセスはカスタムドメインへ寄せる。リダイレクト中は
  // Clerk を初期化しない（別ドメインでセッションを持たせないため）。
  if (redirectToCanonicalHost()) return;

  const clerk = await requireSignIn();
  if (!clerk) return; // サインイン画面を表示中。

  // Picker の準備は、ボタンが押される前に始めておく（google-picker.js 参照）。
  preloadPicker();

  document.getElementById('newBtn').addEventListener('click', newDocument);
  document.getElementById('loadBtn').addEventListener('click', openFromDrive);
  document.getElementById('uploadBtn').addEventListener('click', openUploaded);
  document.getElementById('uploadInput').addEventListener('change', uploadFile);
  document.getElementById('submitBtn').addEventListener('click', saveCurrent);
  document.getElementById('saveAsBtn').addEventListener('click', () => save('new'));
  document.getElementById('exampleBtn').addEventListener('click', loadExample);
  document.getElementById('addPatternBtn').addEventListener('click', addPattern);
  document.getElementById('removePatternBtn').addEventListener('click', removePattern);
  document
    .getElementById('prevBtn')
    .addEventListener('click', () => goToPattern(currentIndex - 1));
  document
    .getElementById('nextBtn')
    .addEventListener('click', () => goToPattern(currentIndex + 1));
  watchInputs();

  // ページを閉じる・再読み込みするときも、未保存の入力があれば引き止める。
  window.addEventListener('beforeunload', (event) => {
    if (!hasUnsavedChanges()) return;
    event.preventDefault();
    // 文面はブラウザが決める（returnValue は古いブラウザ向けの作法）。
    event.returnValue = '';
  });

  try {
    config = await apiGet(`${TOOL_API}/config`);
  } catch (error) {
    showMessage(error.message, 'red');
    return;
  }

  data = emptyFormData();
  setSourceFile(null);
  renderCurrent();
  // 組み立て直後の状態を基準にする（これ以降の入力が「未保存の変更」）。
  markSaved();
}

start().catch(function (error) {
  showMessage(error.message, 'red');
});
