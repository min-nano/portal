// Google Drive のファイル・フォルダを選ぶダイアログ。
//
// 以前は Google 公式の Google Picker を使っていた。Picker は Google の iframe
// をページに埋め込む作りで、その中で Google の Cookie（サードパーティ Cookie）
// を要求する。Safari（iOS を含む）はこれを既定ですべて遮るため、「Google が
// 必要な Cookie にアクセスするのを許可してください」と出て先へ進めなくなった。
//
// そこで選ぶ画面はこちらで描き、一覧だけをバックエンドの /api/drive/items から
// 受け取る。一覧は実行ユーザー本人の代理（drive.readonly）で取られるので、
// 見えるのは本人が Drive で見られるものだけ（権限モデルは Picker のときと同じ）。
// ブラウザと Google の間に直接のやり取りが無いので Cookie は関係なく、
// アクセストークンをブラウザへ渡すことも無くなった。
//
// ライブラリは使っていない。重ね表示・フォーカス・Esc はネイティブの
// <dialog>（showModal）が受け持ち、残りはタブ・パンくず・一覧だけなので、
// 既存の部品（.app-dialog・ボタン・入力欄）の見た目で組み立てる。
//
// 選んだファイルの読み書きは、これまで通りバックエンドが代理権限で行う。
// ここから返すのはファイルの ID・名前・種類だけ。
//
// いくつも選ぶ（pickFiles）こともできる。押すたびに選ぶ・外すが切り替わり、
// 選んだものはフォルダを移っても残る。iOS のファイルの選択と同じく、行を
// なぞれば続けて選べる（左の丸の上はどの向きでも、行のほかの所は横に動かし
// 始めれば。縦に動かし始めたときは一覧のスクロール）。

import { apiGet } from './api.js';
import { el } from './components/form-field.js';

export const FOLDER_MIME = 'application/vnd.google-apps.folder';

// 最初に開く場所（タブ）。キーはバックエンドの location と同じ。
const LOCATIONS = [
  { key: 'my-drive', label: 'マイドライブ' },
  { key: 'shared-drives', label: '共有ドライブ' },
  { key: 'recent', label: '最近' },
  { key: 'shared-with-me', label: '共有アイテム' },
];

// マイドライブの最上位。Drive API は 'root' をマイドライブの別名として受け付ける
// （保存先として選ばれても、バックエンドの確認と保存はこの ID のまま通る）。
const MY_DRIVE_ROOT = { id: 'root', name: 'マイドライブ' };

// 検索は打ち終わるのを少し待ってから送る（1 文字ごとに Drive へ問い合わせない）。
const SEARCH_DELAY_MS = 350;

// なぞって選ぶ。指はこれだけ動いてから「なぞった」とみなす（タップの揺れで
// 選び始めない）。マウスは揺れが小さいので短くする。
const DRAG_START_PX = { touch: 10, mouse: 5 };
// なぞっている指が一覧の上下の端のこの幅に入ったら、一覧を送る（端に近いほど速く。
// 1 フレームあたりの最大）。
const AUTO_SCROLL_EDGE_PX = 48;
const AUTO_SCROLL_MAX_PX = 16;

// 開き直したときは、前回いた場所から始める（雛形と保存先を続けて選ぶときなど、
// 同じフォルダの周りを行き来することが多いため）。ページを開き直せば忘れる。
// origin は、検索結果から入ったフォルダのときの検索語（たどってきた道が
// 分からないので、パンくずの先頭は検索結果になる）。
let lastPlace = { location: 'my-drive', path: [], origin: '' };

const dateFormat = new Intl.DateTimeFormat('ja-JP', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : dateFormat.format(date);
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_PATHS = {
  folder: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2h8.8A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z',
  file: 'M6.5 3h7.4L18 7.1v12.4a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 19.5v-15A1.5 1.5 0 0 1 6.5 3zM13.5 3.5V7.5h4',
};

/** フォルダとファイルのアイコン（種類の見分けは名前と、フォルダかどうかで足りる）。 */
function icon(doc, kind) {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `drive-picker-icon ${kind}`);
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICON_PATHS[kind]);
  svg.append(path);
  return svg;
}

