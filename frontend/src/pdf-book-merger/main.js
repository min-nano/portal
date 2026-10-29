// 書籍スキャン PDF 結合ツール。
//
// 裁断した本を分けてスキャンした PDF を、頁番号で 1 冊の順に並べて結合する。
// 判断（番号の推定・検査・並べ替え）・画像の展開・OCR・結合・検証は、すべて
// ブラウザの中で行う。サーバー（backend/app/tools/pdf_book_merger.py）が受け持つ
// のは、Drive の PDF を確かめて読み取り専用のトークンを渡すことだけ（中身は
// 通さない）。
//
//   1. ファイルを読む   Drive（そのトークンで直接。drive-download.js）
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
import { el } from '../components/form-field.js';
import { startPage } from '../page-start.js';
import { pickFiles } from '../drive-picker.js';
import { ensurePdfExtension } from '../pdf-file-ops.js';
import { downloadDriveFile } from './drive-download.js';
import { compareScans } from './image-checks.js';
import { savePdf } from './save-file.js';
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
import { numberingSequence, pageNumberCandidates } from './page-numbers.js';
import { findScanImages } from './scan-images.js';
import { pdfLibViews } from './pdf-lib-views.js';
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

/** 見出しの「?」からマウスを外して、説明を閉じるまでの猶予（説明の文へ動かす間）。 */
const HELP_LEAVE_MS = 300;

/** 同時に読み取る頁の数（OCR の worker の数より少し多くして、待ちを埋める）。 */
const OCR_IN_FLIGHT = 3;
/**
 * 同時に描く頁の数。600dpi のスキャンは頁ごとの JPEG の展開が重い（1 頁で
 * 0.2 秒ほど）が、展開は画面とは別のところで進むので、端末の芯を並べて使う。
 */
const PAGES_IN_FLIGHT = 3;

let nextKey = 1;
/** 選んだファイル（画面の並び順）。中身は addFile() を参照。 */
const files = [];
/** 頁ごとに手で直した番号（頁の key → 番号）。 */
const overrides = new Map();
/** 最後に組み立てた並びと指摘。 */
let view = { order: [], problems: [], issues: new Map(), numberings: new Map() };
/** 結合した PDF と検証の結果。並びが変わったら捨てる。 */
let merged = null;
/** 結合と検証の途中か（その間は、拡大表示のために PDF を開かない）。 */
let merging = false;
/** 結合する中身（並び・名前）が変わるたびに進める番号（結合の途中で変わったら、その結合は捨てる）。 */
let generation = 0;
/** いまの並びのうち、結合する PDF を決める部分（頁・扱い・頁番号）。変わったときだけ結合した PDF を捨てる。 */
let orderKey = '';
let filter = 'all';
// ファイルは 1 つずつ調べる（pdf.js も OCR も、同時に動かすと遅くなるだけなので）。
let queue = Promise.resolve();
// Drive からの読み込みは、調べるのを待たずに先へ進める（調べている間に、次の
// ファイルを読んでおく）。読み込みどうしは 1 つずつ。
let downloads = Promise.resolve();
let ocrStarting = null;

const $ = (id) => document.getElementById(id);

function showMessage(text, color = '') {
  const box = $('message');
  box.style.color = color;
  box.textContent = text;
  if (text) log(color === 'red' ? `【注意】${text}` : text);
}

// --- 進み具合と、ログ ------------------------------------------------------------
//
// 画面に出す進み具合は、プログレスバーとその横の短い見出し（何をしているか）
// だけにする。いま何頁目を調べているかといった細かい経過と、ファイルごとの
// 読み込み・調査の結果（大きさ・かかった時間など）は「ログ」に残す。
// 記録はふだん畳んでおき、うまく動かないときに開いてコピーしてもらう。
//
// バーは全体の進み具合を出す。仕事の流れ（ファイルを調べる流れと、結合）
// ごとに createProgress で進み具合を持ち、流れの中は段（読み込み・文字情報・
// 画像など）ごとに受け持つ区間を決め、段の中の割合をその区間に写す（段が
// 変わるたびにバーが空に戻らないように）。調べる流れは、待っている仕事
// （ファイルを調べる・あとからの OCR）のうち済んだ数に、いまの仕事の中の
// 進み具合を足したもの。結合は読み込みの途中でもできるので、結合している
// 間は結合を出し、済んだら調べる流れに戻す。

const logLines = [];
const LOG_LIMIT = 2000;

/**
 * 仕事の流れ 1 つの進み具合を作る。
 *
 * label は見出しを返す関数（バーの横に出す。出すたびに呼ぶ）。stage(from, to)
 * でいまの段の区間を決め、show(text, fraction, heading) で経過を出す。text は
 * 細かい経過（記録に出す）で、空なら済んだとして隠す。fraction は段の中の割合
 * （分からなければ null。バーは進み具合の分からない表示にする）。heading を
 * 渡すと、見出しの代わりにそれを出す（Drive を待っているときなど、見出しより
 * 先に知らせたいこと）。
 *
 * jobs を持つ流れでは、仕事を足しても（addJob）バーが戻らないように、足した
 * ときの位置から残りを数え直す。
 */
function createProgress({ jobs = false } = {}) {
  const progress = {
    label: () => '',
    from: 0,
    to: 1,
    text: '',
    fraction: null,
    heading: '',
    // 仕事の数・済んだ数と、数え直したときのバーの位置（base）と仕事の位置（start）。
    jobs: jobs ? { total: 0, done: 0, base: 0, start: 0 } : null,
    stage(from, to) {
      progress.from = from;
      progress.to = to;
    },
    show(text, fraction, heading = '') {
      Object.assign(progress, { text, fraction, heading });
      if (!text) {
        progress.label = () => '';
        progress.stage(0, 1);
        progress.fraction = null;
      }
      renderProgress();
    },
    /** いまの仕事の中の位置（0〜1）。 */
    inJob() {
      const fraction = Math.max(0, Math.min(1, progress.fraction ?? 0));
      return progress.from + (progress.to - progress.from) * fraction;
    },
    /** 流れ全体の位置（0〜1）。 */
    overall() {
      const { jobs } = progress;
      if (!jobs?.total) return progress.inJob();
      const at = jobs.done + progress.inJob();
      return Math.min(1, jobs.base + ((1 - jobs.base) * (at - jobs.start)) / (jobs.total - jobs.start));
    },
    addJob() {
      const { jobs } = progress;
      // 途中で足したときは、いまの位置から残りを数え直す（バーを戻さない）。
      if (jobs.total > jobs.done) {
        jobs.base = progress.overall();
        jobs.start = jobs.done + progress.inJob();
      }
      jobs.total++;
    },
    finishJob() {
      const { jobs } = progress;
      jobs.done++;
      if (jobs.done >= jobs.total) Object.assign(jobs, { total: 0, done: 0, base: 0, start: 0 });
    },
  };
  return progress;
}

