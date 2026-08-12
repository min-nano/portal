// 面材張り耐力要素 釘配列諸定数 計算ツール。
//
// グレー本『木造軸組工法住宅の許容応力度設計』3.2 節に沿って、釘配列諸定数
// Ixy・Zxy・Cxy を求める。編集中の計算は画面の中で完結する（./core.js が
// 読み込む wasm を呼ぶだけで、入力のたびの往復が無い）。その wasm は
// サーバが計算に使っているものと同じバイト列なので、計算の実装は 1 つしかない。
//
// 保存のときはサーバも同じ計算をして、画面が出していた値と突き合わせる。
// 食い違えば警告を出す（計算書に載るのはサーバの値）。
//
// GAS 版はスプレッドシートへ現在値と履歴を書き出していたが、ここでは
// 構造計算安全証明書と同じく **成果物の PDF そのものが保存形式**になる。
// フォーム入力は PDF の文書情報へ埋め込まれるので、保存した PDF を開き直せば
// 続きを編集できる。ファイル操作の考え方も証明書と同じ「新規作成 / 開く /
// 保存 / 別名で保存」で、共通部分は ../pdf-file-ops.js・../save-dialogs.js。
//
// 釘配列諸定数（3.2）に続けて、その配列を面材として選ぶ **面材張り大壁**
// （3.3）の面内せん断剛性 K と許容せん断耐力 Pa も求める。
//
// 1 ファイル = 1 物件。計算書 PDF は「1 ページ = 1 パターン」に続けて
// 「1 ページ = 1 壁」を並べる。物件の中の複数パターン・複数の壁は、それぞれ
// ページ送りで切り替えて編集する。

import '../styles.css';
import { requireSignIn } from '../auth.js';
import { redirectToCanonicalHost } from '../canonical-host.js';
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
  applyPattern,
  applyWall,
  readPattern,
  readWall,
  renderGradeOptions,
  renderMaterialOptions,
  renderPatternBar,
  renderPresetOptions,
  renderResult,
  renderWallBar,
  renderWallPanels,
  renderWallResult,
  showPanelArea,
  syncNailModeVisibility,
} from './form-dom.js';
import {
  canRemovePattern,
  canRemoveWall,
  defaultSaveName,
  emptyFormData,
  formSignature,
  indexAfterRemoval,
  makePattern,
  makeWall,
  mergeFormData,
  panelChoices,
  patternLabel,
  toRequestBody,
  verificationOf,
  verificationWarning,
  wallFieldsFromGrade,
  wallFieldsFromMaterial,
  wallLabel,
} from './form-logic.js';
import { loadCore } from './core.js';

const TOOL_API = '/api/tools/timber-panel-shear-calculator';
const PDF_MIME = 'application/pdf';

// 打鍵のたびに描き直さないよう、ひと呼吸おいてからまとめて計算する。
// 計算そのものは手元で一瞬（往復が無い）なので、GAS 版の 300ms より短くて
// よい。ここで抑えているのは、釘が多いときの再描画の回数。
const CALCULATE_DEBOUNCE_MS = 60;

let config = null; // /config の応答（既定ファイル名・計算実装の在り処）
let core = null; // 計算実装（wasm）。サーバと同じバイト列。
let data = null; // 画面が編集中の内容 { projectName, issuedOn, patterns, walls }
let currentIndex = 0;
let currentWallIndex = 0;
let reports = { patterns: [], walls: [] }; // パターン・壁ごとの計算結果
let materials = []; // グレー本 表 3.3.1 の面材と釘の組合せ
let grades = []; // グレー本 表 3.3.2 の面材の規格
let panelChoiceSignature = ''; // 壁の面材として選べるパターンの一覧（前回の内容）
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

function currentPattern() {
  return data.patterns[currentIndex];
}

function currentWall() {
  return data.walls[currentWallIndex] || null;
}

/** 入力欄の内容を、編集中のパターン・壁へ書き戻す。 */
function captureCurrentPattern() {
  Object.assign(currentPattern(), readPattern(document));
  const wall = currentWall();
  if (wall) Object.assign(wall, readWall(document));
  data.projectName = document.getElementById('projectName').value.trim();
  data.issuedOn = document.getElementById('issuedOn').value;
}

