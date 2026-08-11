// 構造計算安全証明書 作成ツール。
//
// Google ドキュメントの雛形（{{…}} のプレースホルダー）をバックエンドが
// 実データで差し替えて PDF 化し、選んだ選択肢に印（番号は ○、□ はレ点）を
// 描き込んで Drive へ保存する。フォームの項目定義は /config が配信する
// （雛形マッピングが単一の情報源で、この画面には項目を持たない）。
//
// 作成だけでなく編集にも対応する。ファイル操作の考え方は通常のアプリと同じで、
// 「新規作成 / 開く / 保存 / 別名で保存」の 4 つ。開いているファイルがあれば
// 保存はそこへの上書き（Drive の版履歴が残る）、新規保存・別名保存のときだけ
// 保存する場所を Picker で選ぶ。未保存のまま別のファイルへ移ろうとしたときは、
// 保存するかどうかを尋ねる。

import '../styles.css';
import { requireSignIn } from '../auth.js';
import { redirectToCanonicalHost } from '../canonical-host.js';
import { apiGet, apiPostFile, apiSendJson } from '../api.js';
import { pickFile, preloadPicker } from '../google-picker.js';
import {
  applyFormData,
  buildForm as buildFormInto,
  collectFormData as collectFormDataFrom,
  syncFieldsFromPicker,
} from './form-dom.js';
import {
  canOverwrite,
  confirmSaveMessage,
  emptyFormData,
  ensurePdfExtension,
  formSignature,
  mergeFormData,
  saveHintMessage,
  saveModeFor,
  suggestedFileName,
  unsavedPromptMessage,
  validateFormData,
} from './form-logic.js';

const TOOL_API = '/api/tools/structural-cert-formatter';

const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
const PDF_MIME = 'application/pdf';

let config = null; // /config の応答（text_fields / choice_groups / sections）
let settings = null; // /settings の応答（雛形の設定状態）
let sourceFile = null; // 開いているファイル（Drive 上の PDF）。{ id, name }
// ファイル名を利用者が触ったら、以降は自動更新しない。
let fileNameEdited = false;
// 最後に保存・読み込みした時点のフォーム内容。今の内容と違えば未保存の変更がある。
let savedSignature = '';

function showMessage(text, color) {
  const msg = document.getElementById('message');
  msg.style.color = color;
  msg.innerText = text;
}

