// 面材張り大壁 計算ツール。
//
// グレー本『木造軸組工法住宅の許容応力度設計』3.3 節に沿って、面材張り大壁の
// 面内せん断剛性 K と許容せん断耐力 Pa を求める。壁を構成する面材の釘配列
// 諸定数 Ixy・Zxy・Cxy（3.2 節）は、その壁の計算の一部として面材ごとに求める。
// 実際の設計では面材の種類と釘が先に決まっていて、面材の配置・釘の間隔・
// へりあきで調整するので、面材 1 枚の入力欄もその順番に並べてある。面材と釘
// の仕様は面材ごとの入力で、1 枚の壁の中で混在してよい（上半分は N50、
// 下半分は CN50 のような張り分け）。
//
// 編集中の計算は画面の中で完結する（../core.js が読み込む wasm を呼ぶだけで、
// 入力のたびの往復が無い）。その wasm はサーバが計算に使っているものと同じ
// バイト列なので、計算の実装は 1 つしかない。
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
// 1 ファイル = 1 物件。計算書 PDF は壁ごとに「面材 1 枚 = 1 ページ」を並べ、
// そのあとに「壁 = 1 ページ」を置く。物件の中の複数の壁は、ページ送りで
// 切り替えて編集する。

import '../styles.css';
import '../components/index.js';
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
  applyWall,
  readWall,
  renderWallBar,
  renderWallPanels,
  renderWallResult,
  showNailNotes,
  showPanelArea,
  syncNailModeVisibility,
} from './form-dom.js';
import {
  canRemoveWall,
  capturePanel,
  defaultSaveName,
  emptyFormData,
  formSignature,
  indexAfterRemoval,
  makePanel,
  makeWall,
  mergeFormData,
  minimumEdgeDistance,
  nailNote,
  panelFieldsFromGrade,
  panelFieldsFromMaterial,
  raiseEdgeDistance,
  specOf,
  toRequestBody,
  verificationOf,
  verificationWarning,
  wallLabel,
} from './form-logic.js';
import { loadCore } from '../core.js';

const TOOL_API = '/api/tools/timber-panel-shear-calculator';
const PDF_MIME = 'application/pdf';

// 打鍵のたびに描き直さないよう、ひと呼吸おいてからまとめて計算する。
// 計算そのものは手元で一瞬（往復が無い）なので、GAS 版の 300ms より短くて
// よい。ここで抑えているのは、釘が多いときの再描画の回数。
const CALCULATE_DEBOUNCE_MS = 60;

let config = null; // /config の応答（既定ファイル名・計算実装の在り処）
let core = null; // 計算実装（wasm）。サーバと同じバイト列。
let data = null; // 画面が編集中の内容 { projectName, issuedOn, walls }
let currentWallIndex = 0;
let reports = { walls: [] }; // 壁ごとの計算結果（面材ごとの結果もこの中）
let materials = []; // グレー本 表 3.3.1 の面材と釘の組合せ
let grades = []; // グレー本 表 3.3.2 の面材の規格
// 面材の入力欄が使う一覧（釘配列・割り付けの型・面材と釘・面材の規格）。
let panelOptions = { presets: [], arrangements: [], materials: [], grades: [] };
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

function currentWall() {
  return data.walls[currentWallIndex] || null;
}

/**
 * 入力欄の内容を、編集中の壁へ書き戻す。
 *
 * 書き戻すと面材はオブジェクトごと作り直されるので、1 枚を書き換えたい
 * ときは panelIndex を渡して **その面材を戻り値で受け取る**（先に取り出して
 * おいた面材へ書き換えても、この書き戻しで捨てられる）。
 */
function captureCurrentWall(panelIndex) {
  const wall = currentWall();
  const panel = wall ? capturePanel(wall, readWall(document), panelIndex) : null;
  data.projectName = document.getElementById('projectName').value.trim();
  data.issuedOn = document.getElementById('issuedOn').value;
  return panel;
}