/**
 * いくつも選ぶときの、行の左の丸（選ぶと塗られてチェックが付く）。
 *
 * 丸の上は、どの向きになぞっても選ぶ所（CSS で touch-action: none）。
 * フォルダは選べないので、丸の代わりに同じ幅の空きを置いて名前を揃える。
 */
function checkMark(doc, folder) {
  const mark = el(doc, 'span', folder ? 'drive-picker-check blank' : 'drive-picker-check');
  if (folder) return mark;
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const circle = doc.createElementNS(SVG_NS, 'circle');
  circle.setAttribute('cx', '12');
  circle.setAttribute('cy', '12');
  circle.setAttribute('r', '10.25');
  const tick = doc.createElementNS(SVG_NS, 'path');
  tick.setAttribute('d', 'M7.5 12.5l3 3 6-6.5');
  svg.append(circle, tick);
  mark.append(svg);
  return mark;
}

/**
 * なぞって選んだあとの選択（ID → ファイル。選んだ順）。
 *
 * なぞり始めた行（from）から今の行（to）までを、すべて選ぶ（select）か
 * すべて外す。範囲の外は、なぞり始める前（before）のまま。行き過ぎて戻れば、
 * 通り過ぎた行も元に戻る。フォルダは飛ばす。
 *
 * @param {Map<string, object>} before なぞり始める前の選択。
 * @param {object[]} items 一覧の並び（上から順。フォルダも含む）。
 * @param {number} from なぞり始めた行の位置。
 * @param {number} to 今の行の位置。
 * @param {boolean} select 選ぶなら true、外すなら false。
 */
export function dragSelection(before, items, from, to, select) {
  const picked = new Map(before);
  const step = to >= from ? 1 : -1;
  // なぞった向きに足していく（選んだ順＝なぞった順）。
  for (let i = from; i !== to + step; i += step) {
    const item = items[i];
    if (!item || item.folder) continue;
    if (!select) picked.delete(item.id);
    else if (!picked.has(item.id)) picked.set(item.id, item);
  }
  return picked;
}

/**
 * 画面の高さ y にある行の位置。一覧より上なら先頭、下なら末尾の行。
 *
 * @param {Element[]} rows 一覧の行（上から順）。
 * @param {number} y 画面座標（clientY）。
 */
function rowIndexAt(rows, y) {
  let index = 0;
  rows.forEach((row, i) => {
    if (row.getBoundingClientRect().top <= y) index = i;
  });
  return index;
}

/**
 * 一覧を取りに行くときの条件。
 *
 * フォルダの中にいればそのフォルダ、検索語があれば検索、どちらでもなければ
 * タブの最上位。バックエンドも同じ優先順で見る。
 */
export function itemsQuery({ location, path, query }, { mimeTypes, selectFolder }, pageToken) {
  const params = new URLSearchParams();
  const folder = path.length ? path[path.length - 1] : null;
  if (query) params.set('q', query);
  else if (folder) params.set('folder', folder.id);
  else params.set('location', location);
  if (selectFolder) params.set('foldersOnly', 'true');
  else if (mimeTypes) params.set('mimeTypes', mimeTypes);
  if (pageToken) params.set('pageToken', pageToken);
  return `/api/drive/items?${params}`;
}

/**
 * いま「このフォルダを選択」で選べるフォルダ。選べない場所なら null。
 *
 * 共有ドライブの一覧・最近・共有アイテム・検索結果は、フォルダの中ではない
 * ので選べない（中へ入れば選べる）。マイドライブは最上位でも選べる。
 */
export function currentFolder({ location, path, query, origin }) {
  if (query) return null;
  if (path.length) return path[path.length - 1];
  return location === 'my-drive' && !origin ? MY_DRIVE_ROOT : null;
}

/**
 * ダイアログを開いている間、後ろのページを動かないようにする。
 *
 * iOS Safari はモーダルの <dialog> を開いていても、一覧の端まで来たスクロール
 * を後ろのページへ渡してしまう。閉じたときに元居た場所が分からなくなるため、
 * 開いている間は固定する。戻す関数を返す。
 */