function showWarnings(warnings) {
  const list = document.getElementById('warnings');
  list.innerHTML = '';
  list.hidden = !warnings || warnings.length === 0;
  (warnings || []).forEach((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    list.appendChild(li);
  });
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

function updateSubmitState() {
  const ready = Boolean(config) && Boolean(settings) && settings.template.configured;
  document.getElementById('submitBtn').disabled = !ready;
  document.getElementById('saveAsBtn').disabled = !ready;
}

// --- 設定（雛形） -----------------------------------------------------------

// 表示はタイトル横の狭い場所なので、名前は 1 行に収めて省略する
// （全体は title 属性でホバー時に読める）。
function showTemplateName(text, configured) {
  const el = document.getElementById('templateName');
  el.textContent = text;
  el.title = text;
  el.className = configured ? 'name' : 'unset';
}

async function refreshSettings() {
  try {
    settings = await apiGet(`${TOOL_API}/settings`);
  } catch (error) {
    // 狭い表示欄に長い文言は入らないので、理由は画面下のメッセージ欄に出す。
    showTemplateName('取得できません', false);
    showMessage(error.message, 'red');
    updateSubmitState();
    return;
  }

  showTemplateName(
    settings.template.configured ? settings.template.fileName : '未設定',
    settings.template.configured
  );
  updateSubmitState();
}

// --- Drive からの選択（公式 Google Picker） ---------------------------------

// 雛形・開く PDF・保存先フォルダの 3 用途。選ぶ画面は Picker に任せ、
// ここでは「何を選ばせるか」だけを持つ。選ばれた後の処理は呼び出し側。
const PICKERS = {
  template: {
    title: '雛形（Google ドキュメント）を選択',
    mimeTypes: GOOGLE_DOC_MIME,
  },
  source: {
    title: '編集する証明書 PDF を選択',
    mimeTypes: PDF_MIME,
  },
  destination: {
    title: 'PDF の保存先フォルダを選択',
    selectFolder: true,
  },
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

async function chooseTemplate() {
  const file = await chooseFromDrive('template');
  if (!file) return;
  showMessage('雛形を設定しています...', '#333');
  try {
    const result = await apiSendJson(`${TOOL_API}/template`, 'PUT', {
      fileId: file.id,
    });
    await refreshSettings();
    showMessage(`雛形を設定しました: ${result.fileName}`, 'green');
  } catch (error) {
    showMessage(error.message, 'red');
  }
}

async function openFromDrive() {
  if (!(await confirmDiscardChanges('読み込み'))) return;
  const file = await chooseFromDrive('source');
  if (!file) return;
  showMessage('読み込んでいます...', '#333');
  try {
    const parsed = await apiSendJson(`${TOOL_API}/certificates/parse-drive`, 'POST', {
      fileId: file.id,
    });
    applyParsed(parsed);
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
  showMessage('PDF を解析しています...', '#333');
  try {
    const parsed = await apiPostFile(`${TOOL_API}/certificates/parse`, file);
    applyParsed(parsed);
  } catch (error) {
    showMessage(error.message, 'red');
  }
}

// --- フォームの組み立て -----------------------------------------------------

function sectionsRoot() {
  return document.getElementById('sections');
}

function buildForm() {
  buildFormInto(sectionsRoot(), config);
  // 日付ピッカーの選択は、証明書に刷る和暦の欄へその都度書き戻す。
  const picker = sectionsRoot().querySelector('[data-date-picker]');
  if (picker) {
    picker.addEventListener('change', () => syncFieldsFromPicker(sectionsRoot()));
  }
}

function collectFormData() {
  return collectFormDataFrom(sectionsRoot(), config);
}

function applyToForm(data) {
  applyFormData(sectionsRoot(), data);
}

// 証明日は当日であることがほとんどなので、新規作成では今日を入れておく。
function prefillToday() {
  const root = sectionsRoot();
  const picker = root.querySelector('[data-date-picker]');
  if (!picker || picker.value) return;
  const now = new Date();
  picker.value =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}` +
    `-${String(now.getDate()).padStart(2, '0')}`;
  syncFieldsFromPicker(root);
}

function refreshFileNameSuggestion() {
  if (fileNameEdited) return;
  const input = document.getElementById('fileName');
  input.value = suggestedFileName(
    config.file_name_template,
    collectFormData(),
    config.default_file_name
  );
}

// --- 開いているファイル -----------------------------------------------------

function applyParsed(parsed) {
  applyToForm(mergeFormData(config, parsed));
  setSourceFile(parsed.file && parsed.file.id ? parsed.file : null, parsed);
  if (parsed.suggestedFileName) {
    document.getElementById('fileName').value = parsed.suggestedFileName;
    fileNameEdited = true;
  }
  showWarnings(parsed.warnings);
  showResult('', '');
  showMessage('読み込みました。内容を編集して保存してください。', 'green');
  markSaved();
}

function setSourceFile(file, parsed) {
  sourceFile = file;
  const noteEl = document.getElementById('sourceNote');

  document.getElementById('sourceName').textContent = file
    ? file.name
    : 'なし（新規作成）';
  refreshSaveButtons();

  if (parsed && parsed.source === 'content') {
    noteEl.hidden = false;
    noteEl.textContent =
      'このツール以外で作られた PDF のため、本文から内容を推定して読み込みました。';
  } else if (parsed && !file) {
    noteEl.hidden = false;
    noteEl.textContent =
      'アップロードした PDF は Drive 上のファイルではないため、上書きはできません。' +
      '「保存」を押すと保存先を選んで新しいファイルとして保存します。';
  } else {
    noteEl.hidden = true;
    noteEl.textContent = '';
  }
  updateSubmitState();
}

// 保存先は開いているファイルそのものなので、「保存」の意味もそれに合わせる。
function refreshSaveButtons() {
  document.getElementById('submitBtn').innerText = canOverwrite(sourceFile)
    ? '上書き保存'
    : '保存';
  document.getElementById('saveHint').textContent = saveHintMessage(sourceFile);
}

/** 今の内容を「保存済み」として覚える（以降の変更が未保存の変更になる）。 */
function markSaved() {
  savedSignature = formSignature(
    collectFormData(),
    document.getElementById('fileName').value
  );
}

function hasUnsavedChanges() {
  if (!config) return false;
  return (
    formSignature(collectFormData(), document.getElementById('fileName').value) !==
    savedSignature
  );
}

/**
 * 未保存の入力があるまま別のファイルへ移ってよいかを尋ねる。
 *
 * 通常のアプリと同じ 3 択で、「保存する」を選んだら保存まで済ませてから進む。
 * 続けてよければ true、取りやめなら false。
 */
async function confirmDiscardChanges(action) {
  if (!hasUnsavedChanges()) return true;
  const choice = await askUnsaved(unsavedPromptMessage(sourceFile, action));
  if (choice === 'cancel') return false;
  if (choice === 'save') return saveCurrent();
  return true;
}

function askUnsaved(message) {
  const dialog = document.getElementById('unsavedDialog');
  document.getElementById('unsavedMessage').textContent = message;
  // <dialog> を開けない環境では、保存の有無までは選べないので破棄の確認だけ行う。
  if (typeof dialog.showModal !== 'function') {
    return Promise.resolve(
      window.confirm(`${message}\n\n（OK で保存せずに進みます）`) ? 'discard' : 'cancel'
    );
  }
  return new Promise((resolve) => {
    // 選ばれた時点で、この 1 回分の待ち受けをまとめて解除する。
    const listening = new AbortController();
    const finish = (choice) => {
      listening.abort();
      dialog.close();
      resolve(choice);
    };
    dialog.querySelectorAll('[data-choice]').forEach((button) => {
      button.addEventListener('click', () => finish(button.dataset.choice), {
        signal: listening.signal,
      });
    });
    // Esc キーで閉じたときは「キャンセル」と同じ扱いにする。
    dialog.addEventListener(
      'cancel',
      (event) => {
        event.preventDefault();
        finish('cancel');
      },
      { signal: listening.signal }
    );
    dialog.showModal();
  });
}

async function newDocument() {
  if (!(await confirmDiscardChanges('新規作成'))) return;
  applyToForm(emptyFormData(config));
  prefillToday();
  setSourceFile(null, null);
  fileNameEdited = false;
  refreshFileNameSuggestion();
  showWarnings([]);
  showResult('', '');
  showMessage('新規作成にしました。', '#333');
  markSaved();
}

// --- 保存 -------------------------------------------------------------------

/** 「保存」。開いているファイルがあれば上書き、なければ保存先を選んで新規保存。 */
function saveCurrent() {
  return save(saveModeFor(sourceFile));
}

/** 保存する。保存できたら true。 */
async function save(mode) {
  const data = collectFormData();

  const missing = validateFormData(config, data);
  if (missing.length > 0) {
    showMessage('次の項目を入力してください: ' + missing.join('、'), 'red');
    return false;
  }

  const fileName = ensurePdfExtension(
    document.getElementById('fileName').value,
    config.default_file_name
  );
  document.getElementById('fileName').value = fileName;

  const saveSpec = { mode, fileName };
  if (mode === 'overwrite') {
    // 上書きは取り消しづらいので、対象を明示して確認する。
    if (!window.confirm(confirmSaveMessage(mode, fileName, sourceFile))) return false;
    saveSpec.fileId = sourceFile.id;
  } else {
    // 新規保存・別名保存は、通常のアプリの「保存ダイアログ」にあたる Picker で
    // 保存する場所をそのつど選ぶ（設定として固定しない）。
    const folder = await chooseFromDrive('destination');
    if (!folder) return false; // Picker をキャンセルした。
    saveSpec.folderId = folder.id;
  }

  return sendSaveRequest(data, saveSpec);
}

async function sendSaveRequest(data, saveSpec) {
  const buttons = [
    document.getElementById('submitBtn'),
    document.getElementById('saveAsBtn'),
  ];
  buttons.forEach((b) => {
    b.disabled = true;
  });
  buttons[0].innerText = '作成中...';
  showMessage('', '#333');
  showWarnings([]);
  showResult('', '');
  try {
    const result = await apiSendJson(`${TOOL_API}/certificates`, 'POST', {
      ...data,
      save: saveSpec,
    });
    showMessage(
      saveSpec.mode === 'overwrite'
        ? `上書き保存しました: ${result.fileName}`
        : `保存しました: ${result.fileName}`,
      'green'
    );
    showWarnings(result.warnings);
    showResult(result.webViewLink, result.fileName);
    // 保存したファイルを、そのまま「開いているファイル」として続けて編集できる
    // ようにする（次の「保存」はこのファイルへの上書きになる）。
    setSourceFile({ id: result.fileId, name: result.fileName }, null);
    markSaved();
    return true;
  } catch (error) {
    showMessage('PDF の作成に失敗しました: ' + error.message, 'red');
    return false;
  } finally {
    buttons.forEach((b) => {
      b.disabled = false;
    });
    // 保存に成功していれば、ここでのラベルは「上書き保存」に変わる。
    refreshSaveButtons();
    updateSubmitState();
  }
}

// --- 初期化 -----------------------------------------------------------------

async function start() {
  // .web.app へのアクセスはカスタムドメインへ寄せる。リダイレクト中は
  // Clerk を初期化しない（別ドメインでセッションを持たせないため）。
  if (redirectToCanonicalHost()) return;

  const clerk = await requireSignIn();
  if (!clerk) return; // サインイン画面を表示中。

  // Picker の準備（設定の取得と Google のスクリプトの読み込み）は、ボタンが
  // 押される前に始めておく（google-picker.js のコメント参照）。
  preloadPicker();

  document.getElementById('templateBtn').addEventListener('click', chooseTemplate);
  document.getElementById('newBtn').addEventListener('click', newDocument);
  document.getElementById('loadBtn').addEventListener('click', openFromDrive);
  document.getElementById('uploadBtn').addEventListener('click', openUploaded);
  document.getElementById('uploadInput').addEventListener('change', uploadFile);
  document.getElementById('submitBtn').addEventListener('click', saveCurrent);
  document.getElementById('saveAsBtn').addEventListener('click', () => save('new'));
  document.getElementById('fileName').addEventListener('input', () => {
    fileNameEdited = true;
  });

  // ページを閉じる・再読み込みするときも、未保存の入力があれば引き止める。
  window.addEventListener('beforeunload', (event) => {
    if (!hasUnsavedChanges()) return;
    event.preventDefault();
    // 文面はブラウザが決める（returnValue は古いブラウザ向けの作法）。
    event.returnValue = '';
  });

  try {
    const [loadedConfig] = await Promise.all([
      apiGet(`${TOOL_API}/config`),
      refreshSettings(),
    ]);
    config = loadedConfig;
  } catch (error) {
    showMessage(error.message, 'red');
    return;
  }

  buildForm();
  prefillToday();
  // 既定のファイル名に使う欄（雛形マッピングの file_name_template が参照する欄）を
  // 入力したら、ファイル名の候補も追従させる。
  (config.file_name_template.match(/\{([a-z_]+)\}/g) || []).forEach((token) => {
    const input = document.getElementById(`field-${token.slice(1, -1)}`);
    if (input) input.addEventListener('input', refreshFileNameSuggestion);
  });
  refreshFileNameSuggestion();
  setSourceFile(null, null);
  // 組み立て直後の状態を基準にする（これ以降の入力が「未保存の変更」）。
  markSaved();
  updateSubmitState();
}

start().catch(function (error) {
  showMessage(error.message, 'red');
});