/** ファイルを調べる流れ（あとからの OCR も）。 */
const readProgress = createProgress({ jobs: true });
/** 結合と検証。 */
const mergeProgress = createProgress();

/** 進み具合を描く。結合している間は結合を、そうでなければ調べる流れを出す。 */
function renderProgress() {
  const progress = mergeProgress.text ? mergeProgress : readProgress;
  $('progress').hidden = !progress.text;
  $('progressText').textContent = progress.text ? progress.heading || progress.label() || progress.text : '';
  const bar = $('progressBar');
  if (progress.fraction === null) bar.removeAttribute('value');
  else if (progress.text) bar.value = progress.overall();
  renderLog();
}

/** 調べる流れの進み具合を出す（ほとんどの経過はこちら）。 */
function showProgress(text, fraction, heading = '') {
  readProgress.show(text, fraction, heading);
}

/** 仕事を順番待ちに足す（ファイルを調べる・あとからの OCR）。済んだら数える。 */
function enqueue(task) {
  readProgress.addJob();
  queue = queue
    .then(task)
    .catch(() => {})
    .then(() => readProgress.finishJob());
}

/** ログに 1 行足す（時刻付き）。 */
function log(text) {
  const time = new Date().toLocaleTimeString('ja-JP', { hour12: false });
  logLines.push(`${time} ${text}`);
  if (logLines.length > LOG_LIMIT) logLines.splice(0, logLines.length - LOG_LIMIT);
  $('logBox').hidden = false;
  renderLog();
}

function logText() {
  const running = [mergeProgress.text, readProgress.text].filter(Boolean).map((text) => `（実行中）${text}`);
  return [...logLines, ...running].join('\n');
}

function renderLog() {
  // 畳んでいる間は描かない（頁ごとに描き直すと無駄なので、開いたときに描く）。
  if ($('logBox').open) $('logText').textContent = logText();
}

async function copyLog() {
  const button = $('logCopyBtn');
  try {
    await navigator.clipboard.writeText(logText());
    button.textContent = 'コピーしました';
  } catch {
    // 書き込めないブラウザでは、選んだ状態にして手でコピーしてもらう。
    const range = document.createRange();
    range.selectNodeContents($('logText'));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    button.textContent = '選びました。コピーしてください';
  }
  setTimeout(() => (button.textContent = 'ログをコピー'), 2000);
}

function seconds(since) {
  return `${((performance.now() - since) / 1000).toFixed(1)} 秒`;
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
    status: 'waiting', // waiting → loading → loaded → reading → ocr → ready / error
    error: '',
    role: 'body',
    manual: null,
    coverStart: null, // 先頭・末尾に置くファイルの並べ順（先頭の頁の番号）
    reversed: false,
    open: false, // 一覧で設定の欄を開いているか（描き直しても保つ）
    bytes: null,
    doc: null,
    pages: [],
  };
  files.push(file);
  renderFiles();
  log(`「${file.name}」を追加しました（${source.driveId ? 'Drive' : 'この端末'}）`);
  file.loaded = downloads.then(() => loadBytes(file, source));
  downloads = file.loaded.catch(() => {});
  file.pending = true; // 調べ終えるまで（見出しの「n / m」に使う）
  enqueue(async () => {
    try {
      await readFile(file);
    } finally {
      file.pending = false;
    }
  });
}

/**
 * Drive の読み込みを待っていることを、見出しに出す（見出しより先に知らせる）。
 * 待っている間は 1 秒ごとに残りの秒数を出し直し、待ち終えたら読み直していると出す
 * （最初のデータが届けば、進み具合に替わる）。
 */
function showWaiting(file) {
  clearTimeout(file.waitTimer);
  if (!file.waiting || !file.waitUntil || !files.includes(file)) return;
  const ms = file.waitUntil - Date.now();
  if (ms <= 0) {
    showProgress(`「${file.name}」を読み直しています`, null);
    return;
  }
  const heading = `「${file.name}」の読み込みを待っています（${file.waitReason}・あと ${Math.ceil(ms / 1000)} 秒ほど）`;
  showProgress(heading, null, heading);
  file.waitTimer = setTimeout(() => showWaiting(file), ms % 1000 || 1000);
}

/**
 * ファイルの中身を読み（Drive なら転送）、file.bytes に入れる。
 *
 * 中身は file.bytes にだけ持つ（読み込みの約束には残さない）。調べられなかった
 * ファイルや外したファイルは、file.bytes を捨てればメモリが空く。
 */
