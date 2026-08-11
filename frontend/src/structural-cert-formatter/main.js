// 構造計算安全証明書 作成ツール。
//
// Google ドキュメントの雛形（{{…}} のプレースホルダー）をバックエンドが
// 実データで差し替えて PDF 化し、選んだ選択肢に印（番号は ○、□ はレ点）を
// 描き込んで Drive へ保存する。フォームの項目定義は /config が配信する
// （雛形マッピングが単一の情報源で、この画面には項目を持たない）。
//
// 作成だけでなく編集にも対応する。Drive 上の PDF を選ぶか、手元の PDF を
// アップロードすると内容を解析してフォームへ流し込み、一部を直して
// 上書き（版履歴が残る）または別名で保存できる。

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
  mergeFormData,
  suggestedFileName,
  validateFormData,
} from './form-logic.js';

const TOOL_API = '/api/tools/structural-cert-formatter';

const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
const PDF_MIME = 'application/pdf';

let config = null; // /config の応答（text_fields / choice_groups / sections）
let settings = null; // /settings の応答（雛形・保存先の設定状態）
let sourceFile = null; // 編集元（Drive 上の PDF）。{ id, name }
// ファイル名を利用者が触ったら、以降は自動更新しない。
let fileNameEdited = false;

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
  const ready =
    Boolean(config) &&
    Boolean(settings) &&
    settings.template.configured &&
    (settings.outputFolder.configured || currentSaveMode() === 'overwrite');
  document.getElementById('submitBtn').disabled = !ready;
}

// --- 設定（雛形・保存先） ---------------------------------------------------

async function refreshSettings() {
  const templateEl = document.getElementById('templateName');
  const folderEl = document.getElementById('outputFolderName');
  try {
    settings = await apiGet(`${TOOL_API}/settings`);
  } catch (error) {
    templateEl.textContent = error.message;
    templateEl.className = 'unset';
    folderEl.textContent = '';
    updateSubmitState();
    return;
  }

  templateEl.textContent = settings.template.configured
    ? settings.template.fileName
    : '未設定（「雛形を設定」から選択してください）';
  templateEl.className = settings.template.configured ? 'name' : 'unset';

  folderEl.textContent = settings.outputFolder.configured
    ? settings.outputFolder.folderName
    : '未設定（「保存先を設定」から選択してください）';
  folderEl.className = settings.outputFolder.configured ? 'name' : 'unset';
  updateSubmitState();
}

// --- Drive からの選択（公式 Google Picker） ---------------------------------

// 雛形・保存先フォルダ・編集する PDF の 3 用途。選ぶ画面は Picker に任せ、
// ここでは「何を選ばせるか」と「選ばれた後に何をするか」だけを持つ。
const PICKERS = {
  template: {
    title: '雛形（Google ドキュメント）を選択',
    mimeTypes: GOOGLE_DOC_MIME,
    select: async (file) => {
      const result = await apiSendJson(`${TOOL_API}/template`, 'PUT', {
        fileId: file.id,
      });
      await refreshSettings();
      showMessage(`雛形を設定しました: ${result.fileName}`, 'green');
    },
  },
  outputFolder: {
    title: 'PDF の保存先フォルダを選択',
    selectFolder: true,
    select: async (file) => {
      const result = await apiSendJson(`${TOOL_API}/output-folder`, 'PUT', {
        folderId: file.id,
      });
      await refreshSettings();
      showMessage(`保存先を設定しました: ${result.folderName}`, 'green');
    },
  },
  source: {
    title: '編集する証明書 PDF を選択',
    mimeTypes: PDF_MIME,
    select: async (file) => {
      const parsed = await apiSendJson(`${TOOL_API}/certificates/parse-drive`, 'POST', {
        fileId: file.id,
      });
      applyParsed(parsed);
    },
  },
};

async function chooseFromDrive(kind) {
  const target = PICKERS[kind];
  let file;
  try {
    file = await pickFile({
      title: target.title,
      mimeTypes: target.mimeTypes,
      selectFolder: target.selectFolder,
    });
  } catch (error) {
    showMessage(error.message, 'red');
    return;
  }
  if (!file) return; // Picker をキャンセルした。

  showMessage('読み込んでいます...', '#333');
  try {
    await target.select(file);
  } catch (error) {
    showMessage(error.message, 'red');
  }
}