function lockPageScroll(doc) {
  const { documentElement: html, body } = doc;
  const view = doc.defaultView;
  const previous = { html: html.style.overflow, body: body.style.overflow };
  // スクロールバーが消えた分だけ内容が右にずれるので、その幅を埋める
  // （スクロールバーが常に出ているデスクトップのブラウザで、後ろのページが
  // 開閉のたびに横へ動かないように）。
  const scrollbar = view.innerWidth - html.clientWidth;
  const previousPadding = body.style.paddingRight;
  html.style.overflow = 'hidden';
  body.style.overflow = 'hidden';
  if (scrollbar > 0) {
    const current = parseFloat(view.getComputedStyle(body).paddingRight) || 0;
    body.style.paddingRight = `${current + scrollbar}px`;
  }
  return () => {
    html.style.overflow = previous.html;
    body.style.overflow = previous.body;
    body.style.paddingRight = previousPadding;
  };
}

/** ダイアログの骨組み。中身（一覧・パンくず）は開いている間に描き直す。 */
function buildDialog(doc) {
  const dialog = el(doc, 'dialog', 'app-dialog drive-picker');
  dialog.id = 'drivePicker';
  dialog.setAttribute('aria-labelledby', 'drivePickerTitle');

  const head = el(doc, 'div', 'drive-picker-head');
  const title = el(doc, 'h3');
  title.id = 'drivePickerTitle';
  const close = el(doc, 'button', 'secondary drive-picker-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', '閉じる');
  close.dataset.action = 'cancel';
  head.append(title, close);

  const tabs = el(doc, 'div', 'drive-picker-tabs');
  tabs.setAttribute('role', 'tablist');
  LOCATIONS.forEach(({ key, label }) => {
    const tab = el(doc, 'button', 'drive-picker-tab', label);
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.dataset.location = key;
    tabs.append(tab);
  });

  const search = el(doc, 'form', 'drive-picker-search');
  search.setAttribute('role', 'search');
  const input = el(doc, 'input');
  input.type = 'search';
  input.placeholder = 'Drive 内を検索';
  input.setAttribute('aria-label', 'Drive 内を検索');
  input.enterKeyHint = 'search';
  search.append(input);

  const crumbs = el(doc, 'nav', 'drive-picker-crumbs');
  crumbs.setAttribute('aria-label', '現在の場所');

  // なぞって選べることは、見ただけでは分からないので書いておく（いくつも
  // 選ぶときだけ出す）。
  const hint = el(doc, 'p', 'drive-picker-hint', '左の ○ を上下になぞると、続けて選べます。');
  hint.hidden = true;

  const body = el(doc, 'div', 'drive-picker-body');
  const list = el(doc, 'ul', 'drive-picker-list');
  const status = el(doc, 'p', 'drive-picker-status');
  status.setAttribute('aria-live', 'polite');
  const more = el(doc, 'button', 'secondary drive-picker-more', 'さらに表示');
  more.type = 'button';
  more.hidden = true;
  body.append(list, status, more);

  const actions = el(doc, 'div', 'dialog-actions');
  const choose = el(doc, 'button', 'drive-picker-choose', '選択');
  choose.type = 'button';
  choose.dataset.action = 'choose';
  const cancel = el(doc, 'button', 'secondary', 'キャンセル');
  cancel.type = 'button';
  cancel.dataset.action = 'cancel';
  actions.append(choose, cancel);

  dialog.append(head, tabs, search, crumbs, hint, body, actions);
  return dialog;
}

function dialogFor(doc) {
  let dialog = doc.getElementById('drivePicker');
  if (!dialog) {
    dialog = buildDialog(doc);
    doc.body.append(dialog);
  }
  return dialog;
}

/**
 * Drive のファイル（またはフォルダ）を選ぶダイアログを開き、選ばれたものを返す。
 *
 * @param {object} options
 * @param {string} options.title ダイアログの見出し。
 * @param {string} [options.mimeTypes] 選択できる種類（カンマ区切り）。
 * @param {boolean} [options.selectFolder] フォルダを選ばせる。
 * @returns {Promise<{id: string, name: string, mimeType: string} | null>}
 *   キャンセルされた場合は null。
 */