async function loadBytes(file, source) {
  if (!files.includes(file)) return;
  file.status = 'loading';
  renderFiles();
  const started = performance.now();
  let bytes;
  try {
    bytes = await source.load(
      (received, total) => {
        file.waitUntil = 0; // 届き始めた（待ち終えた）
        clearTimeout(file.waitTimer);
        // 調べる順番が来て、読み込みを待っているときだけ、進み具合に出す。
        if (!file.waiting) return;
        const amount = total ? `${megabytes(received)} / ${megabytes(total)}` : megabytes(received);
        showProgress(`「${file.name}」を読み込んでいます（${amount}）`, total ? received / total : null);
      },
      // 読み直す前に待つときは、記録に残し、待っていることを画面に出す（先読みの
      // 途中なら、調べる順番が来たときに出す。readFile）。
      (ms, reason) => {
        log(`「${file.name}」の読み込みを ${Math.round(ms / 1000)} 秒待ってから読み直します（${reason}）`);
        file.waitUntil = Date.now() + ms;
        file.waitReason = reason;
        if (file.waiting) showWaiting(file);
      }
    );
  } catch (error) {
    log(`「${file.name}」を読み込めませんでした（${error?.message || error}）`);
    throw error;
  }
  log(`「${file.name}」を読み込みました（${megabytes(bytes.length)}、${seconds(started)}）`);
  if (!files.includes(file)) return; // 読んでいる間に外された。
  file.bytes = bytes;
  if (file.status === 'loading') {
    file.status = 'loaded';
    renderFiles();
  }
}

async function readFile(file) {
  if (!files.includes(file)) return; // 読む前に外された。
  const started = performance.now();
  let held = false; // pdf.js で開いて使っているか（終えたら手放す）
  try {
    // 何番目かは、調べ終えたファイルの数から数える（あとからの OCR は数えない）。
    readProgress.label = () =>
      `ファイルを調べています（${files.filter((f) => !f.pending).length + 1} / ${files.length}）`;
    // 段ごとの区間。Drive の読み込みを待つ（先読みが済んでいない）ときは、
    // 読み込みにも区間を分ける（大きなファイルは読み込みに数分かかる。この端末の
    // ファイルはすぐ読み終えるので分けない）。
    const loadEnd = file.driveId && !file.bytes ? 0.3 : 0;
    const textEnd = loadEnd + (1 - loadEnd) * 0.1;
    readProgress.stage(0, loadEnd);
    file.waiting = true;
    if (file.waitUntil > Date.now()) showWaiting(file);
    else if (file.status !== 'loaded') showProgress(`「${file.name}」を読み込んでいます`, null);
    await file.loaded;
    file.waiting = false;
    clearTimeout(file.waitTimer);
    if (!file.bytes || !files.includes(file)) return;
    if (!isPdf(file.bytes)) throw new Error('PDF ファイルではありません。');

    file.status = 'reading';
    holdDoc(file);
    held = true;
    await withContext('PDF として開けませんでした', () => pdfOf(file));
    const count = file.doc.numPages;

    // 文字情報（画像を展開しないので軽い）。
    readProgress.stage(loadEnd, textEnd);
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
        scan: null,
      });
      if (index % 16 === 0) await breathe();
    }
    const textPages = file.pages.filter((page) => page.signature.length > 0).length;
    const textNumbers = file.pages.filter((page) => page.candidates.length > 0).length;
    log(`「${file.name}」の文字情報を読みました（${count} 頁、文字情報のある頁 ${textPages}、番号が見つかった頁 ${textNumbers}）`);

    // 文字情報に番号の無い頁は、画像の余白を OCR する。名前で表紙と分かる
    // もののほかは、扱いを決める前に番号を読み切る（文字情報の無い束も、画像
    // から番号が読めれば本文と分かる）。OCR の準備は、画像を描く間に進める。
    const ocrPages = new Set(
      !roleFromName(file.name)
        ? file.pages.filter((page) => page.candidates.length === 0).map((page) => page.index)
        : []
    );
    if (ocrPages.size) startOcr();
    readProgress.stage(textEnd, 1);

    // 頁の画像を描いて測る（重いところ）。JPEG のまま描ける頁を先に調べておく。
    // 調べた JPEG は読み終えたら手放す（ファイルと同じだけの大きさがある）。
    showProgress(`「${file.name}」の頁の画像を調べています`, null);
    const imagesStarted = performance.now();
    const { scans, reasons, example } = await findScanImages(file.bytes);
    const jpegPages = scans.filter(Boolean).length;
    if (jpegPages < count) {
      const why = [...reasons].map(([reason, pages]) => `${reason} ${pages} 頁`).join('、');
      log(`「${file.name}」の ${count - jpegPages} 頁は pdf.js で描きます（${why || '理由不明'}）。${example}`);
    }
    await analyzePages(file, scans, ocrPages);
    // あとから本文に変えたとき（名前で表紙と見て OCR しなかったファイル）の
    // ために、番号の見つかっていない頁の JPEG を残す（PDF 全体を読み直さずに
    // 済む）。JPEG はファイルのバイト列の一部を指すだけなので（pdf-lib-views.js）、
    // 残してもメモリはほとんど使わない。その書き換えが効いていないと JPEG は
    // 写しなので、残さずに、あとで調べ直す。
    if (pdfLibViews) {
      for (const page of file.pages) {
        if (page.candidates.length === 0 && !page.ocr) page.scan = scans[page.index] ?? null;
      }
    }
    const byOcr = file.pages.filter((page) => page.ocr && page.candidates.some((c) => c.source === 'ocr')).length;
    log(
      `「${file.name}」の頁の画像を調べました（JPEG のまま展開 ${jpegPages} / ${count} 頁、` +
        `余白を OCR ${ocrPages.size} 頁・うち番号が読めた頁 ${byOcr}、${seconds(imagesStarted)}）`
    );

    file.role = guessRole(file.name, file.pages);
    file.status = 'ready';
    log(`「${file.name}」を調べ終えました（${ROLES[file.role]}、合計 ${seconds(started)}）`);
  } catch (error) {
    file.status = 'error';
    file.error = error.message || String(error);
    log(`「${file.name}」を調べられませんでした（${file.error}）`);
    // 調べられなかったファイルは結合に使わないので、外されるのを待たずに、
    // PDF の中身（読み込みの結果に残るものも）と縮小画像を手放す。
    file.bytes = null;
    file.loaded = null;
    for (const page of file.pages) {
      if (page.thumbUrl) URL.revokeObjectURL(page.thumbUrl);
      page.thumbUrl = '';
      page.scan = null;
    }
  } finally {
    if (held) releaseDoc(file);
    showProgress('');
    if (files.includes(file)) refresh();
  }
}

