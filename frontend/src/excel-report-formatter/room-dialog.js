// 写真から読んだ部屋（階・室名）を確かめるダイアログ。
//
// 間取り図の読み取りは、読み落とし・読み違い・測らない部屋が混じりうるので、
// フォームへ入れる前に一覧で見せ、直してから確定してもらう。物件名と違い、
// 部屋は直接は入れない。
//
// 画面はここで組み立てて <body> に足す（ページの HTML には置かない）。

function element(doc, tag, props = {}) {
  return Object.assign(doc.createElement(tag), props);
}

/** 一覧の 1 行（階・室名・削除）。 */
function buildRow(doc, room) {
  const row = element(doc, 'div', { className: 'room-reading-row' });
  row.setAttribute('role', 'listitem');
  const floor = element(doc, 'input', {
    type: 'number',
    inputMode: 'numeric',
    className: 'room-reading-floor',
    value: room.floor,
  });
  floor.setAttribute('aria-label', '階');
  const unit = element(doc, 'span', { className: 'room-reading-unit', textContent: '階' });
  const name = element(doc, 'input', {
    type: 'text',
    className: 'room-reading-name',
    value: room.name,
    placeholder: '例: LDK',
  });
  name.setAttribute('aria-label', '室名');
  const remove = element(doc, 'button', {
    type: 'button',
    className: 'secondary danger room-reading-remove',
    textContent: '削除',
  });
  remove.addEventListener('click', () => row.remove());
  row.append(floor, unit, name, remove);
  return row;
}

function buildDialog(doc) {
  const dialog = element(doc, 'dialog', { id: 'roomReadingDialog', className: 'app-dialog room-reading' });
  dialog.setAttribute('aria-labelledby', 'roomReadingTitle');
  const heading = element(doc, 'h3', { id: 'roomReadingTitle', textContent: '読み取った部屋' });
  const hint = element(doc, 'p', {
    className: 'hint',
    textContent:
      '階と室名を確かめてください。読み違いを直し、測らない部屋は削除してから「フォームに入力」を押します。',
  });
  const list = element(doc, 'div', { className: 'room-reading-list', id: 'roomReadingList' });
  list.setAttribute('role', 'list');
  const add = element(doc, 'button', {
    type: 'button',
    className: 'add',
    id: 'roomReadingAddBtn',
    textContent: '＋ 部屋を追加',
  });
  const message = element(doc, 'p', { className: 'dialog-error', id: 'roomReadingMessage' });
  message.setAttribute('role', 'alert');
  const actions = element(doc, 'div', { className: 'dialog-actions' });
  // 開いたときの焦点は確定のボタンへ（最初の入力欄に置くと、スマホでは
  // 一覧を見る前にキーボードが出て、一覧が隠れる）。
  const ok = element(doc, 'button', {
    type: 'button',
    id: 'roomReadingOkBtn',
    textContent: 'フォームに入力',
    autofocus: true,
  });
  const cancel = element(doc, 'button', {
    type: 'button',
    id: 'roomReadingCancelBtn',
    className: 'secondary',
    textContent: 'キャンセル',
  });
  actions.append(ok, cancel);
  dialog.append(heading, hint, list, add, message, actions);
  doc.body.append(dialog);

  add.addEventListener('click', () => {
    // 新しい行の階は、いちばん下の行の階を引き継ぐ（フォームの部屋の追加と同じ）。
    const floors = list.querySelectorAll('.room-reading-floor');
    const last = floors.length > 0 ? floors[floors.length - 1].value : '';
    const row = buildRow(doc, { floor: last, name: '' });
    list.append(row);
    row.querySelector('.room-reading-name').focus();
  });
  return dialog;
}

/**
 * 一覧の入力を読み、確定できる部屋の並びにする。空の行（階も室名も無い）は
 * 外す。確定できなければ、その理由を error に入れて返す。
 *
 * @param {{floor:string, name:string}[]} rows
 * @param {number} capacity フォームに入れられる部屋の数
 * @return {{rooms?: {floor:string, name:string}[], error?: string}}
 */
export function validateRooms(rows, capacity) {
  const rooms = [];
  for (const row of rows) {
    const floor = row.floor.trim();
    const name = row.name.trim();
    if (floor === '' && name === '') continue;
    if (floor === '' || name === '') {
      return { error: `${rooms.length + 1} 行目の階と室名を入れてください。` };
    }
    rooms.push({ floor, name });
  }
  if (rooms.length === 0) return { error: '部屋がありません。「＋ 部屋を追加」で足してください。' };
  if (rooms.length > capacity) {
    return {
      error: `フォームに入れられる部屋はあと ${capacity} までです（雛形の上限）。${rooms.length - capacity} 部屋を削除してください。`,
    };
  }
  return { rooms };
}

/**
 * 読み取った部屋を一覧で見せ、確定したものを返す。キャンセルしたら null。
 *
 * @param {{floor:string, name:string}[]} rooms 読み取った部屋（空でもよい）
 * @param {number} capacity フォームに入れられる部屋の数
 * @param {Document} [doc]
 * @return {Promise<{floor:string, name:string}[]|null>}
 */
export function confirmRooms(rooms, capacity, doc = document) {
  const dialog = doc.getElementById('roomReadingDialog') || buildDialog(doc);
  const list = doc.getElementById('roomReadingList');
  const message = doc.getElementById('roomReadingMessage');
  list.replaceChildren(...rooms.map((room) => buildRow(doc, room)));
  message.textContent = '';

  return new Promise((resolve) => {
    const controller = new AbortController();
    const on = (target, type, handler) => target.addEventListener(type, handler, { signal: controller.signal });
    const finish = (result) => {
      controller.abort();
      dialog.close();
      resolve(result);
    };
    on(doc.getElementById('roomReadingOkBtn'), 'click', () => {
      const rows = [...list.querySelectorAll('.room-reading-row')].map((row) => ({
        floor: row.querySelector('.room-reading-floor').value,
        name: row.querySelector('.room-reading-name').value,
      }));
      const result = validateRooms(rows, capacity);
      if (result.error) message.textContent = result.error;
      else finish(result.rooms);
    });
    on(doc.getElementById('roomReadingCancelBtn'), 'click', () => finish(null));
    // Esc で閉じたとき。
    on(dialog, 'cancel', (event) => {
      event.preventDefault();
      finish(null);
    });
    dialog.showModal();
  });
}