// Drive ではなく手元の PDF から読み込む経路。Picker の「アップロード」は
// Drive へ保存してしまうため、解析するだけのこちらは別に用意する。
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

function currentSaveMode() {
  const checked = document.querySelector('input[name="saveMode"]:checked');
  return checked ? checked.value : 'new';
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

// --- 編集元 -----------------------------------------------------------------

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
}

function setSourceFile(file, parsed) {
  sourceFile = file;
  const nameEl = document.getElementById('sourceName');
  const noteEl = document.getElementById('sourceNote');
  const overwrite = document.getElementById('overwriteMode');

  nameEl.textContent = file ? file.name : 'なし（新規作成）';
  overwrite.disabled = !canOverwrite(file);
  document.getElementById('overwriteLabel').textContent = file
    ? `上書き保存（${file.name}）`
    : '上書き保存（Drive から読み込んだファイルのみ）';
  if (!canOverwrite(file)) {
    document.querySelector('input[name="saveMode"][value="new"]').checked = true;
  }

  if (parsed && parsed.source === 'content') {
    noteEl.hidden = false;
    noteEl.textContent =
      'このツール以外で作られた PDF のため、本文から内容を推定して読み込みました。';
  } else if (parsed && !file) {
    noteEl.hidden = false;
    noteEl.textContent =
      'アップロードした PDF は Drive 上のファイルではないため、上書き保存はできません。' +
      '別名で保存してください。';
  } else {
    noteEl.hidden = true;
    noteEl.textContent = '';
  }
  updateSubmitState();
}

function resetToNew() {
  applyToForm(emptyFormData(config));
  prefillToday();
  setSourceFile(null, null);
  fileNameEdited = false;
  refreshFileNameSuggestion();
  showWarnings([]);
  showResult('', '');
  showMessage('新規作成に戻しました。', '#333');
}

// --- 保存 -------------------------------------------------------------------

async function submitForm() {
  const btn = document.getElementById('submitBtn');
  const data = collectFormData();
  const mode = currentSaveMode();

  const missing = validateFormData(config, data);
  if (missing.length > 0) {
    showMessage('次の項目を入力してください: ' + missing.join('、'), 'red');
    return;
  }

  const fileName = ensurePdfExtension(
    document.getElementById('fileName').value,
    config.default_file_name
  );
  document.getElementById('fileName').value = fileName;

  if (!window.confirm(confirmSaveMessage(mode, fileName, sourceFile))) return;

  btn.disabled = true;
  btn.innerText = '作成中...';
  showMessage('', '#333');
  showWarnings([]);
  showResult('', '');
  try {
    const save = { mode, fileName };
    if (mode === 'overwrite') save.fileId = sourceFile.id;
    const result = await apiSendJson(`${TOOL_API}/certificates`, 'POST', {
      ...data,
      save,
    });
    showMessage(
      mode === 'overwrite'
        ? `上書き保存しました: ${result.fileName}`
        : `保存しました: ${result.fileName}`,
      'green'
    );
    showWarnings(result.warnings);
    showResult(result.webViewLink, result.fileName);
    // 保存したファイルは、そのまま続けて上書き編集できる状態にする。
    setSourceFile({ id: result.fileId, name: result.fileName }, null);
  } catch (error) {
    showMessage('PDF の作成に失敗しました: ' + error.message, 'red');
  } finally {
    btn.disabled = false;
    btn.innerText = 'PDF を作成して保存';
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

  document.getElementById('templateBtn').addEventListener('click', () => chooseFromDrive('template'));
  document.getElementById('outputFolderBtn').addEventListener('click', () => chooseFromDrive('outputFolder'));
  document.getElementById('loadBtn').addEventListener('click', () => chooseFromDrive('source'));
  document.getElementById('resetBtn').addEventListener('click', resetToNew);
  const uploadInput = document.getElementById('uploadInput');
  document.getElementById('uploadBtn').addEventListener('click', () => uploadInput.click());
  uploadInput.addEventListener('change', uploadFile);
  document.getElementById('submitBtn').addEventListener('click', submitForm);
  document.getElementById('fileName').addEventListener('input', () => {
    fileNameEdited = true;
  });
  document.querySelectorAll('input[name="saveMode"]').forEach((radio) => {
    radio.addEventListener('change', updateSubmitState);
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
  updateSubmitState();
}

start().catch(function (error) {
  showMessage(error.message, 'red');
});
