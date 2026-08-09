// 現況検査レポート作成ツール（傾斜測定 報告フォーム）。
//
// GAS 版 gas/index.html のフォームロジックを移植したもの。
//   - google.script.run → Clerk トークン付きの fetch（/api/**）
//   - Google Picker → 実行ユーザー代理の Drive 検索ダイアログ
//   - フォーム定義（MEASUREMENT_GROUPS / VALIDATION）→ /config API から取得
//     （mapping.json が単一の情報源になり、手動同期が不要になった）

import '../styles.css';
import { requireSignIn } from '../auth.js';
import { apiGet, apiPostForBlob, apiSendJson } from '../api.js';
import { collectWarnings } from './form-logic.js';

const TOOL_API = '/api/tools/excel-report-formatter';

let config = null; // /config の応答（measurement_groups / validation / max_rooms）
let templateConfigured = false;
let roomSeq = 0;

function showMessage(text, color) {
  const msg = document.getElementById('message');
  msg.style.color = color;
  msg.innerText = text;
}

function updateSubmitState() {
  document.getElementById('submitBtn').disabled = !templateConfigured || !config;
}

// --- 雛形設定 ---------------------------------------------------------------

async function refreshTemplateStatus() {
  const nameEl = document.getElementById('templateName');
  try {
    const status = await apiGet(`${TOOL_API}/template`);
    templateConfigured = status.configured;
    if (status.configured) {
      nameEl.textContent = status.fileName;
      nameEl.className = 'name';
    } else {
      nameEl.textContent = '未設定（「雛形を設定」から選択してください）';
      nameEl.className = 'unset';
    }
  } catch (error) {
    nameEl.textContent = error.message;
    nameEl.className = 'unset';
  }
  updateSubmitState();
}

function openTemplateDialog() {
  document.getElementById('templateDialog').hidden = false;
  document.getElementById('templateResults').innerHTML =
    '<p class="status">ファイル名（の一部）を入力して検索してください。</p>';
  document.getElementById('templateSearchInput').focus();
}

function closeTemplateDialog() {
  document.getElementById('templateDialog').hidden = true;
}