/** 編集中のパターン・壁を入力欄へ写し、タブと計算結果を描き直す。 */
function renderCurrent() {
  document.getElementById('projectName').value = data.projectName;
  document.getElementById('issuedOn').value = data.issuedOn;
  applyPattern(document, currentPattern());
  renderPatternBar(document, data.patterns, currentIndex, goToPattern);
  applyWall(document, currentWall(), panelChoices(data));
  panelChoiceSignature = JSON.stringify(panelChoices(data));
  renderWallBar(document, data.walls, currentWallIndex, goToWall);
  renderCurrentResult();
}

function renderCurrentResult() {
  const pattern = currentPattern();
  const report =
    reports.patterns.find((r) => r && r.patternId === pattern.patternId) || null;
  renderResult(document, report, pattern);

  const wall = currentWall();
  renderWallResult(
    document,
    wall ? reports.walls.find((r) => r && r.wallId === wall.wallId) || null : null
  );
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

// --- 壁（グレー本 3.3） -----------------------------------------------------

function goToWall(index) {
  if (index < 0 || index >= data.walls.length || index === currentWallIndex) return;
  captureCurrentPattern();
  currentWallIndex = index;
  renderCurrent();
}

function addWall() {
  captureCurrentPattern();
  data.walls.push(makeWall());
  currentWallIndex = data.walls.length - 1;
  renderCurrent();
  scheduleCalculate();
}

function removeWall() {
  if (!canRemoveWall(data)) return;
  const name = wallLabel(currentWall(), currentWallIndex);
  if (!window.confirm(`「${name}」を削除します。よろしいですか？`)) return;
  data.walls.splice(currentWallIndex, 1);
  currentWallIndex = indexAfterRemoval(currentWallIndex, data.walls.length);
  renderCurrent();
  scheduleCalculate();
}

/** 面材の行を 1 つ増やす（どのパターンを使うかは、そのあと選んでもらう）。 */
function addWallPanel() {
  const wall = currentWall();
  if (!wall) return;
  captureCurrentPattern();
  wall.panels.push({ patternId: '' });
  renderCurrent();
}

function removeWallPanel(index) {
  const wall = currentWall();
  if (!wall) return;
  captureCurrentPattern();
  wall.panels.splice(index, 1);
  renderCurrent();
  scheduleCalculate();
}

/**
 * グレー本 表 3.3.1 の面材と釘の組合せを、今の壁の入力欄へ読み込む。
 *
 * 表 3.3.2 の既定の規格（構造用合板なら JAS 1 級）も一緒に入るので、この
 * 1 回でせん断破壊・せん断座屈の検定に要る τmax・E1・E2 までそろう。
 */
function loadMaterial(id) {
  const wall = currentWall();
  const material = materials.find((entry) => entry.id === id);
  if (!wall || !material) return;
  captureCurrentPattern();
  Object.assign(wall, wallFieldsFromMaterial(material));
  renderCurrent();
  scheduleCalculate();
}

/** グレー本 表 3.3.2 の面材の規格を、今の壁の入力欄へ読み込む。 */
function loadGrade(id) {
  const wall = currentWall();
  const grade = grades.find((entry) => entry.id === id);
  if (!wall || !grade) return;
  captureCurrentPattern();
  Object.assign(wall, wallFieldsFromGrade(grade));
  renderCurrent();
  scheduleCalculate();
}

/**
 * グレー本 表 3.2.1 の標準的な釘配列を、今のパターンへ読み込む。
 *
 * 釘座標は計算実装（wasm）が組み立てる。表に載っているのは Ixy・Zxy・Cxy
 * だけなので、そこから配列を起こす規則も計算と同じ場所に置いてある。
 *
 * 解説（図 3.2.2）の計算例もこの一覧の中にある（910×610 横置・川型）ので、
 * 計算例だけを読み込む専用の操作は置いていない。
 */
function loadPreset(id) {
  if (!id || !core) return;
  Object.assign(currentPattern(), core.preset(id));
  renderCurrent();
  scheduleCalculate();
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
  captureCurrentPattern();
  renderPatternBar(document, data.patterns, currentIndex, goToPattern);
  try {
    reports = core.computeAll(toRequestBody(data));
  } catch (error) {
    // パターン・壁ごとの不備は ok: false として返るので、ここへ来るのは
    // 入力全体が壊れている場合（数値でない寸法など）。
    reports = { patterns: [], walls: [] };
    showMessage(error.message, 'red');
  }
  // パターン名を変えると、壁の面材の選択肢の表示も変わる。入力欄そのものは
  // 書き戻さない（打鍵のたびに value を入れ直すとカーソルが飛ぶ）ので、
  // 選択肢が変わったときだけ面材の行を描き直す。
  const signature = JSON.stringify(panelChoices(data));
  const wall = currentWall();
  if (wall && signature !== panelChoiceSignature) {
    renderWallPanels(document, wall.panels, panelChoices(data));
  }
  panelChoiceSignature = signature;
  renderCurrentResult();
}

/** 入力欄の変更を拾う。値の解釈は計算実装に任せ、ここでは再計算を促すだけ。 */
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
  // 面材の行は数が変わるので、行ごとではなく容器で受ける。
  form.addEventListener('click', (event) => {
    const index = event.target.getAttribute
      ? event.target.getAttribute('data-remove-wall-panel')
      : null;
    if (index !== null) removeWallPanel(Number(index));
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
  currentWallIndex = 0;
  reports = { patterns: [], walls: [] };
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
  currentWallIndex = 0;
  reports = { patterns: [], walls: [] };
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
  // 待ちに入っている再計算を先に済ませ、画面に出ている値と、これから
  // サーバへ「画面はこう計算した」と伝える値を揃える。
  calculate();

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
      // サーバにも同じ計算をさせ、画面の値と突き合わせてもらう。
      verify: verificationOf(core.version, reports),
    });
    const warning = verificationWarning(result.verification);
    const saved =
      saveSpec.mode === 'overwrite'
        ? `上書き保存しました: ${result.fileName}`
        : `保存しました: ${result.fileName}`;
    showMessage(
      warning ? `${saved}\n${warning}` : saved,
      warning ? '#b45309' : 'green'
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
  document.getElementById('presetSelect').addEventListener('change', (event) => {
    loadPreset(event.target.value);
    // 読み込んだあとは、続けて同じものを選び直せるように戻しておく
    //（入力欄を手で直したあと、もう一度読み込みたいことがある）。
    event.target.value = '';
  });
  document.getElementById('addPatternBtn').addEventListener('click', addPattern);
  document.getElementById('removePatternBtn').addEventListener('click', removePattern);
  document
    .getElementById('prevBtn')
    .addEventListener('click', () => goToPattern(currentIndex - 1));
  document
    .getElementById('nextBtn')
    .addEventListener('click', () => goToPattern(currentIndex + 1));
  document.getElementById('addWallBtn').addEventListener('click', addWall);
  document.getElementById('removeWallBtn').addEventListener('click', removeWall);
  document.getElementById('addWallPanelBtn').addEventListener('click', addWallPanel);
  document
    .getElementById('wallPrevBtn')
    .addEventListener('click', () => goToWall(currentWallIndex - 1));
  document
    .getElementById('wallNextBtn')
    .addEventListener('click', () => goToWall(currentWallIndex + 1));
  document.getElementById('materialSelect').addEventListener('change', (event) => {
    loadMaterial(event.target.value);
  });
  document.getElementById('gradeSelect').addEventListener('change', (event) => {
    loadGrade(event.target.value);
  });
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
    // 計算実装（wasm）は、サーバが自分の計算に使っているものと同じバイト列。
    // URL に中身のハッシュが付いているので、版が変われば必ず取り直される。
    core = await loadCore(config.core.url, apiGetBytes);
  } catch (error) {
    showMessage(error.message, 'red');
    return;
  }

  // 呼び出せる釘配列（グレー本 表 3.2.1）と、面材と釘の組合せ（同 表 3.3.1）は
  // どちらも計算実装が持っている。
  renderPresetOptions(document, core.presets());
  materials = core.materials();
  renderMaterialOptions(document, materials);
  grades = core.grades();
  renderGradeOptions(document, grades);

  data = emptyFormData();
  setSourceFile(null);
  renderCurrent();
  // 組み立て直後の状態を基準にする（これ以降の入力が「未保存の変更」）。
  markSaved();
}

start().catch(function (error) {
  showMessage(error.message, 'red');
});