/** OCR を用意する（1 度だけ）。使えなければ false（文字情報だけで並べる）。 */
function startOcr() {
  ocrStarting ??= prepareOcr().then(
    () => true,
    (error) => {
      showMessage(`画像からの読み取りを使えませんでした（${error.message}）。文字情報だけで並べます。`, 'red');
      return false;
    }
  );
  return ocrStarting;
}

/** 同時に進める数を limit までにする（空きを待つ take と、返す give）。 */
function slots(limit) {
  let free = limit;
  const waiting = [];
  return {
    async take() {
      if (free > 0) {
        free--;
        return;
      }
      await new Promise((resolve) => waiting.push(resolve));
    },
    give() {
      const next = waiting.shift();
      if (next) next();
      else free++;
    },
  };
}

/** items を、同時に limit 個までの run で処理する。 */
async function inPool(items, limit, run) {
  let next = 0;
  let failure = null; // 最初の失敗（1 つ失敗したら、残りは始めない）
  const worker = async () => {
    while (!failure && next < items.length) {
      try {
        await run(items[next++]);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  // 失敗しても、動いている run が終わるまで待ってから、最初の失敗を返す（描き
  // かけの頁を残したまま、次のファイルへ進まないように）。
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure.error;
}

/**
 * 頁の画像を描いて測り、一覧の縮小画像を付ける。OCR する頁は、同じ展開から
 * 余白の帯も描いて読む（600dpi のスキャンは展開が重いので、1 頁につき 1 回）。
 *
 * 何頁かを並べて描き、測るのは worker（measure-client.js）、読むのは OCR の
 * worker。帯は読み終えるまで手元に置くので、読みが追いつかないときは描くのを
 * 待つ（数百頁ぶんの帯を抱えないように）。
 *
 * @param {object} file
 * @param {(object|null)[]} scans 頁ごとの JPEG（scan-images.js。無い頁は pdf.js で描く）
 * @param {Set<number>} ocrPages 余白を OCR する頁の位置
 */
async function analyzePages(file, scans, ocrPages) {
  const count = file.pages.length;
  let measured = 0;
  let read = 0;
  let failed = false;
  const report = () => {
    // 失敗したあとに描き終えた頁は、次のファイルの進み具合を上書きしない。
    if (failed) return;
    const parts = [`頁の画像を調べています ${measured} / ${count}`];
    if (ocrPages.size) parts.push(`余白の読み取り ${read} / ${ocrPages.size}`);
    showProgress(`「${file.name}」の${parts.join('・')}`, (measured + read) / (count + ocrPages.size));
    if ((measured + read) % 8 === 0) renderFiles();
  };
  const ocrSlots = slots(OCR_IN_FLIGHT);
  const reading = [];

  const error = await inPool(file.pages, PAGES_IN_FLIGHT, async (page) => {
    if (!files.includes(file)) return;
    const wantsOcr = ocrPages.has(page.index);
    if (wantsOcr) await ocrSlots.take();
    const { image, thumbUrl, strips } = await withContext(`${page.index + 1} 頁目の画像を描けませんでした`, () =>
      renderPageImage(file.doc, page.index, scans[page.index] ?? null, { margins: wantsOcr })
    ).catch((error) => {
      if (wantsOcr) ocrSlots.give();
      throw error;
    });
    page.thumbUrl = thumbUrl;
    if (wantsOcr) {
      reading.push(
        readStrips(file, page, strips).finally(() => {
          ocrSlots.give();
          read++;
          report();
        })
      );
    }
    // 画素は測ったら捨てる（数百頁ぶん抱えるとメモリが足りなくなる）。
    page.measure = await measure(image);
    measured++;
    report();
  }).then(
    () => null,
    (reason) => {
      failed = true;
      return reason;
    }
  );
  // 読み取りも終わるのを待つ（失敗したときも。readStrips は失敗を投げない）。
  await Promise.all(reading);
  if (failed) throw error;
}

/** 1 頁の余白の帯を OCR して、番号の候補に足す。帯は読み終えたら手放す。 */
async function readStrips(file, page, strips) {
  try {
    if (!files.includes(file) || !(await startOcr())) return;
    const results = await Promise.all(strips.map((strip) => readStrip(strip)));
    page.candidates = mergeCandidates(page.candidates, pageNumberCandidates(results.flat(), 'ocr'));
    page.ocr = true;
    page.scan = null;
  } catch {
    // 1 頁読めなくても続ける（その頁は前後から番号を補う）。
  } finally {
    strips.forEach((strip) => releaseCanvas(strip.canvas));
  }
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
 * 読み終えたファイルの、番号の見つかっていない頁の余白を OCR する（あとから
 * 本文に変えたとき）。読んでいる間も、ファイルは並びに入れたままにする
 * （頁が抜けて見えないように）。読み終えたら並べ直す。
 *
 * @param {object} file
 * @param {object[]} pages 読む頁（page.scan の JPEG で描く）
 */
async function readMarginsWithOcr(file, pages) {
  if (pages.length === 0 || !(await startOcr())) return;
  if (!files.includes(file)) return; // 順番を待つ間に外された。
  readProgress.label = () => '余白を読み取っています';
  // JPEG を残していなければ（pdf-lib の書き換えが効いていないとき）、ここで
  // 1 度だけ調べ直し、読む頁の分だけを取っておく。
  if (!pdfLibViews) {
    readProgress.stage(0, 0.1);
    showProgress(`「${file.name}」の頁の画像を調べ直しています`, null);
    const { scans } = await findScanImages(file.bytes);
    for (const page of pages) page.scan = scans[page.index] ?? null;
    readProgress.stage(0.1, 1);
  }
  log(`「${file.name}」の余白を OCR します（${pages.length} 頁）`);
  let done = 0;
  const ocrSlots = slots(OCR_IN_FLIGHT);
  const reading = [];
  for (const page of pages) {
    if (!files.includes(file)) break;
    await ocrSlots.take();
    let strips;
    try {
      strips = await renderMargins(await pdfOf(file), page.index, page.scan);
      // 描いたら JPEG は要らない（書き換えが効かないときは写しなので、早く手放す）。
      page.scan = null;
    } catch {
      ocrSlots.give();
      continue;
    }
    reading.push(
      readStrips(file, page, strips).finally(() => {
        ocrSlots.give();
        done++;
        showProgress(`「${file.name}」の余白を読み取っています（${done} / ${pages.length}）`, done / pages.length);
        if (done % 8 === 0) renderFiles();
      })
    );
  }
  await Promise.all(reading);
}

/** 読み終えたファイルの、番号の見つかっていない頁の OCR を頼む（あとから本文に変えたとき）。 */
function queueLateOcr(file) {
  // 読んでいる最中のファイルは、もう一度は頼まない（切り替えを繰り返しても
  // 同じ頁を 2 度読まない）。
  if (file.role !== 'body' || file.ocrBusy) return;
  const pages = file.pages.filter((page) => page.candidates.length === 0 && !page.ocr);
  if (pages.length === 0) return;
  file.ocrBusy = true;
  renderFiles();
  enqueue(async () => {
    try {
      // 読む間だけ開いておく（順番を待っている間は開かない）。
      holdDoc(file);
      await readMarginsWithOcr(file, pages).finally(() => releaseDoc(file));
    } finally {
      file.ocrBusy = false;
      for (const page of pages) page.scan = null;
      showProgress('');
      if (files.includes(file)) refresh();
    }
  });
}

/**
 * ファイルを pdf.js で開く（閉じていれば開き直す）。
 *
 * pdf.js はファイルの写しを worker に持つので、開いたままにすると、ファイルの
 * 数だけ本がもう 1 冊ぶんメモリに乗る（iPhone・iPad では、結合のときに落ちた）。
 * 使う処理（調べる・あとからの OCR・拡大表示）が holdDoc で使い始めを知らせ、
 * releaseDoc で済んだことを知らせる。使う処理が 1 つも無くなったら閉じる。
 */
function pdfOf(file) {
  if (!file.opening) {
    const opening = openPdf(file.bytes).then(
      (doc) => {
        // 開いている間に閉じられていたら、開いたものはすぐ閉じる（閉じた文書を残さない）。
        if (file.opening !== opening) {
          closePdf(doc).catch(() => {});
          throw new Error('PDF を閉じました。');
        }
        file.doc = doc;
        return doc;
      },
      (error) => {
        if (file.opening === opening) file.opening = null;
        throw error;
      }
    );
    file.opening = opening;
  }
  return file.opening;
}

/** ファイルを使い始める（使い終えるまで閉じない）。 */
function holdDoc(file) {
  file.docUsers = (file.docUsers || 0) + 1;
}

/** ファイルを使い終える。ほかに使っている処理が無ければ閉じる。 */
function releaseDoc(file) {
  file.docUsers = (file.docUsers || 0) - 1;
  if (file.docUsers < 0) {
    log(`「${file.name}」の PDF を使い終える数が合いません（内部の食い違い）`);
    file.docUsers = 0;
  }
  if (file.docUsers === 0) closeDoc(file);
}

/** pdf.js で開いたファイルを閉じる（worker の写しを手放す）。 */
function closeDoc(file) {
  const opening = file.opening;
  file.opening = null;
  file.doc = null;
  opening?.then(closePdf).catch(() => {});
}

/**
 * 拡大表示で開いておくファイル。拡大表示の間は、同じファイルの頁を行き来しても
 * 開き直さない。拡大表示を閉じたら手放す。
 */
let previewFile = null;

function setPreviewFile(file) {
  if (previewFile === file) return;
  const previous = previewFile;
  previewFile = file;
  if (file) holdDoc(file);
  if (previous) releaseDoc(previous);
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
  log(`「${file.name}」を削除しました`);
  for (const page of file.pages) {
    if (page.thumbUrl) URL.revokeObjectURL(page.thumbUrl);
    overrides.delete(page.key);
  }
  // 使っている処理（調べる・OCR）があれば、その最後の releaseDoc で閉じる
  // （描いている途中の文書を壊さない）。使っていなければ、ここで閉じる。
  if (previewFile === file) setPreviewFile(null);
  if (!file.docUsers) closeDoc(file);
  file.bytes = null;
  file.loaded = null;
  for (const page of file.pages) page.scan = null; // バイト列の一部を指しているので
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
  if (!$('outputName').value.trim() || $('outputName').dataset.suggested === 'true') {
    const suggested = suggestBookName(files.map((file) => file.name));
    $('outputName').value = suggested;
    $('outputName').dataset.suggested = 'true';
  }
  // 裏の処理（ほかのファイルの読み込み・OCR）が終わっただけで、結合する中身
  // （頁・扱い・頁番号と、名前）が変わらなければ、結合した PDF はそのまま使える。
  // 名前は提案し直すことがあるので、ここで一緒に比べる。
  const key = mergeKey();
  if (key !== orderKey) {
    orderKey = key;
    discardMerged();
  }

  renderFiles();
  renderReview();
}

/** 結合する中身（名前と、並びの頁・扱い・頁番号）を 1 つの文字列にしたもの。 */
function mergeKey() {
  return [outputName(), ...view.order.map((entry) => `${entry.pageKey}|${entry.role}|${entry.number}`)].join('\n');
}

function discardMerged() {
  generation++;
  merged = null;
  $('downloadBtn').disabled = true;
  $('verifyResult').hidden = true;
}

// --- 描く：ファイルの一覧 ----------------------------------------------------

const STATUS_TEXT = {
  waiting: '順番待ち',
  loading: '読み込み中',
  loaded: '読み込み済み（調べる順番待ち）',
  reading: '頁を調査中',
  ready: '',
  error: '読み込めませんでした',
};

function smallButton(text, title, onClick, className = 'secondary') {
  const button = el(document, 'button', className, text);
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

// ファイルは 1 つずつ折り畳める（<portal-section>）。束が何ファイルもあると
// 設定の欄で一覧が長くなるので、既定は閉じておき、見出しの行には名前と
// 設定の要約の 2 行だけを残す。開け閉めは描き直しても保つ。
function fileItem(file) {
  const item = el(document, 'li');
  const ready = file.status === 'ready';
  const section = el(
    document,
    'portal-section',
    `bm-file${ready ? ' ready' : ''}${file.status === 'error' ? ' error' : ''}`
  );
  section.setAttribute('label', file.name);
  if (!(ready && file.open)) section.setAttribute('collapsed', '');
  section.addEventListener('section-toggle', (event) => {
    // 読み込みが済むまでは、開いても中身（設定の欄）が無い。
    if (!ready) section.open = false;
    else file.open = event.detail.open;
  });

  const head = el(document, 'div', 'bm-file-head');
  head.slot = 'title';
  head.append(el(document, 'span', 'name', file.name));
  head.append(el(document, 'p', 'hint', fileMeta(file)));
  section.append(head);

  const remove = smallButton('削除', 'このファイルを削除', () => removeFile(file), 'secondary danger');
  remove.slot = 'actions';
  section.append(remove);

  if (ready) {
    const details = fileDetails(file);
    if (details) section.append(el(document, 'p', 'hint bm-file-details', details));
    section.append(fileControls(file));
  }
  item.append(section);
  return item;
}

const ROLE_SHORT = {
  body: '本文',
  front: '先頭に置く',
  back: '末尾に置く',
  split: '前半を先頭・後半を末尾',
  exclude: '結合しない',
};

/**
 * 見出しの 2 行目。読み込みの経過か、扱いと設定の要約（本文なら頁番号を並べて。
 * 例: 本文(頁番号: -11, -9, -7...13, 15)）。
 */
function fileMeta(file) {
  if (file.status === 'error') return file.error;
  if (file.status !== 'ready') return STATUS_TEXT[file.status];
  const details = [];
  const numbering = file.role === 'body' ? view.numberings.get(file.key) : null;
  if (numbering) {
    details.push(`頁番号: ${numberingSequence(numbering)}`);
    if (file.manual) details.push('手入力');
  } else {
    details.push(`${file.pages.length} 頁`);
    if (file.role !== 'exclude' && Number.isInteger(file.coverStart)) {
      details.push(`先頭の頁の番号 ${file.coverStart}`);
    }
  }
  if (file.reversed) details.push('最後の頁から');
  if (file.ocrBusy) details.push('余白を読み取り中');
  return `${ROLE_SHORT[file.role]}(${details.join(', ')})`;
}

/** 開いたときに出す、読み取りの内訳（番号を読めた頁の数・文字情報の無い頁）。 */
function fileDetails(file) {
  const parts = [];
  const numbering = file.role === 'body' ? view.numberings.get(file.key) : null;
  if (numbering) {
    const read = numbering.pages.filter((page) => page.status === 'detected').length;
    const byOcr = numbering.pages.filter(
      (page) => page.status === 'detected' && page.read?.source === 'ocr'
    ).length;
    parts.push(`${file.pages.length} 頁のうち番号を読めた頁 ${read}${byOcr ? `（うち画像から ${byOcr}）` : ''}`);
  }
  const textPages = file.pages.filter((page) => page.signature.length > 0).length;
  if (textPages < file.pages.length) parts.push(`文字情報なし ${file.pages.length - textPages} 頁`);
  return parts.join('・');
}

function fileControls(file) {
  const controls = el(document, 'div', 'bm-file-controls');

  const roleField = el(document, 'label', 'bm-inline');
  roleField.append('扱い ');
  const role = el(document, 'select');
  for (const [value, text] of Object.entries(ROLES)) {
    const option = el(document, 'option', null, text);
    option.value = value;
    option.selected = value === file.role;
    role.append(option);
  }
  role.addEventListener('change', () => {
    file.role = role.value;
    // 名前で表紙と見て余白を読まなかったファイルも、本文にしたら読む。
    queueLateOcr(file);
    refresh();
  });
  roleField.append(role);
  controls.append(roleField);

  // 給紙口の都合で、最後の頁から並んでいるファイル。本文は頁番号から自動で
  // 並ぶので、効くのは主に表紙など番号の無いファイル（と手で決めた番号）。
  const reverseField = el(document, 'label', 'bm-inline');
  const reverse = el(document, 'input');
  reverse.type = 'checkbox';
  reverse.checked = file.reversed;
  reverse.addEventListener('change', () => {
    file.reversed = reverse.checked;
    refresh();
  });
  reverseField.append(reverse, ' 最後の頁から並んでいる（逆順）');
  controls.append(reverseField);

  if (file.role === 'exclude') return controls;
  if (file.role !== 'body') return coverControls(file, controls);

  const numbering = view.numberings.get(file.key);
  const startField = el(document, 'label', 'bm-inline');
  startField.append('先頭の頁の番号 ');
  const start = el(document, 'input');
  start.type = 'text';
  start.inputMode = 'numeric';
  start.size = 5;
  start.placeholder = numbering?.pages[0]?.number?.toString() ?? '自動';
  start.value = file.manual ? String(file.manual.start) : '';
  startField.append(start);

  const stepField = el(document, 'label', 'bm-inline');
  stepField.append('進み方 ');
  const step = el(document, 'select');
  [
    ['', '自動'],
    ['2', '2 つずつ（奇数・偶数の束）'],
    ['-2', '2 つずつ逆順'],
    ['1', '1 つずつ（両面）'],
    ['-1', '1 つずつ逆順'],
  ].forEach(([value, text]) => {
    const option = el(document, 'option', null, text);
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
  const note = el(document, 'span', 'hint', '番号を読み違えているときだけ入れてください（空なら自動）。');
  controls.append(note);
  return controls;
}

/**
 * 先頭・末尾に置くファイルの「先頭の頁の番号」。表紙などが何ファイルかある
 * ときに、先頭（末尾）の中での並べ順を決める（頁は 1 つずつ進む）。
 */
function coverControls(file, controls) {
  const startField = el(document, 'label', 'bm-inline');
  startField.append('先頭の頁の番号 ');
  const start = el(document, 'input');
  start.type = 'text';
  start.inputMode = 'numeric';
  start.size = 5;
  start.placeholder = '順番';
  start.value = Number.isInteger(file.coverStart) ? String(file.coverStart) : '';
  start.addEventListener('change', () => {
    const value = start.value.trim();
    const number = Number(value);
    if (value && !Number.isInteger(number)) {
      showMessage('先頭の頁の番号は整数で入れてください。', 'red');
      return;
    }
    file.coverStart = value ? number : null;
    showMessage('');
    refresh();
  });
  startField.append(start);
  controls.append(startField);
  const note = el(
    document,
    'span',
    'hint',
    '先頭（末尾）に置くファイルが何ファイルかあるとき、その中での順番です（番号の小さい順。空なら追加した順で、番号を入れたものの後ろ）。'
  );
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
  const box = el(document, 'div', 'result-box');
  box.append(el(document, 'span', 'key', key), el(document, 'span', 'value', value));
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
    const item = el(document, 'li', `bm-problem ${problem.level}`);
    item.append(el(document, 'span', null, problem.message));
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
    const item = el(document, 'li', `bm-problem ${level}`);
    item.append(el(document, 'span', null, `${text}が ${count} 頁あります。`));
    const first = view.order.find((entry) =>
      (view.issues.get(entry.pageKey) || []).some((issue) => issue.kind === kind)
    );
    if (first) item.append(smallButton('見る', '該当する頁へ移動', () => scrollToPage(first.pageKey)));
    items.push(item);
  }

  if (items.length === 0 && view.order.length) {
    items.push(el(document, 'li', 'bm-problem ok', '頁の抜け・重なり・スキャンの乱れは見つかりませんでした。'));
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
      const card = el(document, 'li', 'bm-page missing');
      card.append(
        el(document, 'span', 'bm-missing-label', item.from === item.to ? `${item.from} 頁` : `${item.from}〜${item.to} 頁`),
        el(document, 'span', 'hint', 'ありません')
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
  const card = el(document, 'li', `bm-page${level ? ` ${level}` : ''}`);
  card.dataset.pageKey = entry.pageKey;

  const thumb = el(document, 'button', 'bm-thumb');
  thumb.type = 'button';
  thumb.title = '拡大して見る';
  const image = el(document, 'img');
  image.src = page.thumbUrl;
  image.alt = `${displayLabel(entry)}（${file.name} の ${entry.pageIndex + 1} 頁目）`;
  image.loading = 'lazy';
  thumb.append(image);
  thumb.addEventListener('click', () => openPreview(entry.pageKey));
  card.append(thumb);

  const label = el(document, 'div', 'bm-page-label');
  label.append(el(document, 'strong', null, displayLabel(entry)));
  const status = STATUS_LABEL[entry.status];
  if (status) label.append(el(document, 'span', `bm-status ${entry.status}`, status));
  card.append(label);
  card.append(el(document, 'div', 'bm-page-source', `${file.name}・${entry.pageIndex + 1}/${file.pages.length}`));

  if (issues.length) {
    const list = el(document, 'ul', 'bm-page-issues');
    for (const issue of issues) list.append(el(document, 'li', issue.level, issue.message));
    card.append(list);
  }

  if (entry.role === 'body') {
    const input = el(document, 'input', 'bm-page-number');
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
  // 結合と検証の途中は、縮小画像だけを出す（いちばんメモリを使う間に、PDF を
  // 丸ごと開き直さない）。
  if (merging) return;
  // 拡大表示するファイルを開いておく（前に拡大表示していたファイルは、ほかで
  // 使っていなければ閉じる）。
  setPreviewFile(file);
  try {
    const url = await renderPreview(await pdfOf(file), entry.pageIndex);
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
  // 拡大表示のために開いた文書は、閉じたら手放す（結合の途中でも残さない）。
  setPreviewFile(null);
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
  // 結合と検証はメモリを多く使うので、拡大表示のために開いていたファイルは閉じる。
  setPreviewFile(null);
  const run = generation;
  const order = view.order;
  // 突き合わせに使う元の頁の情報は、始めるときに写しておく（結合の途中で
  // ファイルを外されても読めるように）。
  const originals = order.map((entry) => {
    const { size, signature } = pageOf(entry);
    return { size, signature };
  });
  // 結合の途中で並び・名前が変わったら、その結果は使わない（画面の並びと
  // 違う PDF を保存させないため）。
  const stale = () => run !== generation;
  const abandon = () => {
    log('結合している間に並びか名前が変わったので、結合した PDF を捨てました');
    showMessage('結合している間に並びか名前が変わりました。もう一度「結合して検証する」を押してください。', 'red');
  };
  merging = true;
  try {
    const fileName = outputName();
    const ranges = pageLabelRanges(order);
    const sources = new Map(readyFiles().map((file) => [file.key, { bytes: file.bytes, name: file.name }]));
    const infoFrom = order.find((entry) => entry.role === 'body')?.fileKey;
    // 結合と検証で、バーの前半と後半を受け持つ。
    mergeProgress.label = () => '結合しています';
    mergeProgress.stage(0, 0.5);
    mergeProgress.show('結合しています…', 0);
    const started = performance.now();
    // 結合の道具（pdf-lib）は、結合するときになってから読み込む。
    const { mergePdf, pageDigests } = await import('./merge.js');
    const { bytes, digests } = await mergePdf({
      sources,
      order,
      title: fileName.replace(/\.pdf$/i, ''),
      labels: ranges,
      infoFrom,
      onProgress: (done, total) => mergeProgress.show(`結合しています（${done} / ${total} 頁）`, done / total),
    });

    // 結合した PDF を読み直し、元の頁と突き合わせる（頁を描き直さないので軽い）。
    log(`結合しました（${order.length} 頁、${megabytes(bytes.length)}、${seconds(started)}）`);
    if (stale()) {
      abandon();
      return;
    }
    mergeProgress.label = () => '検証しています';
    mergeProgress.stage(0.5, 1);
    mergeProgress.show('結合した PDF を検証しています…', null);
    const mergedDigests = await pageDigests(bytes);
    const doc = await openPdf(bytes);
    const actual = [];
    let labels;
    let info;
    try {
      for (let index = 0; index < doc.numPages; index++) {
        if (stale()) break;
        mergeProgress.show(`結合した PDF を検証しています（${index + 1} / ${doc.numPages} 頁）`, index / doc.numPages);
        const page = await withContext(`結合した PDF の ${index + 1} 頁目を検証できませんでした`, () =>
          readPageText(doc, index)
        );
        actual.push({ size: page.size, signature: page.signature, digest: mergedDigests[index] });
        if (index % 16 === 0) await breathe();
      }
      if (!stale()) {
        labels = await doc.getPageLabels();
        ({ info } = await doc.getMetadata());
      }
    } finally {
      // 失敗しても閉じる（結合した PDF 全体を worker に残さない）。
      await closePdf(doc);
    }
    if (stale()) {
      abandon();
      return;
    }

    const expected = order.map((entry, i) => ({
      pageKey: entry.pageKey,
      label: displayLabel(entry),
      ...originals[i],
      digest: digests[i],
    }));
    const result = compareOutput(expected, actual);
    const wantLabels = pageLabelTexts(ranges, order.length);
    const labelsOk = Array.isArray(labels) && labels.every((label, i) => label === wantLabels[i]);
    merged = { bytes, fileName, result, labelsOk, title: info?.Title || '' };
    log(
      result.ok && labelsOk
        ? `検証しました（${result.pageCount.actual} 頁すべて一致）`
        : `検証で食い違いが見つかりました（${result.mismatches.length} 頁${labelsOk ? '' : '、頁ラベルが違う'}）`
    );
    renderVerify();
    $('downloadBtn').disabled = false;
  } catch (error) {
    showMessage(error.message || String(error), 'red');
  } finally {
    merging = false;
    mergeProgress.show('');
    button.disabled = false;
    // 結合の途中に開いた拡大表示は縮小画像だけなので、大きく描き直す。
    if (previewKey) openPreview(previewKey);
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
  box.replaceChildren(...lines.map((line) => el(document, 'p', null, line)));
  if (result.mismatches.length) {
    const list = el(document, 'ul', 'bm-mismatches');
    for (const mismatch of result.mismatches.slice(0, 50)) {
      const item = el(document, 'li', null, `${mismatch.index + 1} 枚目（${mismatch.label}）: ${mismatch.reasons.join('・')}`);
      list.append(item);
    }
    if (result.mismatches.length > 50) list.append(el(document, 'li', null, `ほか ${result.mismatches.length - 50} 頁`));
    box.append(list);
  }
  box.hidden = false;
}

async function download() {
  if (!merged) return;
  // 共有シートを開いている間に、名前を変えるなどして結合した PDF が捨てられる
  // ことがあるので、渡すものは先に取っておく。
  const { bytes, fileName } = merged;
  const how = await savePdf(bytes, fileName);
  if (how === 'shared') log(`「${fileName}」を共有シートに渡しました`);
  else if (how === 'downloaded') log(`「${fileName}」をダウンロードしました`);
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
        load: (onProgress, onWait) => downloadDriveFile(file, { onProgress, onWait }),
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

/**
 * 見出しの「?」。押すと説明を開き（もう一度押すか、外を押すか、Esc で閉じる）、
 * マウスでは載せている間だけ開く。どちらも同じ open の切り替えで表すので、
 * 見た目と aria-expanded が食い違わない。開くのはいつも 1 つだけ。
 */
function wireHelp() {
  const helps = [...document.querySelectorAll('.bm-help')];
  const setOpen = (help, open) => {
    help.classList.toggle('open', open);
    help.querySelector('.bm-help-btn').setAttribute('aria-expanded', String(open));
  };
  const openOnly = (help) => helps.forEach((other) => setOpen(other, other === help));
  for (const help of helps) {
    // マウスを載せている間（説明の文へ動かす途中の隙間は少し待つ）。タッチの
    // pointerenter は押したのと同じなので、ここでは扱わない。
    let hovering = false;
    let leaving = 0;
    help.addEventListener('pointerenter', (event) => {
      if (event.pointerType !== 'mouse') return;
      clearTimeout(leaving);
      hovering = true;
      openOnly(help);
    });
    help.addEventListener('pointerleave', (event) => {
      if (event.pointerType !== 'mouse') return;
      hovering = false;
      leaving = setTimeout(() => setOpen(help, false), HELP_LEAVE_MS);
    });
    help.querySelector('.bm-help-btn').addEventListener('click', () => {
      // 載せて開いているときに押しても閉じない（押した途端に消えて見えるので）。
      if (hovering || !help.classList.contains('open')) openOnly(help);
      else setOpen(help, false);
    });
    // 見出しの中にあるので、説明の文を押しても節を畳まない（文を選んで読めるように）。
    help.querySelector('.bm-help-body').addEventListener('click', (event) => event.stopPropagation());
  }
  document.addEventListener('click', (event) => {
    for (const help of helps) if (!help.contains(event.target)) setOpen(help, false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') helps.forEach((help) => setOpen(help, false));
  });
}

function wireUp() {
  if (!pdfLibViews) {
    // ファイルを読む前に知らせる（読み込んだ時点で、写しはもう作られる）。
    log('pdf-lib にバイト列を写させない設定が効いていません。大きな本ではメモリが足りなくなることがあります');
  }
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

  wireHelp();

  document.querySelectorAll('input[name="pageFilter"]').forEach((radio) =>
    radio.addEventListener('change', () => {
      filter = radio.value;
      renderGrid();
    })
  );
  $('outputName').addEventListener('input', () => {
    $('outputName').dataset.suggested = 'false';
    discardMerged();
    // 入力した名前を覚えておく（このあと裏の処理で並べ直しても、捨て直さない）。
    orderKey = mergeKey();
  });
  $('mergeBtn').addEventListener('click', mergeAndVerify);
  $('downloadBtn').addEventListener('click', download);
  $('logCopyBtn').addEventListener('click', copyLog);
  $('logBox').addEventListener('toggle', renderLog);

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
