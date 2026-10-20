// 書籍スキャン PDF 結合ツール。
//
// 裁断した本を分けてスキャンした PDF を、頁番号で 1 冊の順に並べて結合する。
// 判断（番号の推定・検査・並べ替え）・画像の展開・OCR・結合・検証は、すべて
// ブラウザの中で行う。サーバー（backend/app/tools/pdf_book_merger.py）が受け持つ
// のは、Drive の PDF を読むときの中継だけ。
//
//   1. ファイルを読む   Drive（サーバー経由で 8 MiB ずつ。drive-download.js）
//                       か手元から
//   2. 文字情報を読む   頁番号の候補（pdf-source.js → page-numbers.js）。軽い
//   3. 頁の画像を測る   傾き・ずれ・すじ（image-checks.js を worker で）。
//                       頁が JPEG 1 枚なら、ブラウザ自身に展開させて描く
//                       （scan-images.js）。そうでなければ pdf.js で描く
//   4. 余白を OCR       文字情報で番号が見つからない頁だけ（ocr.js）
//   5. 並べて確かめる   番号の推定・抜け・重なり・スキャンの外れ値
//                       （ordering.js / review.js）
//   6. 結合して検証     pdf-lib で頁をそのまま写し（merge.js）、読み直して
//                       元の頁と突き合わせる（verify.js）
//   7. 保存             ダウンロード（この端末へ。Drive へは端末のアプリで）
//
// 判断はどれも DOM に触らない部品に置いてあり、ここはそれをつなぐだけにする。

import '../styles.css';
import './tool.css';
import '../components/index.js';
import { startPage } from '../page-start.js';
import { pickFiles } from '../drive-picker.js';
import { ensurePdfExtension } from '../pdf-file-ops.js';
import { downloadDriveFile } from './drive-download.js';
import { compareScans } from './image-checks.js';
import { measure } from './measure-client.js';
import { prepareOcr, readStrip } from './ocr.js';
import {
  buildBookOrder,
  checkSequence,
  guessRole,
  numberFiles,
  orderedFile,
  pageLabelRanges,
  pageLabelTexts,
  ROLES,
  roleFromName,
  sideOf,
} from './ordering.js';
import { describeNumbering, pageNumberCandidates } from './page-numbers.js';
import { findScanImages } from './scan-images.js';
import {
  closePdf,
  openPdf,
  readPageText,
  releaseCanvas,
  renderMargins,
  renderPageImage,
  renderPreview,
} from './pdf-source.js';
import {
  displayLabel,
  gridItems,
  pageIssues,
  STATUS_LABEL,
  suggestBookName,
  textCoverage,
  worstLevel,
} from './review.js';
import { compareOutput } from './verify.js';

const PDF_MIME = 'application/pdf';
const DEFAULT_NAME = '結合.pdf';

/** 同時に読み取る頁の数（OCR の worker の数より少し多くして、待ちを埋める）。 */
const OCR_IN_FLIGHT = 3;
/** 測り終わるのを待たずに描き進める頁の数（描いている間に worker が測る）。 */
const MEASURES_IN_FLIGHT = 2;

let nextKey = 1;
/** 選んだファイル（画面の並び順）。中身は addFile() を参照。 */
const files = [];
/** 頁ごとに手で直した番号（頁の key → 番号）。 */
const overrides = new Map();
/** 最後に組み立てた並びと指摘。 */
let view = { order: [], problems: [], issues: new Map(), numberings: new Map() };
/** 結合した PDF と検証の結果。並びが変わったら捨てる。 */
let merged = null;
let filter = 'all';
// ファイルは 1 つずつ読む（pdf.js も OCR も、同時に動かすと遅くなるだけなので）。
let queue = Promise.resolve();
let ocrFailed = false;

const $ = (id) => document.getElementById(id);

function showMessage(text, color = '') {
  const box = $('message');
  box.style.color = color;
  box.textContent = text;
}

function showProgress(text, fraction) {
  $('progress').hidden = !text;
  $('progressText').textContent = text || '';
  const bar = $('progressBar');
  if (fraction === null || fraction === undefined) bar.removeAttribute('value');
  else bar.value = Math.max(0, Math.min(1, fraction));
}

function megabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 画面を描き直す前に、一息つかせる（数百頁の処理の間も画面が固まらないように）。 */
function breathe() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// --- ファイルを足す ----------------------------------------------------------

