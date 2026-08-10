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
import {
  applyFormData,
  buildForm as buildFormInto,
  collectFormData as collectFormDataFrom,
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

// --- Drive 選択ダイアログ ---------------------------------------------------

// 雛形・保存先フォルダ・編集する PDF の 3 用途で同じダイアログを使い回す。
let picker = null;

const PICKERS = {
  template: {
    title: '雛形（Google ドキュメント）を設定',
    hint:
      'Google Drive 上の雛形を名前で検索して選択します。記入欄が {{…}} の' +
      'プレースホルダーになっている Google ドキュメントを選んでください。',
    search: (q) => apiGet(`${TOOL_API}/template/candidates?q=${encodeURIComponent(q)}`),
    select: async (file) => {
      const result = await apiSendJson(`${TOOL_API}/template`, 'PUT', {
        fileId: file.id,
      });
      await refreshSettings();
      showMessage(`雛形を設定しました: ${result.fileName}`, 'green');
    },
  },
  outputFolder: {
    title: 'PDF の保存先フォルダを設定',
    hint: '作成した証明書 PDF を保存する Google Drive 上のフォルダを選択します。',
    search: (q) =>
      apiGet(`${TOOL_API}/output-folder/candidates?q=${encodeURIComponent(q)}`),
    select: async (file) => {
      const result = await apiSendJson(`${TOOL_API}/output-folder`, 'PUT', {
        folderId: file.id,
      });
      await refreshSettings();
      showMessage(`保存先を設定しました: ${result.folderName}`, 'green');
    },
  },
  source: {
    title: '編集する証明書 PDF を読み込む',
    hint: 'Google Drive 上の PDF を名前で検索して選択します。',
    upload: true,
    search: (q) => apiGet(`${TOOL_API}/pdf/candidates?q=${encodeURIComponent(q)}`),
    select: async (file) => {
      const parsed = await apiSendJson(`${TOOL_API}/certificates/parse-drive`, 'POST', {
        fileId: file.id,
      });
      applyParsed(parsed);
    },
  },
};

function openPicker(kind) {
  picker = PICKERS[kind];
  document.getElementById('pickerTitle').textContent = picker.title;
  document.getElementById('pickerHint').textContent = picker.hint;
  document.getElementById('pickerUpload').hidden = !picker.upload;
  document.getElementById('pickerFile').value = '';
  document.getElementById('pickerResults').innerHTML =
    '<p class="status">名前（の一部）を入力して検索してください。</p>';
  document.getElementById('pickerDialog').hidden = false;
  document.getElementById('pickerInput').focus();
}

function closePicker() {
  document.getElementById('pickerDialog').hidden = true;
}

async function searchPicker() {
  const query = document.getElementById('pickerInput').value.trim();
  const resultsEl = document.getElementById('pickerResults');
  if (!query) {
    resultsEl.innerHTML = '<p class="status">検索キーワードを入力してください。</p>';
    return;
  }
  resultsEl.innerHTML = '<p class="status">検索中...</p>';
  try {
    const { files } = await picker.search(query);
    if (files.length === 0) {
      resultsEl.innerHTML =
        '<p class="status">見つかりませんでした。あなたに閲覧権限のあるファイルだけが対象です。</p>';
      return;
    }
    resultsEl.innerHTML = '';
    files.forEach((file) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'template-result';
      const nameEl = document.createElement('div');
      nameEl.className = 'file-name';
      nameEl.textContent = file.name;
      const metaEl = document.createElement('div');
      metaEl.className = 'file-meta';
      metaEl.textContent = file.modifiedTime
        ? '更新: ' + new Date(file.modifiedTime).toLocaleString('ja-JP')
        : '';
      btn.append(nameEl, metaEl);
      btn.addEventListener('click', () => choosePickerFile(file));
      resultsEl.appendChild(btn);
    });
  } catch (error) {
    resultsEl.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'status';
    p.textContent = error.message;
    resultsEl.appendChild(p);
  }
}

async function choosePickerFile(file) {
  const chosen = picker;
  closePicker();
  showMessage('読み込んでいます...', '#333');
  try {
    await chosen.select(file);
  } catch (error) {
    showMessage(error.message, 'red');
  }
}

async function uploadPickerFile(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  closePicker();
  showMessage('PDF を解析しています...', '#333');
  try {
    const parsed = await apiPostFile(`${TOOL_API}/certificates/parse`, file);
    applyParsed(parsed);
  } catch (error) {
    showMessage(error.message, 'red');
  }
}

// --- フォームの組み立て -----------------------------------------------------

function buildForm() {
  buildFormInto(document.getElementById('sections'), config);
}

function collectFormData() {
  return collectFormDataFrom(document.getElementById('sections'), config);
}

function applyToForm(data) {
  applyFormData(document.getElementById('sections'), data);
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

  document.getElementById('templateBtn').addEventListener('click', () => openPicker('template'));
  document.getElementById('outputFolderBtn').addEventListener('click', () => openPicker('outputFolder'));
  document.getElementById('loadBtn').addEventListener('click', () => openPicker('source'));
  document.getElementById('resetBtn').addEventListener('click', resetToNew);
  document.getElementById('pickerCloseBtn').addEventListener('click', closePicker);
  document.getElementById('pickerSearchBtn').addEventListener('click', searchPicker);
  document.getElementById('pickerInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      searchPicker();
    }
  });
  document.getElementById('pickerFile').addEventListener('change', uploadPickerFile);
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