async function searchTemplates() {
  const query = document.getElementById('templateSearchInput').value.trim();
  const resultsEl = document.getElementById('templateResults');
  if (!query) {
    resultsEl.innerHTML = '<p class="status">検索キーワードを入力してください。</p>';
    return;
  }
  resultsEl.innerHTML = '<p class="status">検索中...</p>';
  try {
    const { files } = await apiGet(
      `${TOOL_API}/template/candidates?q=${encodeURIComponent(query)}`
    );
    if (files.length === 0) {
      resultsEl.innerHTML =
        '<p class="status">見つかりませんでした。あなたに閲覧権限のある .xlsx ファイルだけが対象です。</p>';
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
      btn.addEventListener('click', () => selectTemplate(file));
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

async function selectTemplate(file) {
  closeTemplateDialog();
  showMessage('雛形を保存しています...', '#333');
  try {
    const result = await apiSendJson(`${TOOL_API}/template`, 'PUT', {
      fileId: file.id,
    });
    showMessage('雛形を設定しました: ' + result.fileName, 'green');
    await refreshTemplateStatus();
  } catch (error) {
    showMessage(error.message, 'red');
  }
}

// --- 部屋フォーム -----------------------------------------------------------

// 1 つの計測点を表の 1 行にする。ラベル（差/距離/水平器）はヘッダー列で代表する。
// 数値欄は inputmode="decimal" で半角数字キーパッドを出す。
function buildMeasurementRow(point) {
  const opts = ['']
    .concat(point.options)
    .map(function (o) {
      return '<option value="' + o + '">' + (o || '（なし）') + '</option>';
    })
    .join('');
  function numCell(field) {
    return (
      '<td><input type="number" inputmode="decimal" step="any" data-field="' +
      field + '" data-point="' + point.key + '"></td>'
    );
  }
  return (
    '<tr>' +
    '<td class="point-cell">' + point.label + '</td>' +
    '<td><select data-field="select" data-point="' + point.key + '">' + opts + '</select></td>' +
    numCell('diff') +
    numCell('distance') +
    numCell('digital_level') +
    '</tr>'
  );
}

// 新しい部屋の階数の初期値は「直前に入力していた階数」を引き継ぐ。
// 最初の部屋（既存の部屋が無い）のときは 1 階を既定とする。
function nextDefaultFloor() {
  const rooms = document.querySelectorAll('#rooms .room');
  if (rooms.length === 0) return '1';
  const last = rooms[rooms.length - 1].querySelector('[data-room-field="floor"]');
  const value = last ? last.value.trim() : '';
  return value !== '' ? value : '1';
}

function addRoom() {
  if (!config) return;
  const id = 'room' + roomSeq++;
  const defaultFloor = nextDefaultFloor();
  const wrap = document.createElement('div');
  wrap.className = 'room';
  wrap.id = id;

  // グループごとに見出し行を挟みつつ、計測点を 1 行ずつ並べる。
  let rowsHtml = '';
  config.measurement_groups.forEach(function (g) {
    rowsHtml +=
      '<tr class="group-row"><td colspan="5">' + g.group + '（' + g.select_label + '）</td></tr>';
    g.points.forEach(function (p) {
      rowsHtml += buildMeasurementRow(p);
    });
  });

  wrap.innerHTML =
    '<div class="room-head">' +
      '<div class="room-title-row">' +
        '<h3 class="room-title"></h3>' +
        '<button type="button" class="remove">削除</button>' +
      '</div>' +
      '<div class="room-meta">' +
        '<label>階数</label><input type="number" inputmode="numeric" data-room-field="floor">' +
        '<label>部屋名</label><input type="text" data-room-field="room_name" placeholder="例: LDK">' +
      '</div>' +
    '</div>' +
    '<table class="measure-table">' +
      '<colgroup><col class="col-point"><col><col><col><col></colgroup>' +
      '<thead><tr>' +
        '<th>計測点</th><th>選択</th><th>差 (mm)</th><th>距離 (mm)</th><th>水平器 (10<sup>-3</sup>)</th>' +
      '</tr></thead>' +
      '<tbody>' + rowsHtml + '</tbody>' +
    '</table>';

  wrap.querySelector('.remove').addEventListener('click', function () {
    removeRoom(id);
  });
  document.getElementById('rooms').appendChild(wrap);
  // 階数の初期値は innerHTML に埋め込まず、DOM 生成後に value プロパティで設定する
  // （直前の部屋の入力値を HTML 文字列へ連結すると DOM ベースの XSS 経路になるため）。
  wrap.querySelector('[data-room-field="floor"]').value = defaultFloor;
  renumberRooms();
}

function removeRoom(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
  renumberRooms();
}

function renumberRooms() {
  const rooms = document.querySelectorAll('#rooms .room');
  rooms.forEach(function (r, i) {
    r.querySelector('.room-title').textContent = '部屋 ' + (i + 1);
  });
}

// フォームの入力内容を、バックエンドへ送るデータ構造に変換する。
function collectFormData() {
  const rooms = [];
  document.querySelectorAll('#rooms .room').forEach(function (roomEl) {
    const measurements = {};
    roomEl.querySelectorAll('[data-point]').forEach(function (input) {
      const point = input.getAttribute('data-point');
      const field = input.getAttribute('data-field');
      const value = input.value;
      if (value === '') return;
      if (!measurements[point]) measurements[point] = {};
      measurements[point][field] = value;
    });
    rooms.push({
      floor: roomEl.querySelector('[data-room-field="floor"]').value,
      room_name: roomEl.querySelector('[data-room-field="room_name"]').value,
      measurements: measurements,
    });
  });
  return {
    property_name: document.getElementById('property_name').value,
    rooms: rooms,
  };
}

// --- 出力 -------------------------------------------------------------------

async function submitForm() {
  const btn = document.getElementById('submitBtn');
  const msg = document.getElementById('message');
  btn.disabled = true;
  btn.innerText = '作成中...';
  msg.innerText = '';

  const formData = collectFormData();

  // 入力漏れを防ぐ簡単なバリデーション。
  function abort(text) {
    showMessage(text, 'red');
    btn.disabled = false;
    btn.innerText = 'Excel出力';
  }
  if (formData.rooms.length === 0) {
    return abort('部屋を少なくとも1つ追加してください。');
  }
  for (let i = 0; i < formData.rooms.length; i++) {
    const r = formData.rooms[i];
    if (!r.floor.trim() || !r.room_name.trim()) {
      return abort('部屋 ' + (i + 1) + ' の階数と部屋名を入力してください。');
    }
  }

  // 入力ミスの可能性を確認する簡易バリデーション（出力はブロックしない）。
  const warnings = collectWarnings(
    formData,
    config.measurement_groups,
    config.validation
  );
  if (warnings.length > 0) {
    const proceed = window.confirm(
      '以下の点をご確認ください:\n\n・' + warnings.join('\n・') +
        '\n\nこのまま出力してよろしいですか？'
    );
    if (!proceed) {
      // 確認をキャンセル。エラー表示はせずボタンだけ戻す。
      btn.disabled = false;
      btn.innerText = 'Excel出力';
      return;
    }
  }

  try {
    const { blob, fileName } = await apiPostForBlob(
      `${TOOL_API}/reports`,
      formData,
      config.report_file_name
    );

    const link = document.createElement('a');
    link.href = window.URL.createObjectURL(blob);
    link.download = fileName;
    link.click();

    showMessage('ダウンロードが完了しました。', 'green');
  } catch (error) {
    showMessage('ファイルの生成に失敗しました: ' + error.message, 'red');
  } finally {
    btn.disabled = false;
    btn.innerText = 'Excel出力';
  }
}

// --- 初期化 -----------------------------------------------------------------

function bindStickyHeadWorkarounds() {
  // 方向選択後、同じ行の水平器入力欄へ自動フォーカスする。
  document.getElementById('rooms').addEventListener('change', function (e) {
    if (e.target.tagName === 'SELECT' && e.target.dataset.field === 'select') {
      const levelInput = e.target
        .closest('tr')
        .querySelector('input[data-field="digital_level"]');
      if (levelInput) levelInput.focus();
    }
  });

  // キーボード出現時に sticky の room-head が上に抜ける問題への対処。
  // ブラウザの自動スクロールが .room の containing block をビューポート外に押し出すと
  // sticky が解除されて room-head が上に消える。フォーカス後に位置を確認し補正する。
  document.getElementById('rooms').addEventListener('focusin', function (e) {
    if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') return;
    if (e.target.closest('.room-head')) return;
    const roomEl = e.target.closest('.room');
    if (!roomEl) return;
    setTimeout(function () {
      const roomHead = roomEl.querySelector('.room-head');
      if (!roomHead || !document.body.contains(roomHead)) return;
      const rect = roomHead.getBoundingClientRect();
      if (rect.top < 0) {
        const inputRect = e.target.getBoundingClientRect();
        const maxScrollUp = inputRect.bottom - window.innerHeight + 16;
        const scrollAmount = Math.min(0, Math.max(rect.top, maxScrollUp));
        if (scrollAmount < 0) {
          window.scrollBy({ top: scrollAmount, behavior: 'auto' });
        }
      }
    }, 350);
  });
}

async function start() {
  const clerk = await requireSignIn();
  if (!clerk) return; // サインイン画面を表示中。

  document.getElementById('templateBtn').addEventListener('click', openTemplateDialog);
  document.getElementById('templateDialogClose').addEventListener('click', closeTemplateDialog);
  document.getElementById('templateSearchBtn').addEventListener('click', searchTemplates);
  document.getElementById('templateSearchInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      searchTemplates();
    }
  });
  document.getElementById('addRoomBtn').addEventListener('click', addRoom);
  document.getElementById('submitBtn').addEventListener('click', submitForm);
  bindStickyHeadWorkarounds();

  // フォーム定義と雛形設定を並行して取得してから、最初の 1 部屋を表示する。
  try {
    const [loadedConfig] = await Promise.all([
      apiGet(`${TOOL_API}/config`),
      refreshTemplateStatus(),
    ]);
    config = loadedConfig;
  } catch (error) {
    showMessage(error.message, 'red');
    return;
  }
  updateSubmitState();
  addRoom();
}

start().catch(function (error) {
  showMessage(error.message, 'red');
});