/**
 * ファイルを一覧に足し、順番が来たら読む。
 *
 * @param {{name:string, size?:number, driveId?:string,
 *          load:(onProgress:Function) => Promise<Uint8Array>}} source
 */
function addFile(source) {
  if (source.driveId && files.some((file) => file.driveId === source.driveId)) {
    showMessage(`「${source.name}」はすでに追加してあります。`, 'red');
    return;
  }
  const file = {
    key: `f${nextKey++}`,
    name: source.name,
    driveId: source.driveId || '',
    status: 'waiting', // waiting → loading → reading → ocr → ready / error
    detail: '',
    error: '',
    role: 'body',
    manual: null,
    reversed: false,
    bytes: null,
    doc: null,
    pages: [],
  };
  files.push(file);
  renderFiles();
  queue = queue.then(() => readFile(file, source)).catch(() => {});
}

async function readFile(file, source) {
  if (!files.includes(file)) return; // 読む前に外された。
  try {
    file.status = 'loading';
    renderFiles();
    file.bytes = await source.load((received, total) => {
      const text = total
        ? `「${file.name}」を読み込んでいます（${megabytes(received)} / ${megabytes(total)}）`
        : `「${file.name}」を読み込んでいます（${megabytes(received)}）`;
      showProgress(text, total ? received / total : null);
    });
    if (!isPdf(file.bytes)) throw new Error('PDF ファイルではありません。');

    file.status = 'reading';
    file.doc = await withContext('PDF として開けませんでした', () => openPdf(file.bytes));
    const count = file.doc.numPages;

    // 文字情報（画像を展開しないので軽い）。
    for (let index = 0; index < count; index++) {
      if (!files.includes(file)) return;
      showProgress(`「${file.name}」の文字情報を読んでいます（${index + 1} / ${count}）`, index / count);
      const { items, ...text } = await withContext(`${index + 1} 頁目を読めませんでした`, () =>
        readPageText(file.doc, index)
      );
      file.pages.push({
        key: `${file.key}:${index}`,
        index,
        ...text,
        candidates: pageNumberCandidates(items, 'text'),
        measure: null,
        thumbUrl: '',
        ocr: false,
      });
      if (index % 16 === 0) await breathe();
    }

    // 頁の画像を測る（重いところ）。JPEG のまま描ける頁を先に調べておく。
    // 調べた JPEG は読み終えたら手放す（ファイルと同じだけの大きさがある）。
    showProgress(`「${file.name}」の頁の画像を調べています`, null);
    const scans = await findScanImages(file.bytes);
    await measureImages(file, scans);

    // 名前で表紙と分かるもののほかは、役割を決める前に番号を読み切る
    // （文字情報の無い束も、画像から番号が読めれば本文と分かる）。
    if (!roleFromName(file.name) && $('ocrToggle').checked) await readMarginsWithOcr(file, scans);
    file.role = guessRole(file.name, file.pages);
    file.status = 'ready';
    file.detail = '';
  } catch (error) {
    file.status = 'error';
    file.error = error.message || String(error);
  } finally {
    showProgress('');
    if (files.includes(file)) refresh();
  }
}

/**
 * 頁の画像を描いて測り、一覧の縮小画像を付ける。
 *
 * 測るのは worker（measure-client.js）なので、測っている間に次の頁を描く。
 *
 * @param {object} file
 * @param {(object|null)[]} scans 頁ごとの JPEG（scan-images.js。無い頁は pdf.js で描く）
 */
async function measureImages(file, scans) {
  const count = file.pages.length;
  let done = 0;
  const running = new Set();
  for (const page of file.pages) {
    if (!files.includes(file)) break;
    const { image, thumbUrl } = await withContext(`${page.index + 1} 頁目の画像を描けませんでした`, () =>
      renderPageImage(file.doc, page.index, scans[page.index] ?? null)
    );
    page.thumbUrl = thumbUrl;
    // 画素は測ったら捨てる（数百頁ぶん抱えるとメモリが足りなくなる）。
    const job = measure(image).then((result) => {
      page.measure = result;
      done++;
      file.detail = `頁の画像を調べています ${done} / ${count}`;
      showProgress(`「${file.name}」の頁の画像を調べています（${done} / ${count}）`, done / count);
      if (done % 8 === 0) renderFiles();
    });
    running.add(job);
    job.then(
      () => running.delete(job),
      () => running.delete(job)
    );
    if (running.size >= MEASURES_IN_FLIGHT) await Promise.race(running);
    await breathe();
  }
  await Promise.all(running);
}

