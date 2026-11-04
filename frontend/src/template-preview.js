// 雛形のプレビュー（タイトル横の雛形のファイル名を押すと開くポップアップ）。
//
// 中身はバックエンドの GET <ツールの API>/template/preview が、生成と同じ
// 「フォルダ内の同名ファイルのうち最新のもの」を本人の代理で読んで返す
// （backend/app/portal_sdk.py の Template.preview）。
//
//   Google ドキュメント … PDF が届くので、頁を描いて並べる（pdf-pages.js）
//   Excel（.xlsx）     … シートごとの表（JSON）が届くので、<table> に組み立てる
//
// Excel の表は、セルの値・結合・罫線・太字・揃え・塗りだけを写した近似で、
// 印刷の体裁そのものではない（backend/app/xlsx_preview.py）。
//
// 画面はどのツールのページからでも開けるよう、ここで組み立てて <body> に
// 足す（ページの HTML には置かない）。

import { apiGetBlob } from './api.js';
import { el } from './components/form-field.js';
import { lockPageScroll } from './drive-picker.js';

const DIALOG_ID = 'templatePreview';

/**
 * セル 1 つを <td> にする。
 *
 * 値は textContent で入れる（雛形の中身をそのまま HTML として解釈しない）。
 * 罫線の辺は data-edges に書き、色は CSS が決める（明暗のテーマに合わせるため）。
 */
function buildCell(doc, cell) {
  const td = el(doc, 'td', null, cell.v);
  if (cell.rs) td.rowSpan = cell.rs;
  if (cell.cs) td.colSpan = cell.cs;
  if (cell.b) td.style.fontWeight = '700';
  if (cell.fs) td.style.fontSize = `${cell.fs}px`;
  if (cell.a) td.style.textAlign = cell.a;
  if (cell.va) td.style.verticalAlign = cell.va;
  if (cell.bg) td.style.backgroundColor = cell.bg;
  if (cell.w) td.dataset.wrap = '';
  if (cell.bd) td.dataset.edges = cell.bd;
  return td;
}

/**
 * シート 1 枚を、見出し（シート名）付きの表にする。
 *
 * @param {Document} doc
 * @param {{name: string, cols: number[], rows: {h: number, cells: object[]}[], truncated: boolean}} sheet
 *   backend/app/xlsx_preview.py の sheets() が返すシート
 */
export function buildSheet(doc, sheet) {
  const section = el(doc, 'section', 'sheet-preview');
  section.append(el(doc, 'h4', null, sheet.name));
  if (!sheet.rows.length) {
    section.append(el(doc, 'p', 'hint', '（何も書かれていないシートです）'));
    return section;
  }

  const table = el(doc, 'table', 'sheet-table');
  table.style.width = `${sheet.cols.reduce((sum, width) => sum + width, 0)}px`;
  const colgroup = el(doc, 'colgroup');
  sheet.cols.forEach((width) => {
    const col = el(doc, 'col');
    col.style.width = `${width}px`;
    colgroup.append(col);
  });
  const tbody = el(doc, 'tbody');
  sheet.rows.forEach((row) => {
    const tr = el(doc, 'tr');
    tr.style.height = `${row.h}px`;
    row.cells.forEach((cell) => tr.append(buildCell(doc, cell)));
    tbody.append(tr);
  });
  table.append(colgroup, tbody);
  section.append(table);
  if (sheet.truncated) {
    section.append(el(doc, 'p', 'hint', '大きなシートなので、左上の一部だけを表示しています。'));
  }
  return section;
}

/** ダイアログの骨組み（1 度だけ作り、開くたびに中身を入れ替える）。 */
function buildDialog(doc) {
  const dialog = el(doc, 'dialog', 'app-dialog template-preview');
  dialog.id = DIALOG_ID;
  dialog.setAttribute('aria-labelledby', 'templatePreviewTitle');

  const head = el(doc, 'div', 'template-preview-head');
  const title = el(doc, 'h3');
  title.id = 'templatePreviewTitle';
  const close = el(doc, 'button', 'secondary template-preview-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', '閉じる');
  close.addEventListener('click', () => dialog.close());
  head.append(title, close);

  const status = el(doc, 'p', 'template-preview-status');
  status.setAttribute('aria-live', 'polite');
  const body = el(doc, 'div', 'template-preview-body');

  dialog.append(head, status, body);
  // 閉じたら中身を捨て（頁の画像は大きいので、持ったままにしない）、
  // 後ろのページのスクロールを戻す。
  dialog.addEventListener('close', () => {
    body.replaceChildren();
    restorePage?.();
    restorePage = null;
  });
  doc.body.append(dialog);
  return dialog;
}

/** 開くたびに増える番号。閉じて開き直したあとに、前の読み込みの結果を描かないため。 */
let generation = 0;
/** 開いている間、後ろのページを動かないようにしたのを戻す関数（drive-picker.js の lockPageScroll）。 */
let restorePage = null;

/**
 * 雛形のプレビューを開く。
 *
 * @param {object} options
 * @param {string} options.url GET <ツールの API>/template/preview
 * @param {string} options.fileName 見出しに出す雛形のファイル名
 * @param {Document} [options.doc]
 * @returns {Promise<void>} 中身を描き終えた（または失敗を表示した）とき
 */
export async function openTemplatePreview({ url, fileName, doc = document }) {
  const dialog = doc.getElementById(DIALOG_ID) || buildDialog(doc);
  const status = dialog.querySelector('.template-preview-status');
  const body = dialog.querySelector('.template-preview-body');
  dialog.querySelector('h3').textContent = fileName;
  body.replaceChildren();
  status.className = 'template-preview-status';
  status.textContent = '雛形を読み込んでいます…';
  // iOS Safari は、モーダルの中でスクロールし切った分を後ろのページへ渡すので固定する。
  restorePage ??= lockPageScroll(doc);
  dialog.showModal();

  const current = ++generation;
  const stale = () => current !== generation || !dialog.open;
  try {
    const blob = await apiGetBlob(url);
    if (stale()) return;
    if (blob.type.startsWith('application/pdf')) {
      const { renderPdfPages } = await import('./pdf-pages.js');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (stale()) return;
      status.textContent = '';
      await renderPdfPages(bytes, body, { stopped: stale });
      return;
    }
    const { sheets } = JSON.parse(await blob.text());
    if (stale()) return;
    status.textContent = sheets.length
      ? 'セルの値と罫線を表にしたものです（色・図形などは省いています）。'
      : '表示できるシートがありません。';
    body.append(...sheets.map((sheet) => buildSheet(doc, sheet)));
  } catch (error) {
    if (stale()) return;
    status.className = 'template-preview-status dialog-error';
    status.textContent = error.message;
  }
}

/**
 * 雛形のファイル名（ボタン）を押したら、プレビューを開くようにする。
 *
 * 雛形が未設定のあいだは、ページの側がボタンを押せない状態（disabled）に
 * しておく。見出しには、押した時点でボタンに出ているファイル名を使う。
 *
 * @param {HTMLButtonElement} button
 * @param {string} url GET <ツールの API>/template/preview
 */
export function connectTemplatePreview(button, url) {
  button.addEventListener('click', () => {
    openTemplatePreview({ url, fileName: button.textContent, doc: button.ownerDocument });
  });
}
