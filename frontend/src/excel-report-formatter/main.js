// 現況検査レポート作成ツール（傾斜測定 報告フォーム）。
//
// GAS 版 gas/index.html のフォームロジックを移植したもの。
//   - google.script.run → Clerk トークン付きの fetch（/api/**）
//   - Google Picker → GAS 版と同じ公式 Picker（../google-picker.js）
//   - フォーム定義（MEASUREMENT_GROUPS / VALIDATION）→ /config API から取得
//     （mapping.json が単一の情報源になり、手動同期が不要になった）

import '../styles.css';
import '../components/index.js';
import { finishPageLoading } from '../components/loading.js';
import { requireSignIn } from '../auth.js';
import { redirectToCanonicalHost } from '../canonical-host.js';
import { apiGet, apiPostForBlob, apiSendJson } from '../api.js';
import { pickFile, preloadPicker } from '../google-picker.js';
import { collectWarnings, selectFocusTarget } from './form-logic.js';

const TOOL_API = '/api/tools/excel-report-formatter';

// 雛形はネイティブの .xlsx のみ（Google スプレッドシートは openpyxl が
// 読めないため、Picker の時点で選べないようにする）。
const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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

// 表示はタイトル横の狭い場所なので、名前は 1 行に収めて省略する
// （全体は title 属性でホバー時に読める）。
function showTemplateName(text, configured) {
  const nameEl = document.getElementById('templateName');
  nameEl.textContent = text;
  nameEl.title = text;
  nameEl.className = configured ? 'name' : 'unset';
}

async function refreshTemplateStatus() {
  try {
    const status = await apiGet(`${TOOL_API}/template`);
    templateConfigured = status.configured;
    showTemplateName(
      status.configured ? status.fileName : '未設定',
      status.configured
    );
  } catch (error) {
    // 狭い表示欄に長い文言は入らないので、理由は画面下のメッセージ欄に出す。
    showTemplateName('取得できません', false);
    showMessage(error.message, 'red');
  }
  updateSubmitState();
}

async function chooseTemplate() {
  let file;
  try {
    file = await pickFile({
      title: '雛形（Excel ファイル）を選択',
      mimeTypes: XLSX_MIME,
    });
  } catch (error) {
    showMessage(error.message, 'red');
    return;
  }
  if (!file) return; // Picker をキャンセルした。

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

// 部屋は 1 つずつ折り畳める（<portal-section>）。計測値の表が長いので、
// 入力の済んだ部屋を閉じておけるようにする。見出しの行には部屋の名前と
// 階数・部屋名の欄を残し、閉じたままでも見分けと修正ができるようにする。
function addRoom() {
  if (!config) return;
  const id = 'room' + roomSeq++;
  const defaultFloor = nextDefaultFloor();
  const wrap = document.createElement('portal-section');
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

  // 削除ボタンは見出しの行の中（部屋名の右端）に置く。開閉のつまみの隣
  // （slot="actions"）に出すと、階数・部屋名の行に使える幅がその分狭くなり、
  // 折り返してしまう。
  wrap.innerHTML =
    '<div class="room-head" slot="title">' +
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

// 見出しは「部屋 1（1階 LDK）」のように、入力済みの階数・部屋名を添える。
// 折り畳んだときに、どの部屋かをこの行だけで見分けられるようにするため。
function roomHeading(roomEl, index) {
  const value = function (field) {
    const input = roomEl.querySelector('[data-room-field="' + field + '"]');
    return input ? input.value.trim() : '';
  };
  const floor = value('floor');
  const detail = [floor === '' ? '' : floor + '階', value('room_name')]
    .filter(function (part) {
      return part !== '';
    })
    .join(' ');
  return detail === '' ? '部屋 ' + (index + 1) : '部屋 ' + (index + 1) + '（' + detail + '）';
}

function renumberRooms() {
  const rooms = document.querySelectorAll('#rooms .room');
  rooms.forEach(function (r, i) {
    const heading = roomHeading(r, i);
    r.querySelector('.room-title').textContent = heading;
    // 折り畳みのつまみの読み上げ名も、見出しに合わせる。
    r.setAttribute('label', heading);
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

function bindRoomEvents() {
  // 階数・部屋名を入れたら、部屋の見出しにも反映する（折り畳んだときの目印）。
  document.getElementById('rooms').addEventListener('input', function (e) {
    if (e.target.dataset && e.target.dataset.roomField) renumberRooms();
  });
}

function bindStickyHeadWorkarounds() {
  // 方向選択後、同じ行の水平器入力欄へ自動フォーカスする。ただし「傾斜無」「―」など
  // 計測値を入力しない選択肢のときは、数値欄を飛ばして次の計測点の選択欄へ送る。
  document.getElementById('rooms').addEventListener('change', function (e) {
    if (e.target.tagName !== 'SELECT' || e.target.dataset.field !== 'select') return;
    const noValueOptions =
      (config && config.validation && config.validation.no_value_select_options) || [];
    const target = selectFocusTarget(e.target.value, noValueOptions);
    if (target === 'none') return;

    if (target === 'value') {
      const levelInput = e.target
        .closest('tr')
        .querySelector('input[data-field="digital_level"]');
      if (levelInput) levelInput.focus();
      return;
    }

    // 同じ部屋の中の次の選択欄へ。最後の計測点ならフォーカスは動かさない。
    const selects = Array.prototype.slice.call(
      e.target.closest('.room').querySelectorAll('select[data-field="select"]')
    );
    const next = selects[selects.indexOf(e.target) + 1];
    if (next) next.focus();
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
  // .web.app へのアクセスはカスタムドメインへ寄せる。リダイレクト中は
  // Clerk を初期化しない（別ドメインでセッションを持たせないため）。
  if (redirectToCanonicalHost()) return;

  const clerk = await requireSignIn();
  if (!clerk) return; // サインイン画面を表示中。

  // Picker の準備（設定の取得と Google のスクリプトの読み込み）は、ボタンが
  // 押される前に始めておく（google-picker.js のコメント参照）。
  preloadPicker();

  document.getElementById('templateBtn').addEventListener('click', chooseTemplate);
  document.getElementById('addRoomBtn').addEventListener('click', addRoom);
  document.getElementById('submitBtn').addEventListener('click', submitForm);
  bindRoomEvents();
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
  // 待っても出てこないので、読み込み中の表示は消してから理由を出す。
  finishPageLoading();
  showMessage(error.message, 'red');
});