export function pickFile(options = {}) {
  return openPicker({ ...options, multiple: false });
}

/**
 * Drive のファイルをいくつも選ぶダイアログを開き、選ばれたものを返す。
 *
 * @param {object} options
 * @param {string} options.title ダイアログの見出し。
 * @param {string} [options.mimeTypes] 選択できる種類（カンマ区切り）。
 * @returns {Promise<{id: string, name: string, mimeType: string}[]>}
 *   選んだ順。キャンセルされた場合は空の配列。
 */
export async function pickFiles(options = {}) {
  return (await openPicker({ ...options, selectFolder: false, multiple: true })) || [];
}

function openPicker(options) {
  const doc = document;
  const dialog = dialogFor(doc);
  const $ = (selector) => dialog.querySelector(selector);
  const list = $('.drive-picker-list');
  const status = $('.drive-picker-status');
  const more = $('.drive-picker-more');
  const input = $('.drive-picker-search input');
  const choose = $('.drive-picker-choose');

  $('#drivePickerTitle').textContent = options.title || '';
  input.value = '';
  dialog.classList.toggle('multiple', Boolean(options.multiple));
  $('.drive-picker-hint').hidden = !options.multiple;

  const state = { ...lastPlace, path: [...lastPlace.path], query: '' };
  let selected = null; // 一覧で選んでいるファイル（1 つ選ぶとき）
  const picked = new Map(); // 選んだファイル（いくつも選ぶとき。ID → ファイル）
  let nextPageToken = null;
  let loading = null; // 進行中の読み込み（AbortController）
  // 一覧に出した ID。同じものを指すショートカットが別のページに入っていても、
  // 2 度は出さない（Drive はページをまたいだ重複を除いてくれない）。
  let shown = new Set();
  let incomplete = false; // Drive が一部の共有ドライブを探さずに返したか

  const updateChoose = () => {
    if (options.multiple) {
      choose.textContent = picked.size ? `選択（${picked.size} 個）` : '選択';
      choose.disabled = picked.size === 0;
      return;
    }
    choose.textContent = options.selectFolder ? 'このフォルダを選択' : '選択';
    choose.disabled = options.selectFolder ? !currentFolder(state) : !selected;
  };

  /** 状態の表示。retry を渡すと「再試行」を添え、押すとそれを呼ぶ。 */
  const showStatus = (text, retry = null) => {
    status.replaceChildren(text);
    status.hidden = !text;
    if (retry) {
      const again = el(doc, 'button', 'secondary', '再試行');
      again.type = 'button';
      again.addEventListener('click', retry);
      status.append(' ', again);
    }
  };

  const renderTabs = () => {
    dialog.querySelectorAll('.drive-picker-tab').forEach((tab) => {
      const active = !state.query && !state.origin && tab.dataset.location === state.location;
      tab.setAttribute('aria-selected', String(active));
    });
  };

  const renderCrumbs = () => {
    const crumbs = $('.drive-picker-crumbs');
    const trail = el(doc, 'ol');
    const tab = LOCATIONS.find(({ key }) => key === state.location);
    // 検索結果から入ったフォルダの先頭は、タブではなくその検索結果（戻ると
    // 同じ検索をやり直す）。どのタブの下にあるかは分からないため。
    const root = state.origin
      ? { label: `「${state.origin}」の検索結果`, depth: 0 }
      : { label: tab.label, depth: 0 };
    const steps = state.query
      ? [{ label: `「${state.query}」の検索結果` }]
      : [root, ...state.path.map((f, i) => ({ label: f.name, depth: i + 1 }))];
    steps.forEach((step, index) => {
      const item = el(doc, 'li');
      const last = index === steps.length - 1;
      if (last || step.depth === undefined) {
        item.append(el(doc, 'span', '', step.label));
        if (last) item.setAttribute('aria-current', 'location');
      } else {
        const back = el(doc, 'button', 'drive-picker-crumb', step.label);
        back.type = 'button';
        back.dataset.depth = String(step.depth);
        item.append(back);
      }
      trail.append(item);
    });
    crumbs.replaceChildren(trail);
  };

  const renderItem = (item) => {
    const row = el(doc, 'li');
    const button = el(doc, 'button', 'drive-picker-item');
    button.type = 'button';
    button.dataset.id = item.id;
    if (!item.folder) button.setAttribute('aria-pressed', String(picked.has(item.id)));
    const name = el(doc, 'span', 'drive-picker-name', item.name);
    const date = el(doc, 'span', 'drive-picker-date', formatDate(item.modifiedTime));
    if (options.multiple) button.append(checkMark(doc, item.folder));
    button.append(icon(doc, item.folder ? 'folder' : 'file'), name, date);
    button.title = item.name;
    button.driveItem = item;
    row.append(button);
    return row;
  };

  /** 一覧を取りに行く。append なら続き（次のページ）を足す。 */
  async function load(append = false) {
    if (loading) loading.abort();
    const controller = new AbortController();
    loading = controller;
    if (!append) {
      stopDrag();
      selected = null;
      nextPageToken = null;
      shown = new Set();
      incomplete = false;
      list.replaceChildren();
      // 別の場所へ移ったら、一覧は先頭から見せる。
      $('.drive-picker-body').scrollTop = 0;
      renderTabs();
      renderCrumbs();
    }
    updateChoose();
    more.hidden = true;
    showStatus('読み込んでいます…');
    let result;
    try {
      result = await apiGet(itemsQuery(state, options, append ? nextPageToken : null), {
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      loading = null;
      // 続きの読み込みに失敗したときは、読めている分を残したまま、その続き
      // だけを読み直す。
      showStatus(error.message, () => load(append));
      return;
    }
    // 待っている間に別の場所へ移っていたら、古い結果は捨てる。
    if (controller.signal.aborted) return;
    loading = null;
    result.items
      .filter((item) => !shown.has(item.id))
      .forEach((item) => {
        shown.add(item.id);
        list.append(renderItem(item));
      });
    nextPageToken = result.nextPageToken || null;
    incomplete = incomplete || Boolean(result.incomplete);
    // 絞り込みで 1 ページがまるごと対象外だった（0 件でも続きがある）ときは、
    // 「選べるものがない」とは言わずに、そのまま続きを読む。
    if (!list.children.length && nextPageToken) {
      load(true);
      return;
    }
    more.hidden = !nextPageToken;
    const partly = incomplete ? '一部の共有ドライブは探せていない可能性があります。' : '';
    if (list.children.length) showStatus(partly);
    else if (state.query) showStatus(`見つかりませんでした。${partly}`);
    else showStatus('ここには選べるものがありません。');
  }

  const go = (change) => {
    Object.assign(state, change);
    if (!state.query) {
      lastPlace = { location: state.location, path: [...state.path], origin: state.origin };
    }
    load();
  };

  const select = (button) => {
    if (options.multiple) {
      // 押すたびに選ぶ・外すを切り替える。
      const item = button.driveItem;
      if (picked.has(item.id)) picked.delete(item.id);
      else picked.set(item.id, item);
      button.setAttribute('aria-pressed', String(picked.has(item.id)));
      updateChoose();
      return;
    }
    list.querySelectorAll('[aria-pressed="true"]').forEach((node) => {
      node.setAttribute('aria-pressed', 'false');
    });
    button.setAttribute('aria-pressed', 'true');
    selected = button.driveItem;
    updateChoose();
  };

  // --- なぞって選ぶ（いくつも選ぶとき） ---
  // 押した行から、いま指のある行までを続けて選ぶ（なぞり始めた行を選んで
  // いなければ選び、選んでいれば外す）。一覧の上下の端まで来たら一覧を送る。
  const body = $('.drive-picker-body');
  const view = doc.defaultView;
  let drag = null; // なぞっている最中の様子（押したときに作り、動き出したら active）
  // なぞり終えた直後の click は、行を押したことにしない（マウスでは、なぞり
  // 終えた行や、押した行と離した行の共通の祖先で click が起きる）。
  let swallowClick = false;

  const rows = () => [...list.querySelectorAll('.drive-picker-item')];

  const extendDrag = () => {
    const all = rows();
    // 一覧を描き直すときは先になぞるのをやめる（stopDrag）ので、押した行は必ずある。
    const from = all.indexOf(drag.row);
    const to = rowIndexAt(all, drag.y);
    const items = all.map((row) => row.driveItem);
    const next = dragSelection(drag.before, items, from, to, drag.select);
    picked.clear();
    next.forEach((item, id) => picked.set(id, item));
    all.forEach((row) => {
      if (!row.driveItem.folder) {
        row.setAttribute('aria-pressed', String(picked.has(row.driveItem.id)));
      }
    });
    updateChoose();
  };

  // なぞり終えれば stopDrag が次のフレームを取り消すので、ここでは drag がある。
  const autoScroll = () => {
    const { top, bottom } = body.getBoundingClientRect();
    const edge = AUTO_SCROLL_EDGE_PX;
    let speed = 0;
    // 端の行は、押した所がもう端の幅に入っている（行の高さより幅が広い）。
    // その端へ向けて動かしたときだけ送る（端の行から反対へなぞり始めたのに、
    // 一覧が逆へ流れて余計な行を選ばないように）。
    if (drag.y < top + edge && drag.y < drag.y0) {
      speed = -Math.min(1, (top + edge - drag.y) / edge);
    } else if (drag.y > bottom - edge && drag.y > drag.y0) {
      speed = Math.min(1, (drag.y - (bottom - edge)) / edge);
    }
    if (speed) {
      const before = body.scrollTop;
      body.scrollTop += speed * AUTO_SCROLL_MAX_PX;
      // 指は止まっていても、下を通る行が変わる。
      if (body.scrollTop !== before) extendDrag();
    }
    drag.frame = view.requestAnimationFrame(autoScroll);
  };

  const startDrag = () => {
    drag.active = true;
    drag.select = !picked.has(drag.row.driveItem.id);
    drag.before = new Map(picked);
    // 一覧の外（上下の端より先）へ出ても、指を追い続ける。
    try {
      list.setPointerCapture?.(drag.pointerId);
    } catch {
      // 指がもう離れていた。続く pointerup / pointercancel で終わる。
    }
    extendDrag();
    if (view.requestAnimationFrame) drag.frame = view.requestAnimationFrame(autoScroll);
  };

  function stopDrag() {
    if (drag && drag.frame) view.cancelAnimationFrame(drag.frame);
    drag = null;
  }

  const result = () => {
    if (options.multiple) {
      return [...picked.values()].map(({ id, name, mimeType }) => ({ id, name, mimeType }));
    }
    if (options.selectFolder) {
      const folder = currentFolder(state);
      return folder && { id: folder.id, name: folder.name, mimeType: FOLDER_MIME };
    }
    return selected && { id: selected.id, name: selected.name, mimeType: selected.mimeType };
  };

  const restorePage = lockPageScroll(doc);

  return new Promise((resolve) => {
    const listening = new AbortController();
    const on = (target, type, handler, capture = false) =>
      target.addEventListener(type, handler, { signal: listening.signal, capture });
    let searchTimer = null;
    let observer = null;

    const finish = (value) => {
      listening.abort();
      stopDrag();
      clearTimeout(searchTimer);
      if (observer) observer.disconnect();
      if (loading) loading.abort();
      restorePage();
      dialog.close();
      resolve(value);
    };

    if (options.multiple) {
      on(list, 'pointerdown', (event) => {
        if (drag || !event.isPrimary || event.button !== 0) return;
        const row = event.target.closest('.drive-picker-item');
        if (!row || row.driveItem.folder) return;
        drag = {
          pointerId: event.pointerId,
          mouse: event.pointerType === 'mouse',
          // 丸の上では、どの向きに動かしてもなぞり始める（CSS でスクロールを
          // 止めてある）。
          onCheck: Boolean(event.target.closest('.drive-picker-check')),
          row,
          x0: event.clientX,
          y0: event.clientY,
          y: event.clientY,
          active: false,
        };
      });
      on(list, 'pointermove', (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        drag.y = event.clientY;
        if (drag.active) {
          event.preventDefault();
          extendDrag();
          return;
        }
        const dx = Math.abs(event.clientX - drag.x0);
        const dy = Math.abs(event.clientY - drag.y0);
        if (Math.max(dx, dy) < DRAG_START_PX[drag.mouse ? 'mouse' : 'touch']) return;
        // 指で丸の外を縦に動かし始めたのは、一覧のスクロール（ブラウザに任せる。
        // 横に動かし始めたときは、CSS の touch-action: pan-y でスクロールしない）。
        if (drag.mouse || drag.onCheck || dx > dy) startDrag();
        else stopDrag();
      });
      on(list, 'pointerup', (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        if (drag.active) {
          swallowClick = true;
          // click は離したのと同じ流れで届く。届かなかったときに、次の押下を
          // 呑み込まないようにする。
          setTimeout(() => {
            swallowClick = false;
          }, 0);
        }
        stopDrag();
      });
      on(list, 'pointercancel', (event) => {
        if (drag && event.pointerId === drag.pointerId) stopDrag();
      });
      on(
        dialog,
        'click',
        (event) => {
          if (!swallowClick) return;
          swallowClick = false;
          event.stopPropagation();
        },
        true
      );
    }

    on(dialog, 'click', (event) => {
      const target = event.target.closest('button');
      if (!target || !dialog.contains(target)) return;
      if (target.dataset.action === 'cancel') finish(null);
      else if (target.dataset.action === 'choose') finish(result());
      else if (target.dataset.location) {
        input.value = '';
        go({ location: target.dataset.location, path: [], query: '', origin: '' });
      } else if (target.dataset.depth !== undefined) {
        const depth = Number(target.dataset.depth);
        if (depth === 0 && state.origin) {
          // 先頭が検索結果なら、その検索に戻る。
          input.value = state.origin;
          go({ path: [], query: state.origin, origin: '' });
        } else go({ path: state.path.slice(0, depth), query: '' });
      } else if (target === more) load(true);
      else if (target.driveItem) {
        // ダブルクリックの 2 回目（detail が 2 以上）は無視する。フォルダを
        // ダブルクリックしたとき、1 回目で開いた先の一覧に 2 回目が当たって、
        // 意図しない行を開いたり選んだりしないように（ファイルのダブル
        // クリックは dblclick で受ける）。
        if (event.detail > 1) return;
        const item = target.driveItem;
        if (item.folder) {
          // 検索結果から入ったフォルダは、たどってきた道が分からないので、
          // そのフォルダを起点にし、先頭には元の検索結果を置く。
          const change = state.query
            ? { path: [item], origin: state.query }
            : { path: [...state.path, item] };
          input.value = '';
          go({ ...change, query: '' });
        } else select(target);
      }
    });

    // ファイルはダブルクリック（タップ 2 回）でそのまま決める。1 回目の
    // クリックで選んだ行のときだけ決める。フォルダをダブルクリックすると
    // 1 回目でフォルダが開き、dblclick は開いた先の（触っていない）行に届く
    // ことがあるため（フォルダを開くと選択は外れるので、ここで弾ける）。
    on(dialog, 'dblclick', (event) => {
      // いくつも選ぶときは、ダブルクリックで決めない（選ぶ・外すの切り替えだけ）。
      if (options.multiple) return;
      const target = event.target.closest('.drive-picker-item');
      if (target && target.driveItem && selected === target.driveItem) {
        finish(result());
      }
    });

    const search = () => {
      clearTimeout(searchTimer);
      const query = input.value.trim();
      if (query === state.query) return;
      go({ query });
    };
    on(input, 'input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(search, SEARCH_DELAY_MS);
    });
    on($('.drive-picker-search'), 'submit', (event) => {
      event.preventDefault();
      search();
    });

    // Esc キーで閉じたときは「キャンセル」と同じ扱いにする。
    on(dialog, 'cancel', (event) => {
      event.preventDefault();
      finish(null);
    });

    // 一覧の下端まで来たら続きを読む（ボタンは、見えない環境での代わり）。
    if (typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !more.hidden && !loading) {
          load(true);
        }
      });
      observer.observe(more);
    }

    dialog.showModal();
    load();
  });
}