/** 編集中の壁を入力欄へ写し、タブと計算結果を描き直す。 */
function renderCurrent() {
  document.getElementById('projectName').value = data.projectName;
  document.getElementById('issuedOn').value = data.issuedOn;
  applyWall(document, currentWall(), panelOptions);
  renderWallBar(document, data.walls, currentWallIndex, goToWall);
  showPanelNotes();
  renderCurrentResult();
}

/** 面材ごとの案内（選んだ釘の呼び径と、必要なへりあき）を出し直す。 */
function showPanelNotes() {
  showNailNotes(document, (materialId) => nailNote(materials, materialId));
}

function renderCurrentResult() {
  const wall = currentWall();
  renderWallResult(
    document,
    wall ? reports.walls.find((r) => r && r.wallId === wall.wallId) || null : null
  );
}

function goToWall(index) {
  if (index < 0 || index >= data.walls.length || index === currentWallIndex) return;
  captureCurrentWall();
  currentWallIndex = index;
  renderCurrent();
}

function addWall() {
  captureCurrentWall();
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

// --- 壁を構成する面材 -------------------------------------------------------

/**
 * 面材を 1 枚増やす（寸法・釘の間隔は、そのあと調整してもらう）。
 *
 * 面材と釘の仕様は面材ごとに決められるが、実際には壁の中で同じ仕様を使う
 * ことのほうが多いので、直前の面材の仕様を初期値として引き継ぐ（違う仕様に
 * するときは、その面材の欄で選び直す）。
 */
function addWallPanel() {
  const wall = currentWall();
  if (!wall) return;
  captureCurrentWall();
  const spec = specOf(wall.panels[wall.panels.length - 1]);
  // へりあきの初期値は、引き継いだ釘で決まる最小値（3.3(1)④）。
  wall.panels.push(
    makePanel({
      ...spec,
      edgeDistance: minimumEdgeDistance(materials, spec.materialId),
    })
  );
  redrawPanels();
}

function removeWallPanel(index) {
  const wall = currentWall();
  if (!wall) return;
  captureCurrentWall();
  wall.panels.splice(index, 1);
  redrawPanels();
}

/**
 * グレー本 表 3.2.1 の標準的な釘配列を、その面材の割り付けへ読み込む。
 *
 * 面材寸法・配列の型・間柱ピッチ・釘ピッチ・へりあきが入るので、読み込んだ
 * あとに実際の設計へ合わせて動かせる。釘座標そのものは計算実装（wasm）が
 * この割り付けから組み立てる。
 */
function loadPreset(index, id) {
  if (!id || !core) return;
  const panel = captureCurrentWall(index);
  if (!panel) return;
  Object.assign(panel, core.preset(id));
  // 表 3.2.1 の配列はへりあき 10 mm が前提なので、この面材の釘で必要な値に
  // 足りなければ引き上げる（適用範囲 3.3(1)④）。
  raiseEdgeDistance([panel], minimumEdgeDistance(materials, panel.materialId));
  redrawPanels();
}

/**
 * グレー本 表 3.3.1 の面材と釘の組合せを、その面材の入力欄へ読み込む。
 *
 * 表 3.3.2 の既定の規格（構造用合板なら JAS 1 級）も一緒に入るので、この
 * 1 回でせん断破壊・せん断座屈の検定に要る τmax・E1・E2 までそろう。
 * 読み込むのは選んだ面材 1 枚だけ（面材ごとに違う組合せを使えるため）。
 */
function loadMaterial(index, id) {
  const panel = captureCurrentWall(index);
  const material = materials.find((entry) => entry.id === id);
  if (!panel) return;
  if (material) {
    Object.assign(panel, panelFieldsFromMaterial(material));
    // 釘が変われば必要なへりあきも変わる（3.3(1)④）。足りなければ最小値まで
    // 引き上げる（設計者が広げた値は狭めない）。
    raiseEdgeDistance([panel], minimumEdgeDistance(materials, panel.materialId));
  }
  // 一覧の先頭（案内の行）へ戻したときは、読み込んだ跡だけが消えて数値は
  // 残る（4.5 の試験値として、そのまま手で直して使えるように）。
  redrawPanels();
}

/** グレー本 表 3.3.2 の面材の規格を、その面材の入力欄へ読み込む。 */
function loadGrade(index, id) {
  const panel = captureCurrentWall(index);
  const grade = grades.find((entry) => entry.id === id);
  if (!panel) return;
  if (grade) Object.assign(panel, panelFieldsFromGrade(grade));
  redrawPanels();
}

/** 面材の入力欄を描き直して、計算し直す（面材を書き換えたあとの後始末）。 */
function redrawPanels() {
  const wall = currentWall();
  if (!wall) return;
  renderWallPanels(document, wall.panels, panelOptions);
  showPanelNotes();
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
  captureCurrentWall();
  renderWallBar(document, data.walls, currentWallIndex, goToWall);
  try {
    reports = core.computeAll(toRequestBody(data));
  } catch (error) {
    // 壁ごとの不備は ok: false として返るので、ここへ来るのは入力全体が
    // 壊れている場合（数値でない寸法など）。
    reports = { walls: [] };
    showMessage(error.message, 'red');
  }
  renderCurrentResult();
}

/** 入力欄の変更を拾う。値の解釈は計算実装に任せ、ここでは再計算を促すだけ。 */
function watchInputs() {
  const form = document.getElementById('calcForm');
  form.addEventListener('input', (event) => {
    if (event.target.hasAttribute && event.target.hasAttribute('data-panel-mode')) {
      syncNailModeVisibility(document);
    }
    showPanelArea(document);
    scheduleCalculate();
  });
  form.addEventListener('change', (event) => {
    const target = event.target;
    if (target.hasAttribute && target.hasAttribute('data-panel-mode')) {
      syncNailModeVisibility(document);
    }
    const presetIndex = target.getAttribute
      ? target.getAttribute('data-panel-preset')
      : null;
    if (presetIndex !== null) {
      loadPreset(Number(presetIndex), target.value);
      // 読み込んだあとは、続けて同じものを選び直せるように戻しておく
      //（入力欄を手で直したあと、もう一度読み込みたいことがある）。
      target.value = '';
      return;
    }
    // 面材と釘・面材の規格の一覧は面材ごとにあるので、どの面材のものかを
    // 入れ物（data-panel-index）から取る。
    const field = target.getAttribute ? target.getAttribute('data-panel-field') : null;
    const owner = target.closest ? target.closest('[data-panel-index]') : null;
    if (owner && (field === 'materialId' || field === 'gradeId')) {
      const index = Number(owner.getAttribute('data-panel-index'));
      if (field === 'materialId') loadMaterial(index, target.value);
      else loadGrade(index, target.value);
      return;
    }
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
  captureCurrentWall();
  savedSignature = formSignature(data);
}

function hasUnsavedChanges() {
  if (!data) return false;
  captureCurrentWall();
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
  currentWallIndex = 0;
  reports = { walls: [] };
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
  currentWallIndex = 0;
  reports = { walls: [] };
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
  document.getElementById('addWallBtn').addEventListener('click', addWall);
  document.getElementById('removeWallBtn').addEventListener('click', removeWall);
  document.getElementById('addWallPanelBtn').addEventListener('click', addWallPanel);
  document
    .getElementById('wallPrevBtn')
    .addEventListener('click', () => goToWall(currentWallIndex - 1));
  document
    .getElementById('wallNextBtn')
    .addEventListener('click', () => goToWall(currentWallIndex + 1));
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

  // 呼び出せる釘配列（グレー本 表 3.2.1）・割り付けの型・面材と釘の組合せ
  //（同 表 3.3.1）・面材の規格（同 表 3.3.2）は、どれも計算実装が持っている。
  // どれも面材 1 枚ぶんの入力欄が使う（面材と釘は面材ごとに選べる）。
  materials = core.materials();
  grades = core.grades();
  panelOptions = {
    presets: core.presets(),
    arrangements: core.arrangements(),
    materials,
    grades,
  };

  data = emptyFormData();
  setSourceFile(null);
  renderCurrent();
  // 組み立て直後の状態を基準にする（これ以降の入力が「未保存の変更」）。
  markSaved();
  scheduleCalculate();
}

start().catch(function (error) {
  showMessage(error.message, 'red');
});