/**
 * 失敗に、どの段で起きたかを添える。
 *
 * ブラウザの失敗の文言（「The object is in an invalid state.」など）だけでは、
 * どこで止まったのか分からないため。
 */
async function withContext(what, run) {
  try {
    return await run();
  } catch (error) {
    throw new Error(`${what}（${error?.message || error}）`);
  }
}

function isPdf(bytes) {
  // 先頭 1 KB のどこかに %PDF- がある（前にごみの付いたファイルも PDF として読める）。
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

/**
 * 文字情報に番号が見つからなかった頁の余白を、画像として読む。
 *
 * @param {object} file
 * @param {(object|null)[]} scans 頁ごとの JPEG（scan-images.js）
 * @param {object[]} [pages] 読む頁
 */
async function readMarginsWithOcr(
  file,
  scans,
  pages = file.pages.filter((page) => page.candidates.length === 0)
) {
  if (pages.length === 0 || ocrFailed) return;
  file.status = 'ocr';
  try {
    showProgress('画像から文字を読む準備をしています（初回は数秒かかります）…', null);
    await prepareOcr();
  } catch (error) {
    ocrFailed = true;
    showMessage(`画像からの読み取りを使えませんでした（${error.message}）。文字情報だけで並べます。`, 'red');
    return;
  }

  let done = 0;
  const running = new Set();
  for (const page of pages) {
    const strips = await renderMargins(file.doc, page.index, scans[page.index] ?? null);
    if (!files.includes(file)) {
      strips.forEach((strip) => releaseCanvas(strip.canvas));
      return;
    }
    const job = Promise.all(
      strips.map((strip) => readStrip(strip).finally(() => releaseCanvas(strip.canvas)))
    )
      .then((results) => {
        page.candidates = mergeCandidates(page.candidates, pageNumberCandidates(results.flat(), 'ocr'));
        page.ocr = true;
      })
      .catch(() => {
        // 1 頁読めなくても続ける（その頁は前後から番号を補う）。
      })
      .finally(() => {
        running.delete(job);
        done++;
        file.detail = `画像から読み取り ${done} / ${pages.length} 頁`;
        showProgress(`「${file.name}」の余白を読み取っています（${done} / ${pages.length}）`, done / pages.length);
        if (done % 8 === 0) renderFiles();
      });
    running.add(job);
    if (running.size >= OCR_IN_FLIGHT) await Promise.race(running);
  }
  await Promise.all(running);
}

function mergeCandidates(a, b) {
  const byValue = new Map();
  for (const c of [...a, ...b]) {
    const previous = byValue.get(c.value);
    if (!previous || previous.score < c.score) byValue.set(c.value, c);
  }
  return [...byValue.values()].sort((x, y) => y.score - x.score);
}

function removeFile(file) {
  const at = files.indexOf(file);
  if (at < 0) return;
  files.splice(at, 1);
  for (const page of file.pages) {
    if (page.thumbUrl) URL.revokeObjectURL(page.thumbUrl);
    overrides.delete(page.key);
  }
  closePdf(file.doc).catch(() => {});
  refresh();
}

function moveFile(file, delta) {
  const at = files.indexOf(file);
  const to = at + delta;
  if (at < 0 || to < 0 || to >= files.length) return;
  files.splice(at, 1);
  files.splice(to, 0, file);
  refresh();
}

// --- 並べて確かめる ----------------------------------------------------------

function readyFiles() {
  return files.filter((file) => file.status === 'ready');
}

function pageOf(entry) {
  const file = files.find((f) => f.key === entry.fileKey);
  return file.pages[entry.pageIndex];
}

/** 並びと指摘を組み立て直し、画面を描き直す。結合した PDF は捨てる。 */
function refresh() {
  // 逆順のファイルは、ここで頁を並べ直してから番号を決める。
  const ready = readyFiles().map(orderedFile);
  const numberings = numberFiles(ready);
  const order = buildBookOrder(ready, numberings, overrides);
  const sheets = ready.some(
    (file) => file.role === 'body' && Math.abs(numberings.get(file.key)?.step ?? 0) === 2
  );
  const problems = checkSequence(order, { sheets });
  const { textless, problem } = textCoverage(order, pageOf);
  if (problem) problems.push(problem);

  const bodyPages = order
    .filter((entry) => entry.role === 'body')
    .map((entry) => {
      const page = pageOf(entry);
      return { key: entry.pageKey, side: sideOf(entry.number), size: page.size, measure: page.measure };
    });
  const issues = pageIssues(order, problems, compareScans(bodyPages), textless);

  view = { order, problems, issues, numberings };
  discardMerged();
  if (!$('outputName').value.trim() || $('outputName').dataset.suggested === 'true') {
    const suggested = suggestBookName(files.map((file) => file.name));
    $('outputName').value = suggested;
    $('outputName').dataset.suggested = 'true';
  }

  renderFiles();
  renderReview();
}

function discardMerged() {
  merged = null;
  $('downloadBtn').disabled = true;
  $('verifyResult').hidden = true;
}

// --- 描く：ファイルの一覧 ----------------------------------------------------

const STATUS_TEXT = {
  waiting: '順番待ち',
  loading: '読み込み中',
  reading: '頁を調査中',
  ocr: '余白を読み取り中',
  ready: '',
  error: '読み込めませんでした',
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function smallButton(text, title, onClick, className = 'secondary') {
  const button = el('button', className, text);
  button.type = 'button';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.addEventListener('click', onClick);
  return button;
}

function renderFiles() {
  const list = $('fileList');
  list.replaceChildren(...files.map(fileItem));
  $('checkSection').hidden = readyFiles().length === 0;
  $('outputSection').hidden = readyFiles().length === 0;
}

function fileItem(file, position) {
  const item = el('li', `bm-file${file.status === 'error' ? ' error' : ''}`);

  const head = el('div', 'bm-file-head');
  head.append(el('span', 'name', file.name));
  const actions = el('div', 'bm-file-buttons');
  actions.append(
    smallButton('↑', 'ひとつ上へ（先頭・末尾に置くファイルの順番）', () => moveFile(file, -1)),
    smallButton('↓', 'ひとつ下へ', () => moveFile(file, 1)),
    smallButton('外す', 'このファイルを外す', () => removeFile(file), 'secondary danger')
  );
  actions.firstChild.disabled = position === 0;
  actions.children[1].disabled = position === files.length - 1;
  head.append(actions);
  item.append(head);

  const meta = el('p', 'hint');
  if (file.status === 'error') {
    meta.textContent = file.error;
  } else if (file.status !== 'ready') {
    meta.textContent = [STATUS_TEXT[file.status], file.detail].filter(Boolean).join('・');
  } else {
    meta.textContent = fileSummary(file);
  }
  item.append(meta);

  if (file.status === 'ready') item.append(fileControls(file));
  return item;
}

function fileSummary(file) {
  const parts = [`${file.pages.length} 頁`];
  const numbering = view.numberings.get(file.key);
  if (file.role === 'body' && numbering) {
    parts.push(describeNumbering(numbering));
    const read = numbering.pages.filter((page) => page.status === 'detected').length;
    const byOcr = numbering.pages.filter(
      (page) => page.status === 'detected' && page.read?.source === 'ocr'
    ).length;
    parts.push(`番号を読めた頁 ${read}${byOcr ? `（うち画像から ${byOcr}）` : ''}`);
  }
  const textPages = file.pages.filter((page) => page.signature.length > 0).length;
  if (textPages < file.pages.length) parts.push(`文字情報なし ${file.pages.length - textPages} 頁`);
  return parts.join('・');
}

function fileControls(file) {
  const controls = el('div', 'bm-file-controls');

  const roleField = el('label', 'bm-inline');
  roleField.append('役割 ');
  const role = el('select');
  for (const [value, text] of Object.entries(ROLES)) {
    const option = el('option', null, text);
    option.value = value;
    option.selected = value === file.role;
    role.append(option);
  }
  role.addEventListener('change', () => {
    file.role = role.value;
    refresh();
  });
  roleField.append(role);
  controls.append(roleField);

  // 給紙口の都合で、最後の頁から並んでいるファイル。本文は頁番号から自動で
  // 並ぶので、効くのは主に表紙など番号の無いファイル（と手で決めた番号）。
  const reverseField = el('label', 'bm-inline');
  const reverse = el('input');
  reverse.type = 'checkbox';
  reverse.checked = file.reversed;
  reverse.addEventListener('change', () => {
    file.reversed = reverse.checked;
    refresh();
  });
  reverseField.append(reverse, ' 最後の頁から並んでいる（逆順）');
  controls.append(reverseField);

  if (file.role !== 'body') return controls;

  const numbering = view.numberings.get(file.key);
  const startField = el('label', 'bm-inline');
  startField.append('先頭の頁の番号 ');
  const start = el('input');
  start.type = 'text';
  start.inputMode = 'numeric';
  start.size = 5;
  start.placeholder = numbering?.pages[0]?.number?.toString() ?? '自動';
  start.value = file.manual ? String(file.manual.start) : '';
  startField.append(start);

  const stepField = el('label', 'bm-inline');
  stepField.append('進み方 ');
  const step = el('select');
  [
    ['', '自動'],
    ['2', '2 つずつ（奇数・偶数の束）'],
    ['-2', '2 つずつ逆順'],
    ['1', '1 つずつ（両面）'],
    ['-1', '1 つずつ逆順'],
  ].forEach(([value, text]) => {
    const option = el('option', null, text);
    option.value = value;
    option.selected = file.manual ? String(file.manual.step) === value : value === '';
    step.append(option);
  });
  stepField.append(step);

  const apply = () => {
    const value = start.value.trim();
    if (!value) {
      file.manual = null;
    } else {
      const number = Number(value);
      if (!Number.isInteger(number)) {
        showMessage('先頭の頁の番号は整数で入れてください。', 'red');
        return;
      }
      const chosen = Number(step.value) || numbering?.step || 2;
      file.manual = { start: number, step: chosen };
    }
    showMessage('');
    refresh();
  };
  start.addEventListener('change', apply);
  step.addEventListener('change', apply);
  controls.append(startField, stepField);
  const note = el('span', 'hint', '番号を読み違えているときだけ入れてください（空なら自動）。');
  controls.append(note);
  return controls;
}

// --- 描く：並びの確認 --------------------------------------------------------

function renderReview() {
  renderSummary();
  renderProblems();
  renderGrid();
}

function summaryBox(key, value) {
  const box = el('div', 'result-box');
  box.append(el('span', 'key', key), el('span', 'value', value));
  return box;
}

function renderSummary() {
  const { order, issues } = view;
  const body = order.filter((entry) => entry.role === 'body');
  const numbers = body.map((entry) => entry.number).filter(Number.isInteger);
  const covers = order.length - body.length;
  const flagged = order.filter((entry) => ['error', 'warn'].includes(worstLevel(issues.get(entry.pageKey)))).length;
  $('summary').replaceChildren(
    summaryBox('結合する頁', `${order.length} 頁`),
    summaryBox(
      '本文',
      numbers.length ? `${Math.min(...numbers)}〜${Math.max(...numbers)}（${body.length} 頁）` : `${body.length} 頁`
    ),
    summaryBox('表紙・裏表紙など', `${covers} 頁`),
    summaryBox('確認が要る頁', `${flagged} 頁`)
  );
}

function renderProblems() {
  const list = $('problems');
  const items = view.problems.map((problem) => {
    const item = el('li', `bm-problem ${problem.level}`);
    item.append(el('span', null, problem.message));
    if (problem.pageKeys?.length) {
      item.append(
        smallButton('見る', '該当する頁へ移動', () => scrollToPage(problem.pageKeys[0]))
      );
    }
    return item;
  });

  // スキャンの外れ値は頁ごとに付いているので、種類ごとの数にまとめて出す。
  const counts = new Map();
  for (const list of view.issues.values()) {
    for (const issue of list) {
      if (!['skew', 'shift', 'size', 'orientation', 'streak', 'blank', 'textless'].includes(issue.kind)) continue;
      counts.set(issue.kind, (counts.get(issue.kind) || 0) + 1);
    }
  }
  const SCAN_TEXT = {
    skew: ['warn', '傾いている頁'],
    shift: ['warn', '中身の位置がずれている頁'],
    size: ['warn', '大きさが他と違う頁'],
    orientation: ['warn', '向きが他と違う頁'],
    streak: ['warn', 'すじが入っている頁'],
    blank: ['info', '白紙の頁'],
    textless: ['info', '文字情報の無い頁'],
  };
  for (const [kind, count] of counts) {
    const [level, text] = SCAN_TEXT[kind];
    const item = el('li', `bm-problem ${level}`);
    item.append(el('span', null, `${text}が ${count} 頁あります。`));
    const first = view.order.find((entry) =>
      (view.issues.get(entry.pageKey) || []).some((issue) => issue.kind === kind)
    );
    if (first) item.append(smallButton('見る', '該当する頁へ移動', () => scrollToPage(first.pageKey)));
    items.push(item);
  }

  if (items.length === 0 && view.order.length) {
    items.push(el('li', 'bm-problem ok', '頁の抜け・重なり・スキャンの乱れは見つかりませんでした。'));
  }
  list.replaceChildren(...items);
}

function scrollToPage(pageKey) {
  if (filter !== 'all' && !document.querySelector(`[data-page-key="${pageKey}"]`)) {
    filter = 'all';
    document.querySelector('input[name="pageFilter"][value="all"]').checked = true;
    renderGrid();
  }
  const card = document.querySelector(`[data-page-key="${pageKey}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('focus');
  setTimeout(() => card.classList.remove('focus'), 1600);
}

function renderGrid() {
  const cards = [];
  for (const item of gridItems(view.order)) {
    if (item.type === 'missing') {
      const card = el('li', 'bm-page missing');
      card.append(
        el('span', 'bm-missing-label', item.from === item.to ? `${item.from} 頁` : `${item.from}〜${item.to} 頁`),
        el('span', 'hint', 'ありません')
      );
      cards.push(card);
      continue;
    }
    const issues = view.issues.get(item.entry.pageKey) || [];
    const level = worstLevel(issues);
    if (filter === 'issues' && level !== 'error' && level !== 'warn') continue;
    cards.push(pageCard(item.entry, issues, level));
  }
  $('pageGrid').replaceChildren(...cards);
}

function pageCard(entry, issues, level) {
  const file = files.find((f) => f.key === entry.fileKey);
  const page = file.pages[entry.pageIndex];
  const card = el('li', `bm-page${level ? ` ${level}` : ''}`);
  card.dataset.pageKey = entry.pageKey;

  const thumb = el('button', 'bm-thumb');
  thumb.type = 'button';
  thumb.title = '拡大して見る';
  const image = el('img');
  image.src = page.thumbUrl;
  image.alt = `${displayLabel(entry)}（${file.name} の ${entry.pageIndex + 1} 頁目）`;
  image.loading = 'lazy';
  thumb.append(image);
  thumb.addEventListener('click', () => openPreview(entry.pageKey));
  card.append(thumb);

  const label = el('div', 'bm-page-label');
  label.append(el('strong', null, displayLabel(entry)));
  const status = STATUS_LABEL[entry.status];
  if (status) label.append(el('span', `bm-status ${entry.status}`, status));
  card.append(label);
  card.append(el('div', 'bm-page-source', `${file.name}・${entry.pageIndex + 1}/${file.pages.length}`));

  if (issues.length) {
    const list = el('ul', 'bm-page-issues');
    for (const issue of issues) list.append(el('li', issue.level, issue.message));
    card.append(list);
  }

  if (entry.role === 'body') {
    const input = el('input', 'bm-page-number');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.placeholder = '番号を直す';
    input.setAttribute('aria-label', `${displayLabel(entry)} の番号を直す`);
    input.value = overrides.has(entry.pageKey) ? String(overrides.get(entry.pageKey)) : '';
    input.addEventListener('change', () => {
      const value = input.value.trim();
      if (!value) {
        overrides.delete(entry.pageKey);
      } else if (Number.isFinite(Number(value))) {
        overrides.set(entry.pageKey, Number(value));
      } else {
        showMessage('番号は数字で入れてください。', 'red');
        return;
      }
      showMessage('');
      refresh();
    });
    card.append(input);
  }
  return card;
}

// --- 拡大表示 ----------------------------------------------------------------

let previewUrl = '';
let previewKey = '';

async function openPreview(pageKey) {
  const at = view.order.findIndex((entry) => entry.pageKey === pageKey);
  if (at < 0) return;
  const entry = view.order[at];
  const file = files.find((f) => f.key === entry.fileKey);
  previewKey = pageKey;
  const dialog = $('previewDialog');
  $('previewTitle').textContent = `${displayLabel(entry)}（${file.name} の ${entry.pageIndex + 1} 頁目）`;
  $('previewIssues').textContent = (view.issues.get(pageKey) || []).map((i) => i.message).join(' / ');
  $('previewPrevBtn').disabled = at === 0;
  $('previewNextBtn').disabled = at === view.order.length - 1;
  const image = $('previewImage');
  image.src = file.pages[entry.pageIndex].thumbUrl;
  if (!dialog.open) dialog.showModal();
  try {
    const url = await renderPreview(file.doc, entry.pageIndex);
    if (previewKey !== pageKey) {
      URL.revokeObjectURL(url);
      return;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = url;
    image.src = url;
  } catch {
    // 大きく描けなくても、縮小画像は見えている。
  }
}

function stepPreview(delta) {
  const at = view.order.findIndex((entry) => entry.pageKey === previewKey);
  const next = view.order[at + delta];
  if (next) openPreview(next.pageKey);
}

function closePreview() {
  $('previewDialog').close();
  previewKey = '';
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = '';
}

// --- 結合と検証 --------------------------------------------------------------

function outputName() {
  return ensurePdfExtension($('outputName').value, DEFAULT_NAME);
}

async function mergeAndVerify() {
  const errors = view.problems.filter((problem) => problem.level === 'error');
  if (
    errors.length &&
    !window.confirm(
      `次の問題が残っています。\n\n${errors.map((p) => `・${p.message}`).join('\n')}\n\nこのまま結合しますか？`
    )
  ) {
    return;
  }

  const button = $('mergeBtn');
  button.disabled = true;
  discardMerged();
  showMessage('');
  const order = view.order;
  try {
    const fileName = outputName();
    const ranges = pageLabelRanges(order);
    const sources = new Map(readyFiles().map((file) => [file.key, { bytes: file.bytes, name: file.name }]));
    const infoFrom = order.find((entry) => entry.role === 'body')?.fileKey;
    showProgress('結合しています…', 0);
    // 結合の道具（pdf-lib）は、結合するときになってから読み込む。
    const { mergePdf, pageDigests } = await import('./merge.js');
    const { bytes, digests } = await mergePdf({
      sources,
      order,
      title: fileName.replace(/\.pdf$/i, ''),
      labels: ranges,
      infoFrom,
      onProgress: (done, total) => showProgress(`結合しています（${done} / ${total} 頁）`, done / total),
    });

    // 結合した PDF を読み直し、元の頁と突き合わせる（頁を描き直さないので軽い）。
    showProgress('結合した PDF を検証しています…', null);
    const mergedDigests = await pageDigests(bytes);
    const doc = await openPdf(bytes);
    const actual = [];
    for (let index = 0; index < doc.numPages; index++) {
      showProgress(`結合した PDF を検証しています（${index + 1} / ${doc.numPages} 頁）`, index / doc.numPages);
      const page = await withContext(`結合した PDF の ${index + 1} 頁目を検証できませんでした`, () =>
        readPageText(doc, index)
      );
      actual.push({ size: page.size, signature: page.signature, digest: mergedDigests[index] });
      if (index % 16 === 0) await breathe();
    }
    const labels = await doc.getPageLabels();
    const { info } = await doc.getMetadata();
    await closePdf(doc);

    const expected = order.map((entry, i) => {
      const page = pageOf(entry);
      return {
        pageKey: entry.pageKey,
        label: displayLabel(entry),
        size: page.size,
        signature: page.signature,
        digest: digests[i],
      };
    });
    const result = compareOutput(expected, actual);
    const wantLabels = pageLabelTexts(ranges, order.length);
    const labelsOk = Array.isArray(labels) && labels.every((label, i) => label === wantLabels[i]);
    merged = { bytes, fileName, result, labelsOk, title: info?.Title || '' };
    renderVerify();
    $('downloadBtn').disabled = false;
  } catch (error) {
    showMessage(error.message || String(error), 'red');
  } finally {
    showProgress('');
    button.disabled = false;
  }
}

function renderVerify() {
  const box = $('verifyResult');
  const { result, labelsOk, bytes, title } = merged;
  const ok = result.ok && labelsOk;
  box.className = `bm-verify ${ok ? 'ok' : 'ng'}`;
  const lines = [];
  lines.push(
    ok
      ? `検証できました。${result.pageCount.actual} 頁すべてが、元の頁と大きさ・文字情報・画像まで一致しています。`
      : `検証で食い違いが見つかりました（${result.mismatches.length} 頁）。`
  );
  if (result.pageCount.expected !== result.pageCount.actual) {
    lines.push(`頁の数が違います（並べた数 ${result.pageCount.expected}、結合した PDF ${result.pageCount.actual}）。`);
  }
  lines.push(
    `文字情報（検索できる文字）のある頁: ${result.textPages} / ${result.pageCount.actual} 頁。` +
      `頁ラベル（ビューアーに出る頁番号）: ${labelsOk ? '本の頁番号と一致' : '書き込みを確かめられませんでした'}。` +
      `タイトル: ${title || '（なし）'}。大きさ: ${megabytes(bytes.length)}。`
  );
  box.replaceChildren(...lines.map((line) => el('p', null, line)));
  if (result.mismatches.length) {
    const list = el('ul', 'bm-mismatches');
    for (const mismatch of result.mismatches.slice(0, 50)) {
      const item = el('li', null, `${mismatch.index + 1} 枚目（${mismatch.label}）: ${mismatch.reasons.join('・')}`);
      list.append(item);
    }
    if (result.mismatches.length > 50) list.append(el('li', null, `ほか ${result.mismatches.length - 50} 頁`));
    box.append(list);
  }
  box.hidden = false;
}

function download() {
  if (!merged) return;
  const url = URL.createObjectURL(new Blob([merged.bytes], { type: PDF_MIME }));
  const link = document.createElement('a');
  link.href = url;
  link.download = merged.fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // すぐに消すと、ダウンロードが始まる前に中身が無くなるブラウザがある。
  setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
}

// --- 入口 --------------------------------------------------------------------

async function addFromDrive() {
  const picked = await pickFiles({ title: 'スキャンした PDF を選択', mimeTypes: PDF_MIME });
  if (picked.length === 0) return;
  showMessage('');
  addDriveFiles(picked);
}

/** Drive のファイルを、名前の順に足す（束の番号が名前に付いていることが多い）。 */
function addDriveFiles(picked) {
  picked
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }))
    .forEach((file) =>
      addFile({
        name: file.name,
        driveId: file.id,
        load: (onProgress) => downloadDriveFile(file, { onProgress }),
      })
    );
}

function addLocal(fileList) {
  const pdfs = [...fileList].filter((file) => file.type === PDF_MIME || /\.pdf$/i.test(file.name));
  if (pdfs.length < fileList.length) showMessage('PDF 以外のファイルは外しました。', 'red');
  else showMessage('');
  pdfs
    .sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }))
    .forEach((file) =>
      addFile({
        name: file.name,
        load: async (onProgress) => {
          const bytes = new Uint8Array(await file.arrayBuffer());
          onProgress(bytes.length, bytes.length);
          return bytes;
        },
      })
    );
}

function wireUp() {
  $('driveBtn').addEventListener('click', addFromDrive);
  $('localBtn').addEventListener('click', () => $('localInput').click());
  $('localInput').addEventListener('change', (event) => {
    addLocal(event.target.files);
    event.target.value = '';
  });

  const zone = $('filesSection');
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('dragging');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('dragging');
    if (event.dataTransfer?.files?.length) addLocal(event.dataTransfer.files);
  });

  // 後から OCR を有効にしたときは、読み終えたファイルの残りの頁を読む。
  $('ocrToggle').addEventListener('change', () => {
    if (!$('ocrToggle').checked) return;
    for (const file of readyFiles()) {
      if (file.role !== 'body') continue;
      const pages = file.pages.filter((page) => page.candidates.length === 0 && !page.ocr);
      if (pages.length === 0) continue;
      queue = queue
        .then(async () => {
          await readMarginsWithOcr(file, await findScanImages(file.bytes), pages);
          file.status = 'ready';
          file.detail = '';
          showProgress('');
          refresh();
        })
        .catch(() => {});
    }
  });

  document.querySelectorAll('input[name="pageFilter"]').forEach((radio) =>
    radio.addEventListener('change', () => {
      filter = radio.value;
      renderGrid();
    })
  );
  $('outputName').addEventListener('input', () => {
    $('outputName').dataset.suggested = 'false';
    discardMerged();
  });
  $('mergeBtn').addEventListener('click', mergeAndVerify);
  $('downloadBtn').addEventListener('click', download);

  $('previewPrevBtn').addEventListener('click', () => stepPreview(-1));
  $('previewNextBtn').addEventListener('click', () => stepPreview(1));
  $('previewCloseBtn').addEventListener('click', closePreview);
  $('previewDialog').addEventListener('close', () => {
    if (previewKey) closePreview();
  });
}

startPage({
  usesApi: true,
  preparing: '準備をしています…',
  prepare: async () => {
    wireUp();
  },
});
