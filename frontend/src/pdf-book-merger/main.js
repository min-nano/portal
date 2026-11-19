// PDF 結合ツール。
//
// 選んだ PDF を 1 つに結合する。ファイルの並びのままつなぐほか、裁断した本を
// 分けてスキャンした PDF を、頁番号で 1 冊の順に並べて結合できる。
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
//   6. 分ける位置を決める 大きすぎるときは、章の区切りで分ける位置を提案し、
//                       手で足したり外したりできる（split.js）
//   7. 結合して検証     pdf-lib で頁をそのまま写し（merge.js）、読み直して
//                       元の頁と突き合わせる（verify.js）。分けたファイルごと
//   8. 保存             ダウンロード（この端末へ。Drive へは端末のアプリで）。
//                       分けたときは 1 つずつか、ZIP にまとめて（zip.js）
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
import { createDownloadPool } from './download-pool.js';
import { compareScans } from './image-checks.js';
import { isMobile, saveMethod, savePdf } from './save-file.js';
import { measure } from './measure-client.js';
import { boxesReadSoFar, prepareOcr, readStrip, releaseOcr } from './ocr.js';
import { blobStash, openStash } from './stash.js';
import { CRASH_LOG_LINES, createCrashLog } from './crash-log.js';
import {
  arrangeBook,
  checkSequence,
  guessRole,
  isCoverName,
  nameRank,
  numberFiles,
  pageLabelRanges,
  pageLabelTexts,
  ROLE_NAMES,
  ROLES,
} from './ordering.js';
import {
  groupLines,
  mergeCandidates,
  normalizeDigits,
  numberingSequence,
  pageNumberCandidates,
  pageNumberText,
  parsePageNumber,
  readMargin,
  sideOf,
  unsettledPages,
} from './page-numbers.js';
import { findScanImages } from './scan-images.js';
import { pdfLibViews } from './pdf-lib-views.js';
import {
  closePdf,
  fontReleases,
  keepFewFonts,
  manySoftMasks,
  openPdf,
  readOutline,
  readPageText,
  redrawnSafely,
  releaseCanvas,
  releasePdfWorker,
  renderMargins,
  renderPageImage,
  renderPreview,
} from './pdf-source.js';
import {
  displayLabel,
  gridItems,
  issueGroups,
  mergeIssues,
  missingLabel,
  pageIssues,
  STATUS_LABEL,
  suggestBookName,
  textCoverage,
  textIssues,
  worstLevel,
} from './review.js';
import { compareOutput } from './verify.js';
import {
  breakReason,
  breakCandidates,
  chapterHeading,
  runningHead,
  headingRank,
  tocEntries,
  tocPage,
  DEFAULT_LIMITS,
  MEGABYTE,
  overLimit,
  partFileName,
  partLabels,
  breakRanks,
  RANKS,
  seamCandidates,
  sliceLabelRanges,
  splitByRank,
  splitRanges,
  middleCut,
} from './split.js';
import { crc32, zipBlob } from './zip.js';
import { textQuality } from './text-quality.js';
import { createDuplicateFinder, duplicateIssues, textPrint } from './duplicates.js';

const PDF_MIME = 'application/pdf';
const ZIP_MIME = 'application/zip';
const DEFAULT_NAME = '結合.pdf';
/**
 * 分ける上限を覚えておく名前（localStorage。次に開いたときも同じ上限にする）。
 * 既定を 100 MB から 40 MB に下げたときに名前を変え、前の既定のまま覚えた値は読まない。
 */
const LIMITS_KEY = 'pdf-book-merger:split-limits-2';

/** 見出しの「?」からマウスを外して、説明を閉じるまでの猶予（説明の文へ動かす間）。 */
const HELP_LEAVE_MS = 300;

/** 同時に読み取る頁の数（OCR の worker の数より少し多くして、待ちを埋める）。 */
const OCR_IN_FLIGHT = 3;
/**
 * 同時に描く頁の数。600dpi のスキャンは頁ごとの JPEG の展開が重い（1 頁で
 * 0.2 秒ほど）が、展開は画面とは別のところで進むので、端末の芯を並べて使う。
 */
const PAGES_IN_FLIGHT = 3;
/**
 * 分けたファイルを同時に書き出す数。元のファイルを読み直す回数は減るが、書き口と
 * 組み立て中の PDF を同時にこの数だけ持つ（上限を 1 頁などにしても、何百も開かない）。
 */
const PARTS_AT_ONCE = 8;
/** CRC-32 を一息に求める大きさ（バイト）。これごとに画面へ一息つかせる。 */
const CRC_CHUNK = 8 * 1024 * 1024;
/** 同時に読み込むファイルの数と、その中身の大きさの合計の上限（バイト）。 */
const DOWNLOADS_IN_FLIGHT = 4;
const DOWNLOAD_BUDGET = 64 * 1024 * 1024;

let nextKey = 1;
/** 選んだファイル（画面の並び順）。中身は addFiles() を参照。 */
const files = [];
/** 頁ごとに手で直した番号（頁の key → 番号）。 */
const overrides = new Map();
/** 同じ頁らしい組を探す（前に見比べた頁どうしは見比べ直さない）。 */
const findDuplicates = createDuplicateFinder();
/** 最後に組み立てた並びと指摘、分ける位置（新しいファイルを始める頁の位置）と、その候補。 */
let view = {
  order: [],
  problems: [],
  issues: new Map(),
  numberings: new Map(),
  starts: [],
  breaks: [],
  labels: [],
  items: [],
  shown: [],
  ranks: [],
  places: new Map(),
  anyNumbered: false,
};
/** 分ける上限（MB・頁。null は上限なし）。 */
let splitLimits = { ...DEFAULT_LIMITS };
/** 手で決めた分ける位置（新しいファイルを始める頁の key）。null なら自動の提案に従う。 */
let manualSplits = null;
/** 手で決める前に、上限に収まるように選んでいた位置（手で決めたあとも、そう訳を出す）。 */
let limitCuts = new Set();
/**
 * 一覧で選んだファイル（その中の頁の key。'' なら選んでいない）。そのファイルの下に、
 * 始まりと終わりを動かす欄を出す。何番目かで覚えると、ほかで分ける位置を変えたときに
 * 別のファイルを指してしまうので、頁で覚える。
 */
let selectedKey = '';
/** 描き直したあとに、キーボードの位置を戻すボタン（一覧の中の CSS セレクタ）。 */
let refocus = '';
/**
 * 境目を動かした帯（始まり・終わり）と、動かした先（並びの位置）。次に描き直すとき、
 * その帯の中のその間を、動かす前と同じ見た目の位置に置く（帯を送り直さない）。null
 * なら、今の境目を真ん中に置く。
 */
let keepAt = null;
/** 境目をドラッグしている間は、一覧を描き直さない（掴んでいるボタンが無くならないように）。 */
let dragging = false;
/** 結合した PDF（分けたときは、分けたファイルごと）と検証の結果。並びが変わったら捨てる。 */
let merged = null;
/** 結合と検証の途中か（その間は、拡大表示のために PDF を開かない）。 */
let merging = false;
/** 保存（ダウンロード・共有）している間か。 */
let saving = false;
/** 結合する中身（並び・名前）が変わるたびに進める番号（結合の途中で変わったら、その結合は捨てる）。 */
let generation = 0;
/** いまの並びのうち、結合する PDF を決める部分（頁・配置・頁番号）。変わったときだけ結合した PDF を捨てる。 */
let orderKey = '';
/** 最後に記録に出した、分ける位置の提案（変わったときだけ出す）。 */
let suggestionNote = '';
/** 指摘の項目のうち、開いているものと、そこに並べる頁の数（描き直しても開いたままにする）。 */
const openGroups = new Map();
/**
 * ファイルの一覧の並び順（added: 追加した順 / name: 名前の順 / time: 更新日時の古い順。-desc を付けると
 * 降順（新しい順）。manual: 手で並べ替えた順。足したファイルの入る場所は sortFiles）。
 */
let fileSort = 'added';
// ファイルは 1 つずつ調べる（pdf.js も OCR も、同時に動かすと遅くなるだけなので）。
let queue = Promise.resolve();
/** 順番を待っている仕事（足した順）。file はファイルを調べる仕事のファイル（あとからの OCR は null）。 */
const waitingJobs = [];
// Drive からの読み込みは、調べるのを待たずに先へ進める（調べている間に、次の
// ファイルを読んでおく）。小さなファイルは何個かを並べて読む（1 つずつだと、
// ファイルごとの問い合わせの待ちが積み重なり、調べ終えるたびに次の読み込みを
// 待って止まる）。並べるのは、合わせた大きさが DOWNLOAD_BUDGET に収まる間だけ
// （読んでいる間は中身をまるごとメモリに持つので、大きな本は 1 つずつ）。
const downloads = createDownloadPool({ limit: DOWNLOADS_IN_FLIGHT, budget: DOWNLOAD_BUDGET });
/**
 * 読み込んだ PDF と結合した PDF を置く保存領域（stash.js）。使えなければ null
 * （メモリに持つ）。ツールを開いたときに用意する。
 */
let stash = null;
let stashReady = Promise.resolve(null);
/** 結合した回数（保存領域での名前に使う）と、保存領域に置いている結合した PDF の名前（分けたときは、分けたファイルごと）。 */
let mergeCount = 0;
let mergedNames = [];
/** 保存領域を使えない理由（処理の記録に出す）。 */
let stashProblem = '';
/** 保存領域を使うかどうかを、記録に出したか。 */
let stashNoted = false;
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
// 間は結合を出し、済んだら調べる流れに戻す。バーは待っている仕事が無くなった
// ときにだけ隠す（仕事の替わり目で隠すと、行が消えて画面がちらつく）。
//
// バーは、調べ終えたところ（頁の数で数える）をベタ塗りにし、中身が手元に届いた
// ところ（Drive から読み込んだバイトの数で数える）を動くストライプで重ねる。調べる
// のは届いてからなので、ベタ塗りがストライプを追い越すことはない。読み込みと調べる
// のにかかる時間の割合はファイルによって何倍も違う（スキャンは大きさに、InDesign の
// PDF は頁の数に比例する）ので、1 本の進み具合にまとめて見積もらず、それぞれの数え方
// のまま 2 つ重ねて出す。この端末のファイルは、はじめから届いているものとする。
// 段の中の割合が分からないとき（大きさの分からない読み込みなど）も、ブラウザの
// 「分からない表示」（バー全体を往復する帯）にはしない。それだと、どこまで済んだかが
// 読めなくなるため。

const logLines = [];
const LOG_LIMIT = 2000;
/** ページが落ちても、次に開いたときに記録を見られるようにする（crash-log.js）。 */
const crashLog = createCrashLog();

/**
 * 仕事の流れ 1 つの進み具合を作る。
 *
 * label は見出しを返す関数（バーの横に出す。出すたびに呼ぶ）。stage(from, to)
 * でいまの段の区間を決め、show(text, fraction, heading) で経過を出す。text は
 * 細かい経過（記録に出す）で、空なら済んだとして隠す。fraction は段の中の割合
 * （分からなければ null。ベタ塗りは段の始まりで止める）。heading を
 * 渡すと、見出しの代わりにそれを出す（Drive を待っているときなど、見出しより
 * 先に知らせたいこと）。
 *
 * jobs を持つ流れでは、仕事を足しても（addJob）バーが戻らないように、足した
 * ときの位置から残りを数え直す。
 *
 * loaded は、いまの仕事で中身が届いた割合（0〜1。ストライプに描く）。たいていの
 * 仕事は中身が手元にあるので 1 とし、Drive から読み込む間だけ下げる（showLoading）。
 * ahead は、順番を待っている仕事の中身が届いた分（仕事の数で数える）を返す。
 * 読み込みは調べるのを待たずに先へ進むので、ストライプはその分も先へ伸ばす。
 */
function createProgress({ jobs = false, ahead = () => 0 } = {}) {
  const progress = {
    label: () => '',
    from: 0,
    to: 1,
    text: '',
    fraction: null,
    heading: '',
    // 仕事の数・済んだ数と、数え直したときのバーの位置（base）と仕事の位置（start）。
    jobs: jobs ? { total: 0, done: 0, base: 0, start: 0 } : null,
    loaded: 1,
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
        progress.loaded = 1;
      }
      renderProgress();
    },
    /** いまの仕事の中の位置（0〜1）。 */
    inJob() {
      const fraction = Math.max(0, Math.min(1, progress.fraction ?? 0));
      return progress.from + (progress.to - progress.from) * fraction;
    },
    /** 仕事を単位にした位置（済んだ仕事の数＋仕事の中の位置）を、流れ全体の位置（0〜1）に写す。 */
    place(at) {
      const { jobs } = progress;
      if (!jobs?.total) return at;
      return Math.min(1, jobs.base + ((1 - jobs.base) * (at - jobs.start)) / (jobs.total - jobs.start));
    },
    /** 流れ全体の位置（0〜1）。 */
    overall() {
      return progress.place((progress.jobs?.done ?? 0) + progress.inJob());
    },
    /**
     * いまの仕事の始まり（流れ全体の位置）。途中で仕事を足して数え直したときは、
     * 数え直した位置から。
     */
    jobStart() {
      const { jobs } = progress;
      return progress.place(Math.max(jobs?.done ?? 0, jobs?.start ?? 0));
    },
    /** 中身が届いたところ（流れ全体の位置）。 */
    loadedEnd() {
      return progress.place((progress.jobs?.done ?? 0) + progress.loaded + ahead());
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
    /**
     * 仕事を 1 つ済ませる。待っている仕事が残っていれば、バーは隠さずに済んだ
     * 位置で止めておく（次の仕事が経過を出すまでの間に隠すと、仕事が替わる
     * たびに行が消えて下が詰まり、画面がちらつく）。残っていなければ隠す。
     */
    finishJob() {
      const { jobs } = progress;
      jobs.done++;
      if (jobs.done >= jobs.total) {
        Object.assign(jobs, { total: 0, done: 0, base: 0, start: 0 });
        progress.show('');
        return;
      }
      progress.stage(0, 0);
      // 次の仕事はまだ順番待ちに数えている（ahead）ので、ここでは数えない。
      Object.assign(progress, { fraction: 0, heading: '', loaded: 0 });
      renderProgress();
    },
  };
  return progress;
}

/** ファイルを調べる流れ（あとからの OCR も）。 */
const readProgress = createProgress({ jobs: true, ahead: () => waitingJobs.reduce((sum, job) => sum + loadedPart(job.file), 0) });
/** 結合と検証。 */
const mergeProgress = createProgress();

/** 進み具合を描く。結合している間は結合を、そうでなければ調べる流れを出す。 */
function renderProgress() {
  const progress = mergeProgress.text ? mergeProgress : readProgress;
  $('progress').hidden = !progress.text;
  $('progressText').textContent = progress.text ? progress.heading || progress.label() || progress.text : '';
  if (progress.text) {
    // 調べ終えたところはベタ塗り、その先の中身が届いたところはストライプで描く。
    const done = progress.overall();
    const loaded = Math.max(done, progress.loadedEnd());
    const bar = $('progressBar');
    bar.dataset.loaded = String(loaded);
    $('progressDone').style.width = `${done * 100}%`;
    $('progressLoaded').hidden = loaded <= done;
    $('progressLoaded').style.left = `${done * 100}%`;
    $('progressLoaded').style.width = `${(loaded - done) * 100}%`;
    // 細くても動いているのが見える幅（tool.css の .bm-bar-loaded）は、いまの仕事の始まり
    // から測る。ベタ塗りの右端から測ると、ベタ塗りが仕事の終わりに近づいたときに
    // ストライプが次の仕事の区間まではみ出し、仕事を終えて消えるときに右端が戻って見える。
    $('progressLoaded').style.setProperty('--bm-bar-from', `${(progress.jobStart() - done) * 100}%`);
    // aria-valuenow は最後に書く（テストはこれを合図に、ほかの値を読む）。
    bar.setAttribute('aria-valuenow', String(done));
  }
  renderLog();
  // 進み具合は頁ごとに変わるので、残すのは間を空けて（localStorage への書き込みは
  // 画面を止める）。
  keepLog(false);
}

/** 調べる流れの進み具合を出す（ほとんどの経過はこちら）。 */
function showProgress(text, fraction, heading = '') {
  readProgress.show(text, fraction, heading);
}

/**
 * 仕事を順番待ちに足す（ファイルを調べる・あとからの OCR）。済んだら数える。
 * 順番待ちが空になったら、OCR を手放す（結合の前に、メモリを空けておく）。
 */
function enqueue(task, file = null) {
  readProgress.addJob();
  const job = { file };
  waitingJobs.push(job);
  queue = queue
    .then(() => {
      waitingJobs.splice(waitingJobs.indexOf(job), 1);
      readProgress.loaded = 1; // 中身が届いていなければ、readFile が下げる
      return task();
    })
    .catch(() => {})
    .then(() => {
      readProgress.finishJob();
      if (readProgress.jobs.total === 0) {
        stopOcr();
        keepLog(); // 処理を終えたので、残した記録を消す
      }
    });
}

/** ログに 1 行足す（時刻付き）。 */
function log(text) {
  logLine(text);
  renderLog();
  keepLog();
}

/**
 * ログに 1 行足すだけで、描き直しも残しもしない（何百ファイルを一度に足すとき
 * など、続けて何行も足すときに。足し終えたら renderLog と keepLog を呼ぶ）。
 */
function logLine(text) {
  const time = new Date().toLocaleTimeString('ja-JP', { hour12: false });
  logLines.push(`${time} ${text}`);
  if (logLines.length > LOG_LIMIT) logLines.splice(0, logLines.length - LOG_LIMIT);
  $('logBox').hidden = false;
}

/** いま実行中のこと（記録の終わりに添える）。 */
function runningLines() {
  return [mergeProgress.text, readProgress.text].filter(Boolean).map((text) => `（実行中）${text}`);
}

/** 処理しているか（調べる・あとからの OCR・結合と検証・保存）。 */
function busy() {
  return merging || saving || readProgress.jobs.total > 0;
}

/** 進み具合だけが変わったときに残す間隔（ミリ秒）。 */
const KEEP_EVERY_MS = 500;
let keptAt = 0;

/**
 * 記録の終わりのほうと、いま実行中のことを残す（ページが落ちたときのため）。
 * always でなければ、前に残してから KEEP_EVERY_MS 経つまでは残さない。
 */
function keepLog(always = true) {
  // 処理していないときは残さない（裏に回したタブを iPhone が片付けたときに、
  // 「途中で終わった」と出さないように）。
  if (!busy()) {
    crashLog.clear();
    return;
  }
  const now = Date.now();
  if (!always && now - keptAt < KEEP_EVERY_MS) return;
  keptAt = now;
  crashLog.record([...logLines.slice(-CRASH_LOG_LINES), ...runningLines()]);
}

function logText() {
  return [...logLines, ...runningLines()].join('\n');
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

function seconds(since, until = performance.now()) {
  return `${((until - since) / 1000).toFixed(1)} 秒`;
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
 * 一度に選んだファイルは、まとめて足してから一覧を 1 度だけ並べて描く。1 つ
 * 足すたびに一覧をまるごと描き直すと、手間もメモリもファイルの数の 2 乗に
 * なり（400 ファイルで、折り畳みの節を 8 万個作っては捨てる）、iPhone では
 * 足している途中でページごと落ちた。処理の記録を残すのも、足し終えてから 1 度。
 *
 * @param {Array<{name:string, size?:number, driveId?:string, modified?:number|null,
 *          load:(onProgress:Function, onWait:Function, reserve:Function) => Promise<Uint8Array>}>} sources
 *   load は、中身の大きさが分かったら、読み始める前に reserve(size) を待つ（download-pool.js）
 */
function addFiles(sources) {
  const added = [];
  for (const source of sources) {
    if (source.driveId && files.some((file) => file.driveId === source.driveId)) {
      showMessage(`「${source.name}」はすでに追加してあります。`, 'red');
      continue;
    }
    const file = {
      key: `f${nextKey}`,
      added: nextKey++, // 追加した順（「追加順」に戻すときに使う）
      name: source.name,
      modified: Number.isFinite(source.modified) ? source.modified : null, // 更新日時（ミリ秒）
      driveId: source.driveId || '',
      status: 'waiting', // waiting → loading → loaded → reading → ocr → ready / error
      error: '',
      role: 'body',
      manual: null,
      coverStep: 1, // 番号の無いファイル・表紙と裏表紙の進み方（-1 なら最後の頁から）
      // 名前で表紙・裏表紙と分かるか（番号を手で入れるか、本文を選び直すまで、番号で並べない）。
      coverByName: isCoverName(source.name),
      open: false, // 一覧で設定の欄を開いているか（描き直しても保つ）
      bytes: null,
      doc: null,
      pages: [],
    };
    files.push(file);
    added.push({ file, source });
    resetSplits();
    logLine(`「${file.name}」を追加しました（${source.driveId ? 'Drive' : 'この端末'}）`);
  }
  sortFiles();
  renderFiles();
  for (const { file, source } of added) {
    file.loaded = downloads.run((reserve) => loadBytes(file, source, reserve));
    file.loaded.catch(() => {}); // 失敗は調べるときに知らせる（readFile）
    file.pending = true; // 調べ終えるまで（見出しの「n / m」に使う）
    enqueue(async () => {
      try {
        await readFile(file);
      } finally {
        file.pending = false;
      }
    }, file);
  }
  renderLog();
  keepLog();
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
 * ファイルや外したファイルは、file.bytes を捨てればメモリが空く。保存領域を
 * 使えるときは、そこへ写してメモリからは手放す（調べる・結合するときに、そこから
 * 読む）。元のファイルを読み直さないのは、端末のファイルでも実体がクラウドに
 * あって、取り直しになることがあるため。
 */
async function loadBytes(file, source, reserve) {
  if (!files.includes(file)) return;
  file.status = 'loading';
  renderFile(file);
  const started = performance.now();
  let bytes;
  try {
    bytes = await source.load(
      (received, total) => {
        file.waitUntil = 0; // 届き始めた（待ち終えた）
        clearTimeout(file.waitTimer);
        file.transfer = { received, total };
        // はじめから読み直したとき（続きから読めなかった）も、ストライプは戻さない。
        file.loadedShown = Math.max(file.loadedShown ?? 0, total ? received / total : 0);
        // 外したファイルの読み込みは止まらないので、出さない。
        if (!files.includes(file)) return;
        // 調べる順番が来て読み込みを待っているときは見出しにも出し、順番を待って
        // いるときはストライプだけを伸ばす（調べるのを待たずに）。
        if (file.waiting) showLoading(file);
        else renderSoon();
      },
      // 読み直す前に待つときは、記録に残し、待っていることを画面に出す（先読みの
      // 途中なら、調べる順番が来たときに出す。readFile）。
      (ms, reason) => {
        log(`「${file.name}」の読み込みを ${Math.round(ms / 1000)} 秒待ってから読み直します（${reason}）`);
        file.waitUntil = Date.now() + ms;
        file.waitReason = reason;
        if (file.waiting) showWaiting(file);
      },
      // 大きさの枠を待つ間に外されたら、読まずにやめる（ほかのファイルの枠を使わない）。
      async (size) => {
        await reserve(size);
        if (!files.includes(file)) throw new Error('外されました。');
      }
    );
  } catch (error) {
    file.loadedShown = 1; // もう読まない（ストライプを止めたままにしない）
    if (!files.includes(file)) return; // 外したファイルは、読めなくても知らせない
    log(`「${file.name}」を読み込めませんでした（${error?.message || error}）`);
    throw error;
  }
  file.loadedShown = 1;
  log(`「${file.name}」を読み込みました（${megabytes(bytes.length)}、${seconds(started)}）`);
  if (!files.includes(file)) return; // 読んでいる間に外された。
  file.bytes = bytes;
  await stashBytes(file);
  if (file.status === 'loading') {
    file.status = 'loaded';
    renderFile(file);
  }
}

/** 保存領域での、ファイルの名前。 */
function stashName(file) {
  return `${file.key}.pdf`;
}

/** 読み込んだ中身を保存領域へ写し、メモリからは手放す。写せなければメモリに持つ。 */
async function stashBytes(file) {
  const target = await stashReady;
  if (!stashNoted) {
    stashNoted = true;
    log(stashDescription(target, '読み込んだ PDF は'));
  }
  if (!target) return;
  try {
    await target.put(stashName(file), file.bytes);
  } catch (error) {
    log(`「${file.name}」を保存領域に置けなかったので、メモリに持ちます（${error.message}）`);
    target.remove(stashName(file)); // 書きかけを残さない
    return;
  }
  if (!files.includes(file)) {
    target.remove(stashName(file));
    return;
  }
  file.stashed = true;
  // 調べるときは、そこから読み直す（読み込みは調べるより先に進むので、先に
  // 読んだファイルの中身をメモリに溜めない）。
  file.bytes = null;
}

/** どこに置くかを、記録に出す言葉にする。 */
function stashDescription(target, subject) {
  if (target?.kind === 'opfs') return `${subject}保存領域に置きます`;
  const why = `保存領域を使えない: ${stashProblem}`;
  return target ? `${subject} Blob にしてページの外に置きます（${why}）` : `${subject}メモリに持ちます（${why}）`;
}

/** ファイルの中身。保存領域に置いたものは、そこから読む。 */
async function bytesOf(file) {
  if (file.bytes) return file.bytes;
  return file.stashed ? stash.read(stashName(file)) : null;
}

/** 区切りの候補の裏付けの手掛かりの名前（記録に出す）。 */
const RUNNING_CLUES = { chapter: '柱の章', section: '柱の節', text: '柱' };

/** 分ける位置の提案を、記録に出す言葉にする（位置ごとに、候補の訳・手掛かり・順位）。 */
function suggestionText(order, starts, breaks, ranks) {
  const cuts = starts.map((index) => {
    const candidate = breaks[index];
    if (!candidate) return `${displayLabel(order[index])}（大きさで）`;
    const clues = [
      candidate.toc && '目次',
      candidate.running && RUNNING_CLUES[candidate.running],
      candidate.restart && '頁番号の戻り',
    ].filter(Boolean);
    const rank = ranks[index] === null ? '' : `・順位 ${ranks[index]}`;
    return `${displayLabel(order[index])}（${breakReason(candidate)}${clues.length ? `・${clues.join('・')}` : ''}${rank}）`;
  });
  return `分ける位置の提案 ${starts.length}（${cuts.join('、')}）`;
}

/** 見出しと読んだ頁・目次とみなした頁を、記録に出す言葉にする（多ければ頭の方だけ）。 */
function pageNotes(headings, tocs, entries, runs = []) {
  const list = (pages, text, most = 12, unit = '頁') => {
    const shown = pages.slice(0, most).map(text).join('、');
    return pages.length > most ? `${shown} ほか ${pages.length - most} ${unit}` : shown;
  };
  const notes = [];
  if (headings.length) notes.push(`見出しと読んだ頁 ${headings.length}（${list(headings, (page) => `${page.index + 1} 頁目「${page.heading}」`)}）`);
  if (tocs.length) notes.push(`目次とみなした頁 ${tocs.length}（${list(tocs, (page) => `${page.index + 1} 頁目`)}）`);
  // 目次の項目（章の始まりは、この頁番号の頁にする）。
  if (entries.length) notes.push(`目次の項目 ${entries.length}（${list(entries, (entry) => `「${entry.title}」${entry.page} 頁`)}）`);
  // 柱（上の余白の文字）は、続けて同じものをまとめ、変わったところだけを出す。
  const changes = runs.filter((page, k) => k === 0 || page.running !== runs[k - 1].running);
  if (runs.length) {
    const shown = list(changes, (page) => `${page.index + 1} 頁目〜「${page.running}」`, 40, '件');
    notes.push(`柱を読んだ頁 ${runs.length}（変わったところ ${changes.length}: ${shown}）`);
  }
  return notes.join('、');
}

/**
 * ファイルの中身が届いた割合（0〜1）。この端末のファイルは、はじめから届いている
 * ものとする。外したファイルは、もう待たないので 1。
 */
function loadedPart(file) {
  if (!file || !file.driveId || !files.includes(file)) return 1;
  return file.loadedShown ?? 0;
}

/** 進み具合を少し後に描き直す（何個かを並べて読む間、届くたびに描き直さないように）。 */
const RENDER_EVERY_MS = 100;
let renderTimer = 0;
function renderSoon() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = 0;
    // 調べる流れを出している間だけ（隠したバーや、結合の進み具合を描き直さない）。
    if (readProgress.text && !mergeProgress.text) renderProgress();
  }, RENDER_EVERY_MS);
}

/**
 * 読み込みを待っている間の進み具合を出す。Drive のファイルは、届いた割合を
 * ストライプに描く（大きさが分からなければ描かない）。この端末のファイルは、
 * はじめから届いているものとする。
 */
function showLoading(file) {
  const { received = 0, total = 0 } = file.transfer ?? {};
  const amount = total ? `${megabytes(received)} / ${megabytes(total)}` : megabytes(received);
  readProgress.loaded = loadedPart(file);
  showProgress(`「${file.name}」を読み込んでいます${file.transfer ? `（${amount}）` : ''}`, null);
}

async function readFile(file) {
  if (!files.includes(file)) return; // 読む前に外された。
  const started = performance.now();
  let held = false; // pdf.js で開いて使っているか（終えたら手放す）
  try {
    // 何番目かは、調べ終えたファイルの数から数える（あとからの OCR は数えない）。
    readProgress.label = () =>
      `ファイルを調べています（${files.filter((f) => !f.pending).length + 1} / ${files.length}）`;
    // 段ごとの区間（調べる手間の割合。ベタ塗りに描く）。読み込みは段に数えず、
    // 届いた割合をストライプに描く（この端末のファイルは、はじめから届いている）。
    const textEnd = 0.1;
    readProgress.stage(0, textEnd);
    file.waiting = true;
    if (file.status !== 'loaded') showLoading(file);
    if (file.waitUntil > Date.now()) showWaiting(file);
    await file.loaded;
    file.waiting = false;
    readProgress.loaded = 1;
    renderProgress(); // 保存領域から読み直して開く間も、届いたことを出しておく
    clearTimeout(file.waitTimer);
    if (!files.includes(file)) return;
    // 調べている間は、中身をメモリに持つ（調べ終えたら、保存領域に置いたものは手放す）。
    const bytes = await bytesOf(file);
    if (!files.includes(file)) return; // 読んでいる間に外された（中身は持たない）。
    file.bytes = bytes;
    if (!isPdf(file.bytes)) throw new Error('PDF ファイルではありません。');

    file.status = 'reading';
    holdDoc(file);
    held = true;
    await withContext('PDF として開けませんでした', () => pdfOf(file));
    const count = file.doc.numPages;
    // しおり（目次）は、分ける位置の候補にする（split.js）。
    const outline = await readOutline(file.doc);
    const releasesBefore = await fontReleases(file.doc);

    // 文字情報（画像を展開しないので軽い）。
    for (let index = 0; index < count; index++) {
      if (!files.includes(file)) return;
      showProgress(`「${file.name}」の文字情報を読んでいます（${index + 1} / ${count}）`, index / count);
      const { items, text, ...rest } = await withContext(`${index + 1} 頁目を読めませんでした`, () =>
        readPageText(file.doc, index)
      );
      const lines = groupLines(items);
      // 文字情報そのものは持たない（数百頁ぶん抱えないように）。確かめた結果と、
      // 同じ頁を見比べるための指紋だけを残す。
      file.pages.push({
        key: `${file.key}:${index}`,
        index,
        ...rest,
        textCheck: textQuality(text),
        textPrint: textPrint(text),
        // 頁番号の候補と、柱の文字（部の振り直しで、どの束の続きかを見分ける）。
        ...readMargin(items, 'text', lines),
        // 分ける位置の候補（しおりの項目・章の見出し）と、頁の大きさの見積もり（バイト）。
        outline: outline.get(index) ?? null,
        heading: chapterHeading(lines),
        toc: tocPage(lines),
        // 目次の項目（章の名前と頁番号）と柱。区切りらしさの手掛かりにする。
        tocEntries: tocEntries(lines),
        running: runningHead(lines),
        bytes: 0,
        measure: null,
        thumbUrl: '',
        ocr: false,
        scan: null,
        softMasks: 0, // ソフトマスクの数（頁の画像を調べるときに数える。PDF を調べられなければ undefined）
      });
      if (index % 16 === 0) await breathe();
    }
    const textPages = file.pages.filter((page) => page.signature.length > 0).length;
    const textNumbers = file.pages.filter((page) => page.candidates.length > 0).length;
    // 頁ごとに別の書体を持つ PDF で、読んだ書体を手放した回数（pdf-source.js の noteFonts。
    // 拡大表示などで同じ文書を先に使っていれば、その分は除く）。
    const afterText = await fontReleases(file.doc);
    const textReleases = afterText - releasesBefore;
    log(
      `「${file.name}」の文字情報を読みました（${count} 頁、文字情報のある頁 ${textPages}、番号が見つかった頁 ${textNumbers}` +
        `${textReleases ? `、頁ごとに書体が違うので、読んだ書体を ${textReleases} 回手放しました` : ''}）`
    );
    // 分ける位置を選ぶ手掛かり（見出しと読んだ頁・目次とみなした頁）。分かれ方が思った
    // とおりでないときに、どの頁をどう読んだかを記録から追えるように。
    const headings = file.pages.filter((page) => page.heading);
    const tocs = file.pages.filter((page) => page.toc);
    const entries = file.pages.flatMap((page) => page.tocEntries);
    const runs = file.pages.filter((page) => page.running);
    if (headings.length || tocs.length || entries.length || runs.length) {
      log(`「${file.name}」の${pageNotes(headings, tocs, entries, runs)}`);
    }

    readProgress.stage(textEnd, 1);

    // 頁の画像を描いて測る（重いところ）。JPEG のまま描ける頁を先に調べておく。
    // 調べた JPEG は読み終えたら手放す（ファイルと同じだけの大きさがある）。
    showProgress(`「${file.name}」の頁の画像を調べています`, null);
    const imagesStarted = performance.now();
    const { scans, softMasks, reasons, example } = await findScanImages(file.bytes);
    // ソフトマスクの数は、pdf.js で描く頁の分だけ持つ（JPEG のまま描く頁は、
    // JPEG だけを描くのでソフトマスクの手間が掛からない）。調べられなかった
    // PDF（暗号化など）は数が無い（描くときは 0 として扱う）。
    for (const page of file.pages) page.softMasks = scans[page.index] ? 0 : softMasks[page.index];
    estimatePageBytes(file, scans);

    // 文字情報だけでは番号の決まらない頁（候補が無い・並びに合わない）は、
    // 画像の余白を OCR する（page-numbers.js の unsettledPages）。名前で表紙と分かる
    // もののほかは、配置を決める前に番号を読み切る（文字情報の無い束も、画像
    // から番号が読めれば本文と分かる）。OCR の準備は、画像を描く間に進める。
    // ソフトマスクの多い頁（InDesign の影・ぼかしのある表紙など）は粗く描き、
    // OCR しない（OCR に足りる細かさで描くと、1 頁で何十秒もかかる。
    // pdf-source.js の manySoftMasks）。番号は前後の頁から補う。
    const unnumbered = isCoverName(file.name) ? [] : unsettledOf(file);
    const ocrPages = new Set(unnumbered.filter((page) => !manySoftMasks(page.softMasks)).map((page) => page.index));
    if (ocrPages.size) startOcr();
    const coarse = file.pages.filter((page) => manySoftMasks(page.softMasks)).length;
    const skippedOcr = unnumbered.length - ocrPages.size;
    const jpegPages = scans.filter(Boolean).length;
    if (jpegPages < count) {
      const why = [...reasons].map(([reason, pages]) => `${reason} ${pages} 頁`).join('、');
      log(`「${file.name}」の ${count - jpegPages} 頁は pdf.js で描きます（${why || '理由不明'}）。${[example, await madeWith(file.doc)].filter(Boolean).join('。')}`);
    }
    const boxesBefore = boxesReadSoFar();
    const drawnAt = await analyzePages(file, scans, ocrPages);
    // あとから本文に変えたとき（名前で表紙と見て OCR しなかったファイル）の
    // ために、番号の決まっていない頁の JPEG を残す（PDF 全体を読み直さずに
    // 済む）。JPEG はファイルのバイト列の一部を指すだけなので（pdf-lib-views.js）、
    // 残してもメモリはほとんど使わない。その書き換えが効いていないと JPEG は
    // 写しなので、残さずに、あとで調べ直す。
    if (pdfLibViews && !file.stashed) {
      for (const page of unsettledOf(file)) {
        if (!page.ocr) page.scan = scans[page.index] ?? null;
      }
    }
    const byOcr = file.pages.filter((page) => page.ocr && page.candidates.some((c) => c.source === 'ocr')).length;
    const releases = (await fontReleases(file.doc)) - afterText;
    log(
      `「${file.name}」の頁の画像を調べました（JPEG のまま展開 ${jpegPages} / ${count} 頁、` +
        `余白を OCR ${ocrPages.size} 頁・うち番号が読めた頁 ${byOcr}、${seconds(imagesStarted)}。` +
        `うち頁を描き終えるまで ${seconds(imagesStarted, drawnAt)}、読んだ文字のかたまり ${boxesReadSoFar() - boxesBefore}）` +
        (coarse ? `。ソフトマスクの多い ${coarse} 頁は粗く描きました` : '') +
        (skippedOcr ? `（うち番号の決まらない ${skippedOcr} 頁は、余白を OCR しませんでした）` : '') +
        (redrawnSafely(file.doc) ? '。pdf.js で描けなかった頁があり、安全な設定で開き直して描き直しました' : '') +
        (releases ? `。頁ごとに書体が違うので、描いた頁の書体を ${releases} 回手放しました` : '')
    );

    file.role = guessRole(file.name, file.pages);
    file.status = 'ready';
    if (file.stashed) file.bytes = null;
    log(`「${file.name}」を調べ終えました（${ROLE_NAMES[file.role]}、合計 ${seconds(started)}）`);
  } catch (error) {
    // 外したファイルは、読めなくても知らせない（置いたものを先に消したため）。
    if (!files.includes(file)) return;
    file.status = 'error';
    file.error = error.message || String(error);
    log(`「${file.name}」を調べられませんでした（${file.error}）`);
    // 調べられなかったファイルは結合に使わないので、外されるのを待たずに、
    // PDF の中身（読み込みの結果に残るものも）と縮小画像を手放す。
    file.bytes = null;
    file.loaded = null;
    forgetStashed(file);
    for (const page of file.pages) {
      if (page.thumbUrl) URL.revokeObjectURL(page.thumbUrl);
      page.thumbUrl = '';
      page.scan = null;
    }
  } finally {
    if (held) releaseDoc(file);
    if (files.includes(file)) refresh();
  }
}

/**
 * 頁ごとの大きさを見積もる（分ける位置の提案に使う。split.js）。スキャンの頁は
 * JPEG の大きさに、ファイルの残り（文字情報・書体など）を頁の数で割った分を足す。
 */
function estimatePageBytes(file, scans) {
  const jpegs = file.pages.map((page) =>
    (scans[page.index]?.images ?? []).reduce((total, image) => total + image.jpeg.length, 0)
  );
  const rest = Math.max(0, file.bytes.length - jpegs.reduce((a, b) => a + b, 0)) / file.pages.length;
  file.pages.forEach((page, k) => {
    page.bytes = jpegs[k] + rest;
  });
}

/** OCR を使っていれば手放す（次に要るときは startOcr で用意し直す）。 */
function stopOcr() {
  if (!ocrStarting) return;
  ocrStarting = null;
  releaseOcr();
}

/**
 * PDF を作ったアプリ（文書の情報の Creator・Producer）を、記録に添える形で返す。
 * pdf.js で描くのに時間のかかる PDF が、どこで作られたものかを知るため。
 */
async function madeWith(doc) {
  const info = (await doc.getMetadata().catch(() => null))?.info ?? {};
  const names = [...new Set([info.Creator, info.Producer].filter((name) => typeof name === 'string' && name.trim()))];
  return names.length ? `作成: ${names.join(' / ')}` : '';
}

/** OCR を用意する（手放すまで 1 度だけ）。使えなければ false（文字情報だけで並べる）。 */
function startOcr() {
  if (ocrStarting) return ocrStarting;
  const started = performance.now();
  ocrStarting = prepareOcr().then(
    () => {
      log(`画像から番号を読み取る準備ができました（${seconds(started)}）`);
      return true;
    },
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
 * @returns {Promise<number>} 頁を描いて測り終えた時刻（performance.now()。余白の読み取りは
 *   その後も続くことがあるので、どちらに時間がかかったかを記録に出すため）
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
    if ((measured + read) % 8 === 0) renderFile(file);
  };
  const ocrSlots = slots(OCR_IN_FLIGHT);
  const reading = [];

  const error = await inPool(file.pages, PAGES_IN_FLIGHT, async (page) => {
    if (!files.includes(file)) return;
    const wantsOcr = ocrPages.has(page.index);
    if (wantsOcr) await ocrSlots.take();
    const { image, thumbUrl, strips } = await withContext(`${page.index + 1} 頁目の画像を描けませんでした`, () =>
      renderPageImage(file.doc, page.index, scans[page.index] ?? null, { margins: wantsOcr, softMasks: page.softMasks })
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
  const drawnAt = performance.now();
  // 読み取りも終わるのを待つ（失敗したときも。readStrips は失敗を投げない）。
  await Promise.all(reading);
  if (failed) throw error;
  return drawnAt;
}

/** 1 頁の余白の帯を OCR して、番号の候補に足す。帯は読み終えたら手放す。 */
async function readStrips(file, page, strips) {
  try {
    if (!files.includes(file) || !(await startOcr())) return;
    const results = await Promise.all(strips.map((strip) => readStrip(strip)));
    // 文字情報の候補（並びに合わなかったもの）も残し、どれが合うかは並びで決める。
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
 * 読み終えたファイルの、番号の決まっていない頁の余白を OCR する（あとから
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
  // JPEG を残していなければ（pdf-lib の書き換えが効いていないときと、中身を
  // 保存領域に置いたとき）、ここで 1 度だけ調べ直し、読む頁の分だけを取っておく。
  if (!pdfLibViews || file.stashed) {
    readProgress.stage(0, 0.1);
    showProgress(`「${file.name}」の頁の画像を調べ直しています`, null);
    // 保存領域に置いたものは、読む間だけメモリに持つ（PDF を開くのにも同じものを
    // 使い、2 度読まない。queueLateOcr が読み終えたら手放す）。
    const bytes = await bytesOf(file);
    if (!files.includes(file)) return; // 読んでいる間に外された（中身は持たない）。
    file.bytes = bytes;
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
        if (done % 8 === 0) renderFile(file);
      })
    );
  }
  await Promise.all(reading);
}

/** ファイルの、文字情報だけでは番号の決まらない頁（unsettledPages）。 */
function unsettledOf(file) {
  const indexes = unsettledPages(file.pages.map((page) => page.candidates));
  return file.pages.filter((page) => indexes.has(page.index));
}

/** 読み終えたファイルの、番号の決まっていない頁の OCR を頼む（名前で表紙と見たファイルを、番号で並べ直すとき）。 */
function queueLateOcr(file) {
  // 読んでいる最中のファイルは、もう一度は頼まない（切り替えを繰り返しても
  // 同じ頁を 2 度読まない）。
  if (file.ocrBusy) return;
  const pages = unsettledOf(file).filter((page) => !page.ocr && !manySoftMasks(page.softMasks));
  if (pages.length === 0) return;
  file.ocrBusy = true;
  renderFile(file);
  enqueue(async () => {
    try {
      // 読む間だけ開いておく（順番を待っている間は開かない）。
      holdDoc(file);
      await readMarginsWithOcr(file, pages).finally(() => releaseDoc(file));
    } finally {
      file.ocrBusy = false;
      for (const page of pages) page.scan = null;
      if (file.stashed) file.bytes = null;
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
    // 保存領域から読んだ中身は、写さずに pdf.js へ渡す（手元には残さない。描き直しで
    // 開き直すときは、もう 1 度読む）。
    const opened = file.bytes
      ? openPdf(file.bytes)
      : bytesOf(file).then((bytes) => openPdf(bytes, { transfer: true, reload: bytesOf.bind(null, file) }));
    const opening = opened.then(
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

function removeFile(file) {
  const at = files.indexOf(file);
  if (at < 0) return;
  files.splice(at, 1);
  log(`「${file.name}」を削除しました`);
  // 本に入っていたファイルを外したときだけ（読めなかったファイルなどは、本を変えない）。
  if (file.status === 'ready') resetSplits();
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
  forgetStashed(file);
  for (const page of file.pages) page.scan = null; // バイト列の一部を指しているので
  refresh();
}

/** 保存領域に置いた中身を消す。 */
function forgetStashed(file) {
  if (!file.stashed) return;
  file.stashed = false;
  stash.remove(stashName(file));
}

const byName = (a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true });

/**
 * ファイルの一覧を、選んだ並び順に並べ直す。頁番号の無いファイルは、一覧の
 * 位置で先頭・末尾に置くので、この順が結合の順になる（本文は頁番号で並ぶので
 * 変わらない）。どの並び順でも、名前で表紙と分かるものは上、裏表紙と分かる
 * ものは下に寄せる。決まらないところは追加した順（降順なら、それも逆）。
 * 更新日時の分からないファイルは、降順でも後ろへ。手で並べ替えたあとは
 * 並べ直さない（足したファイルは、名前で表紙と分かるものは先頭、裏表紙と分かる
 * ものはいちばん下、ほかは末尾の裏表紙の前に入る）。
 */
function sortFiles() {
  if (fileSort === 'manual') {
    // 手で並べた順は崩さない。足したファイルは、名前で表紙と分かるものは先頭へ（末尾だと
    // 裏表紙として置かれてしまう）、裏表紙と分かるものは末尾へ、ほかは末尾の裏表紙（名前で
    // 分かるもの）の前へ。
    const kept = files.filter((file) => file.positioned);
    let tail = kept.length;
    while (tail > 0 && nameRank(kept[tail - 1].name) === 2) tail--;
    const [covers, middle, backs] = [[], [], []];
    for (const file of files) if (!file.positioned) [covers, middle, backs][nameRank(file.name)].push(file);
    files.splice(0, files.length, ...covers, ...kept.slice(0, tail), ...middle, ...kept.slice(tail), ...backs);
    for (const file of files) file.positioned = true;
    return;
  }
  for (const file of files) file.positioned = true;
  const key = fileSort.replace(/-desc$/, '');
  const sign = fileSort.endsWith('-desc') ? -1 : 1;
  const byAdded = (a, b) => a.added - b.added;
  const compare = {
    added: byAdded,
    name: (a, b) => byName(a, b) || byAdded(a, b),
    time: (a, b) => (a.modified ?? 0) - (b.modified ?? 0) || byName(a, b) || byAdded(a, b),
  }[key];
  const unknown = (file) => key === 'time' && file.modified === null;
  // 名前の手掛かりは、比べるたびに正規表現を当てずに、先に 1 度だけ調べておく。
  const rank = new Map(files.map((file) => [file, nameRank(file.name)]));
  files.sort((a, b) => rank.get(a) - rank.get(b) || unknown(a) - unknown(b) || sign * compare(a, b));
}

/**
 * ファイルを一覧の中で動かす（first: 最前へ / up: 前へ / down: 後ろへ / last: 最後へ）。
 * 並び順は「手動」になる。
 */
function moveFile(file, where) {
  const from = files.indexOf(file);
  const to = Math.min(Math.max({ first: 0, up: from - 1, down: from + 1, last: files.length - 1 }[where], 0), files.length - 1);
  files.splice(from, 1);
  files.splice(to, 0, file);
  fileSort = 'manual';
  showManualSort(true);
  $('fileSort').value = 'manual';
  log(`「${file.name}」を一覧の ${to + 1} 番目へ動かしました`);
  refresh();
  // 動かした行のメニューに戻る（行を動かすと、押したボタンからフォーカスが外れる）。
  fileRow(file)?.querySelector('.bm-file-menu summary')?.focus();
}

/**
 * 並び順の選択肢に「手動で並べた順」を出す・外す（手で動かしたあとだけ選べる）。
 * <option hidden> は iPhone・iPad の Safari では隠れないので、足したり外したりする。
 */
function showManualSort(show) {
  const option = $('fileSortManual');
  if (show && !option) {
    const manual = el(document, 'option', null, '手動で並べた順');
    manual.value = 'manual';
    manual.id = 'fileSortManual';
    $('fileSort').append(manual);
  } else if (!show && option) {
    option.remove();
  }
}

function setFileSort(value) {
  fileSort = value;
  showManualSort(false);
  sortFiles();
  log(`ファイルを「${$('fileSort').selectedOptions[0].textContent}」に並べました`);
  refresh();
}

/**
 * 読み終えたファイルの配置をまとめて変える。auto は読み込んだときの推測に戻し、
 * 手で入れた番号・進み方も消す。配置を選んだときは、ファイルごとの番号・進み方は残す。
 */
function setAllRoles(value) {
  const ready = readyFiles();
  for (const file of ready) {
    if (value === 'auto') {
      file.role = guessRole(file.name, file.pages);
      file.coverByName = isCoverName(file.name);
      file.manual = null;
      file.coverStep = 1;
    } else {
      file.role = value;
      // 本文を選び直したら、名前で表紙と見たファイルも番号で並べ、読まなかった余白も読む。
      if (value === 'body') file.coverByName = false;
    }
  }
  if (value === 'body') ready.forEach(queueLateOcr);
  const text = value === 'auto' ? '自動' : ROLES[value];
  log(`${ready.length} ファイルの配置を「${text}」にしました`);
  $('bulkRole').value = '';
  refresh();
}

// --- 並べて確かめる ----------------------------------------------------------

function readyFiles() {
  return files.filter((file) => file.status === 'ready');
}

function fileOf(entry) {
  return files.find((f) => f.key === entry.fileKey);
}

function pageOf(entry) {
  return fileOf(entry).pages[entry.pageIndex];
}

/** 指摘の中での頁の呼び方（「「猫_奇数.pdf」の 2 頁目」）。 */
function describePage(entry) {
  return `「${fileOf(entry).name}」の ${entry.pageIndex + 1} 頁目`;
}

/** 並びと指摘を組み立て直し、画面を描き直す。結合した PDF は捨てる。 */
function refresh() {
  const ready = readyFiles();
  const numberings = numberFiles(ready, overrides);
  const { order, mismatch, places } = arrangeBook(ready, numberings, overrides);
  const sheets = ready.some(
    (file) => places.get(file.key) === 'numbered' && Math.abs(numberings.get(file.key).step ?? 0) === 2
  );
  const problems = checkSequence(order, { sheets, mismatch });
  const { textless, problem } = textCoverage(order, pageOf);
  if (problem) problems.push(problem);

  const bodyPages = order
    .filter((entry) => entry.role === 'body')
    .map((entry) => {
      const page = pageOf(entry);
      return { key: entry.pageKey, side: sideOf(entry.number, entry.branch), size: page.size, measure: page.measure };
    });
  const duplicates = duplicateIssues(
    order,
    findDuplicates(
      ready.flatMap((file) =>
        file.pages.map((page) => ({ key: page.key, text: page.textPrint, image: page.measure.print }))
      )
    ),
    describePage
  );
  if (duplicates.problem) problems.push(duplicates.problem);
  const issues = pageIssues(
    order,
    problems,
    mergeIssues(compareScans(bodyPages), duplicates.issues, textIssues(order, pageOf)),
    textless
  );

  // 分ける位置。手で決めていなければ、上限に収まるように提案する。
  const byKey = new Map(files.map((file) => [file.key, file]));
  // 区切りらしさの手掛かり（split.js の breakCandidates・breakRanks）: しおり・見出しのほかに、
  // 目次の項目が指す頁（目次の題）、柱、本文の頁番号（戻るところ）。どれか 1 つに頼らず、
  // 点数を足して確からしさを決める（目次の無い資料・章ごとにスキャンした資料もあるので）。
  const fromToc = tocStarts(order, byKey);
  const items = order.map((entry, index) => {
    const file = byKey.get(entry.fileKey);
    const { bytes, outline, heading, running } = file.pages[entry.pageIndex];
    const number = entry.role === 'body' && !entry.branch ? entry.number : null;
    const toc = fromToc.get(index) ?? null;
    // 名前には、目次の題があればそれを使う（扉の OCR の文字より崩れていない）。
    return { fileKey: entry.fileKey, role: entry.role, fileName: file.name, bytes, outline, heading: toc ?? heading, running, number, toc };
  });
  const breaks = breakCandidates(items);
  const ranks = breakRanks(items, breaks);
  const starts = manualSplits
    ? order.flatMap((entry, index) => (index > 0 && manualSplits.has(entry.pageKey) ? [index] : []))
    : splitByRank(items, breaks, splitLimits, ranks);
  // 分けたファイルの名前に添える、区切りの名前。
  const labels = partLabels(items, breaks, starts, { joinNext: !manualSplits, ranks });

  // 区切りの候補の一覧に出す候補と、「見出しの候補でもすべて分ける」で分ける位置。
  const shown = seamCandidates(breaks, ranks);
  view = {
    order,
    problems,
    issues,
    numberings,
    places,
    anyNumbered: [...places.values()].includes('numbered'),
    starts,
    breaks,
    labels,
    items,
    shown,
    ranks,
  };
  // 自動で提案した分ける位置と、その訳（変わったときだけ）。提案が思ったところと違う
  // ときに、どの手掛かりで選んだかを記録から追えるように。
  const note = manualSplits || !starts.length ? '' : suggestionText(order, starts, breaks, ranks);
  if (note !== suggestionNote) {
    suggestionNote = note;
    if (note) log(note);
  }
  if (!$('outputName').value.trim() || $('outputName').dataset.suggested === 'true') {
    const suggested = suggestBookName(files.map((file) => file.name));
    $('outputName').value = suggested;
    $('outputName').dataset.suggested = 'true';
  }
  // 裏の処理（ほかのファイルの読み込み・OCR）が終わっただけで、結合する中身
  // （頁・配置・頁番号と、名前）が変わらなければ、結合した PDF はそのまま使える。
  // 名前は提案し直すことがあるので、ここで一緒に比べる。
  const key = mergeKey();
  if (key !== orderKey) {
    orderKey = key;
    discardMerged();
  }

  renderFiles();
  renderReview();
  renderSplit();
}

/**
 * 目次の項目が指す頁（並びの位置 → 目次の題）。本に入れている頁の目次の項目の頁番号を、
 * 本文の頁の頁番号（枝番の無いもの）に当てる。同じ頁を指す項目は、先のものを使う。
 */
function tocStarts(order, byKey) {
  const at = new Map();
  order.forEach((entry, index) => {
    if (entry.role === 'body' && !entry.branch && !at.has(entry.number)) at.set(entry.number, index);
  });
  const starts = new Map();
  // 目次の項目は、本に入れている頁から読む。
  for (const entry of order) {
    for (const { title, page: number } of byKey.get(entry.fileKey).pages[entry.pageIndex].tocEntries) {
      const index = at.get(number);
      if (index !== undefined && !starts.has(index)) starts.set(index, title);
    }
  }
  // 目次の頁番号が扉の次の頁（本文の始まり）を指し、扉に同じ階層の見出しがあれば、扉から始める。
  const heading = (index) => byKey.get(order[index].fileKey).pages[order[index].pageIndex].heading;
  return new Map(
    [...starts].map(([index, title]) => {
      const before = index > 0 && !starts.has(index - 1) ? heading(index - 1) : null;
      return [before && headingRank(before) === headingRank(title) ? index - 1 : index, title];
    }),
  );
}

/** 結合する中身（名前と分ける位置、並びの頁・配置・頁番号）を 1 つの文字列にしたもの。 */
function mergeKey() {
  // 状態と部は頁ラベル（表紙・番号なし・部が分かれていれば付けない）を決める。
  return [
    outputName(),
    view.starts.join(','),
    // 分けたファイルの名前（区切りの名前）も、結合した PDF に書き込むので。
    view.labels.join('\n'),
    ...view.order.map(
      (entry) =>
        `${entry.pageKey}|${entry.role}|${entry.number}|${entry.branch ?? ''}|${entry.role === 'body' ? '' : entry.status}|${entry.part}`
    ),
  ].join('\n');
}

function discardMerged() {
  generation++;
  merged = null;
  renderDownloads();
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

/** 描いた行・カードの中身の要約（reconcile が、作り直すかどうかを決めるのに使う）。 */
const drawnAs = new WeakMap();

/**
 * 一覧（ファイルの一覧・頁の一覧）を、items の順に描く。中身の要約（sig）が
 * 前に描いたときと同じ行・カードは、作り直さずにそのまま使い、並びが変わった
 * ところだけ動かす。
 *
 * ファイルを 1 つ調べ終えるたびに一覧をまるごと作り直すと、作っては捨てる要素の
 * 数がファイルの数の 2 乗になる（424 ファイルで、1 回に約 1 万 9 千個、通しで
 * 約 400 万個）。iPhone では、調べている途中でページごと落ちた。並びや指摘は
 * 毎回計算し直すが（軽い）、要素を作るのは中身の変わった行・カードだけにする。
 * sig には、その行・カードに出すもの（と、操作のときに使うもの）をすべて入れる。
 *
 * @param {HTMLElement} list
 * @param {{key:string, sig:string, build:() => HTMLElement}[]} items key は一覧の中で重ならないこと
 */
function reconcile(list, items) {
  const drawn = new Map([...list.children].map((node) => [node.dataset.key, node]));
  const nodes = items.map(({ key, sig, build }) => {
    const node = drawn.get(key);
    if (node && drawnAs.get(node) === sig) return node;
    const fresh = build();
    fresh.dataset.key = key;
    drawnAs.set(fresh, sig);
    return fresh;
  });
  // もう出さない行（と、作り直した行の古いもの）を先に外す（残すと、その後ろの
  // 行がみな動くことになる）。
  const keep = new Set(nodes);
  for (const node of [...list.children]) if (!keep.has(node)) node.remove();
  // 残った行は前と同じ順に並んでいるので、並びの違うところだけ入れる・動かす。
  let cursor = list.firstElementChild;
  for (const node of nodes) {
    if (node === cursor) cursor = cursor.nextElementSibling;
    else list.insertBefore(node, cursor);
  }
}

function renderFiles() {
  reconcile($('fileList'), files.map(fileEntry));
  showFileFields();
}

/** ファイルの一覧の 1 行（reconcile に渡す形）。at は一覧の中の位置。 */
function fileEntry(file, at) {
  const numbering = file.role === 'body' ? view.numberings.get(file.key) : null;
  const sig = JSON.stringify([
    file.name,
    file.status,
    file.open,
    file.role,
    file.manual,
    file.coverStep,
    fileMeta(file),
    file.status === 'ready' ? fileDetails(file) : '',
    // 設定の欄（fileControls）の「先頭の頁の番号」の見本と、進み方の既定。
    numbering?.pages[0]?.number ?? null,
    numbering?.step ?? null,
    view.places.get(file.key) ?? null,
    file.coverByName,
    // メニューの「前へ」「後ろへ」を押せるか。
    at === 0,
    at === files.length - 1,
  ]);
  return { key: file.key, sig, build: () => fileItem(file, at) };
}

/**
 * ファイル 1 つの行だけを描き直す（読み込み・調べる途中の経過など、そのファイルの
 * 見出しだけが変わるとき）。ほかの行の要約は計算し直さない。
 */
function renderFile(file) {
  const node = fileRow(file);
  if (!node) return;
  const { sig, build } = fileEntry(file, files.indexOf(file));
  if (drawnAs.get(node) === sig) return;
  const fresh = build();
  fresh.dataset.key = file.key;
  drawnAs.set(fresh, sig);
  node.replaceWith(fresh);
  showFileFields();
}

/** 一覧の中の、ファイルの行。 */
function fileRow(file) {
  return [...$('fileList').children].find((li) => li.dataset.key === file.key);
}

/** 一覧のまわりの欄（並び順・一括設定・確かめる・保存）を、ファイルの数に合わせて出す。 */
function showFileFields() {
  $('fileSortField').hidden = files.length < 2;
  $('bulkRoleField').hidden = readyFiles().length < 2;
  $('checkSection').hidden = readyFiles().length === 0;
  $('outputSection').hidden = readyFiles().length === 0;
}

// ファイルは 1 つずつ折り畳める（<portal-section>）。束が何ファイルもあると
// 設定の欄で一覧が長くなるので、既定は閉じておき、見出しの行には名前と
// 設定の要約の 2 行だけを残す。開け閉めは描き直しても保つ。
function fileItem(file, at) {
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

  const menu = fileMenu(file, at);
  menu.slot = 'actions';
  section.append(menu);

  if (ready) {
    const details = fileDetails(file);
    if (details) section.append(el(document, 'p', 'hint bm-file-details', details));
    section.append(fileControls(file));
  }
  item.append(section);
  return item;
}

/**
 * ファイルの行のメニュー（一覧の中で動かす・削除）。頁番号の無いファイルは、
 * 一覧の位置で先頭・末尾に置くので、ここで並べ替える。
 */
function fileMenu(file, at) {
  const menu = el(document, 'details', 'bm-file-menu');
  // 外を押して閉じたときに、開いていた印も消す（toggle はあとから届くので、その前に
  // 行を描き直しても開き直さないように）。
  menu.forget = () => {
    file.menuOpen = false;
  };
  // メニューの中（ボタンの間・余白）を押しても、見出しの行の開け閉めにしない
  // （ページの他の処理に届くよう、click は止めない）。
  menu.dataset.interactive = '';
  // 開いている間に行を描き直しても（ほかのファイルを読み終えた、など）、開いたまま。
  menu.open = Boolean(file.menuOpen);
  menu.addEventListener('toggle', () => {
    file.menuOpen = menu.open;
  });
  const summary = el(document, 'summary', 'secondary', '…');
  summary.title = 'このファイルの操作';
  summary.setAttribute('aria-label', `「${file.name}」の操作`);
  menu.append(summary);
  const list = el(document, 'div', 'bm-menu');
  const item = (text, title, onClick, disabled = false, className = 'secondary') => {
    const button = smallButton(text, title, () => {
      menu.open = false;
      file.menuOpen = false;
      onClick();
    }, className);
    button.disabled = disabled;
    list.append(button);
  };
  item('最前へ', '一覧のいちばん上へ動かす', () => moveFile(file, 'first'), at === 0);
  item('前へ', '一覧で 1 つ上へ動かす', () => moveFile(file, 'up'), at === 0);
  item('後ろへ', '一覧で 1 つ下へ動かす', () => moveFile(file, 'down'), at === files.length - 1);
  item('最後へ', '一覧のいちばん下へ動かす', () => moveFile(file, 'last'), at === files.length - 1);
  item('削除', 'このファイルを削除', () => removeFile(file), false, 'secondary danger');
  menu.append(list);
  return menu;
}

/** 置き場所（ordering.js の placeFiles）ごとの、見出しの要約の頭。 */
const PLACE_SHORT = {
  numbered: '本文',
  front: '番号なし→先頭',
  back: '番号なし→末尾',
  between: '番号なし→置き場所不明',
  split: '前半を先頭・後半を末尾',
  exclude: '結合しない',
};

/**
 * 見出しの 2 行目。読み込みの経過か、置き場所と設定の要約（本文なら頁番号を並べて。
 * 例: 本文(頁番号: -11, -9, -7...13, 15)）。本文が 1 つも無ければ、番号の無い
 * ファイルは一覧の順につなぐ。
 */
function fileMeta(file) {
  if (file.status === 'error') return file.error;
  if (file.status !== 'ready') return STATUS_TEXT[file.status];
  const details = [];
  const place = view.places.get(file.key);
  if (place === 'numbered') {
    details.push(`頁番号: ${numberingSequence(view.numberings.get(file.key))}`);
    if (file.manual) details.push('手入力');
  } else {
    details.push(`${file.pages.length} 頁`);
    if (place !== 'exclude' && file.coverStep === -1) details.push('最後の頁から');
  }
  if (file.ocrBusy) details.push('余白を読み取り中');
  const head = place === 'front' && !view.anyNumbered ? '一覧の順につなぐ' : PLACE_SHORT[place];
  return `${head}(${details.join(', ')})`;
}

/** 開いたときに出す、読み取りの内訳（番号を読めた頁の数・文字情報の無い頁）。 */
function fileDetails(file) {
  const parts = [];
  const numbering = file.role === 'body' ? view.numberings.get(file.key) : null;
  if (numbering) {
    // 手で入れた番号でも、読み取りがその番号と合っていれば読めた頁に数える
    // （番号を直しただけで内訳が変わらないように）。
    const readPages = numbering.pages.filter(
      (page) => page.status === 'detected' || (page.status === 'manual' && page.read)
    );
    const read = readPages.length;
    const byOcr = readPages.filter((page) => page.read?.source === 'ocr').length;
    parts.push(`${file.pages.length} 頁のうち番号を読めた頁 ${read}${byOcr ? `（うち画像から ${byOcr}）` : ''}`);
  }
  const textPages = file.pages.filter((page) => page.signature.length > 0).length;
  if (textPages < file.pages.length) parts.push(`文字情報なし ${file.pages.length - textPages} 頁`);
  return parts.join('・');
}

function fileControls(file) {
  const controls = el(document, 'div', 'bm-file-controls');

  const roleField = el(document, 'label', 'bm-inline');
  roleField.append('配置 ');
  const role = el(document, 'select');
  for (const [value, text] of Object.entries(ROLES)) {
    const option = el(document, 'option', null, text);
    option.value = value;
    option.selected = value === file.role;
    role.append(option);
  }
  role.addEventListener('change', () => {
    // 名前で表紙と見たファイルは、選び直しても番号を見ない（「頁番号を読んで並べる」で変える）。
    file.role = role.value;
    refresh();
  });
  roleField.append(role);
  controls.append(roleField);

  if (file.role === 'exclude') return controls;
  if (file.role === 'split') return coverControls(file, controls);

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
  // 番号の無いファイルは、一覧の位置で置く（その並べ方）。
  if (view.places.get(file.key) !== 'numbered') coverControls(file, controls);
  return controls;
}

/**
 * 番号の無いファイル（と、表紙と裏表紙のファイル）の進み方。逆順にすると、
 * 給紙の都合で最後の頁から並んだファイルを並べ直す。置き場所（先頭・末尾）と
 * ほかのファイルとの順は、一覧の位置で決まる。
 */
function coverControls(file, controls) {
  const stepField = el(document, 'label', 'bm-inline');
  stepField.append('番号が無いときの進み方 ');
  const step = el(document, 'select', 'bm-cover-step');
  [
    ['1', '1 つずつ'],
    ['-1', '1 つずつ逆順（最後の頁から）'],
  ].forEach(([value, text]) => {
    const option = el(document, 'option', null, text);
    option.value = value;
    option.selected = String(file.coverStep) === value;
    step.append(option);
  });
  step.addEventListener('change', () => {
    file.coverStep = Number(step.value);
    refresh();
  });
  stepField.append(step);
  controls.append(stepField);
  // 表紙と裏表紙のファイルは、一覧の位置によらず前半を先頭・後半を末尾に置く。
  if (file.role !== 'body') return controls;
  const note = el(
    document,
    'span',
    'hint',
    '頁番号の無いファイルは、一覧で本文のファイルより上にあれば先頭へ、下にあれば末尾へ、一覧の順に置きます（「…」のメニューで並べ替えられます）。' +
      (file.coverByName ? '名前から表紙・裏表紙と見たファイルは、頁番号を見ません。' : '')
  );
  controls.append(note);
  if (file.coverByName) {
    controls.append(
      smallButton('頁番号を読んで並べる', '名前によらず、頁番号を読んで並べる', () => {
        file.coverByName = false;
        // 名前で表紙と見て読まなかった余白も読む。
        queueLateOcr(file);
        refresh();
      })
    );
  }
  return controls;
}

// --- 描く：並びの確認 --------------------------------------------------------

function renderReview() {
  contextNow = cardContext();
  renderProblems();
  renderGrid();
}

/** いま出している指摘の項目（key ごと）と、頁のカードを作るときに引く表。項目の中のボタンは、押したときにここから最新のものを引く。 */
let groupsNow = new Map();
let contextNow = null;

function renderProblems() {
  const groups = issueGroups(view.order, view.problems, view.issues);
  groupsNow = new Map(groups.map((group) => [group.key, group]));
  // もう無い（開けない）項目の開閉と出す数は忘れる（同じ項目がまた出たときに、勝手に開かないように）。
  for (const key of openGroups.keys()) if (!groupsNow.get(key)?.pageKeys.length) openGroups.delete(key);
  // 項目は、数や頁が変わっても作り直さない（開いた項目の中で番号を直したときに、
  // 入力欄や並べた頁を作り直して、どこまで見たかを見失わないように）。文と頁だけ差し替える。
  const items = groups.map((group) => ({
    key: group.key,
    sig: `${group.level}:${group.pageKeys.length > 0}`,
    build: () => problemItem(group),
  }));
  if (items.length === 0 && view.order.length) {
    items.push({
      key: 'ok',
      sig: 'ok',
      build: () => el(document, 'li', 'bm-problem ok', '頁の抜け・重なり・スキャンの乱れは見つかりませんでした。'),
    });
  }
  reconcile($('problems'), items);
  for (const item of $('problems').children) {
    const group = groupsNow.get(item.dataset.key);
    if (!group) continue;
    const details = item.querySelector(':scope > details');
    (details?.querySelector('summary') ?? item.firstElementChild).textContent = group.message;
    // 開いた直後で toggle がまだ届いていない項目は、toggle の側で並べる。
    if (details?.open && openGroups.has(group.key)) renderGroupPages(details, group);
  }
}

/** 開いた項目に一度に並べる頁の数（数百頁が該当しても、カードを一度に作りすぎない）。 */
const GROUP_PAGE_STEP = 60;

/**
 * 指摘の項目 1 つ。該当する頁があれば、押すと開いてその頁だけを並べる（すべての
 * 頁の一覧から探さずに済むように）。頁のカードは開いたときに作る（数百頁の本で、
 * 開かない項目の縮小画像まで並べないように）。文は renderProblems が入れる。
 */
function problemItem(group) {
  const { key } = group;
  const item = el(document, 'li', `bm-problem ${group.level}`);
  if (group.pageKeys.length === 0) {
    item.append(el(document, 'span'));
    return item;
  }
  const details = el(document, 'details', 'bm-problem-details');
  const more = el(document, 'button', 'secondary bm-problem-more');
  more.type = 'button';
  more.addEventListener('click', () => {
    openGroups.set(key, openGroups.get(key) + GROUP_PAGE_STEP);
    renderGroupPages(details, groupsNow.get(key));
  });
  details.append(el(document, 'summary'), el(document, 'ol', 'bm-grid bm-problem-pages'), more);
  // 開いたまま作り直すときは、すぐ頁を並べる（renderProblems）。open を変えると
  // toggle が後から届くが、そのときは開閉の記録がもう合っているので何もしない。
  details.open = openGroups.has(key);
  details.addEventListener('toggle', () => {
    // 作り直して外した項目に後から届いた toggle と、開閉の記録がもう合っているものは、何もしない。
    if (!details.isConnected || details.open === openGroups.has(key)) return;
    if (details.open) {
      openGroups.set(key, GROUP_PAGE_STEP);
      renderGroupPages(details, groupsNow.get(key));
    } else {
      openGroups.delete(key);
      details.querySelector('.bm-problem-pages').replaceChildren();
    }
  });
  item.append(details);
  return item;
}

function renderGroupPages(details, group) {
  const limit = openGroups.get(group.key);
  const cards = group.pageKeys
    .slice(0, limit)
    .map((pageKey) => pageCardItem(contextNow.entries.get(pageKey), { jump: true }));
  reconcile(details.querySelector('.bm-problem-pages'), cards);
  const rest = group.pageKeys.length - limit;
  const more = details.querySelector('.bm-problem-more');
  more.hidden = rest <= 0;
  more.textContent = `さらに ${Math.min(rest, GROUP_PAGE_STEP)} 頁並べる（残り ${rest} 頁）`;
}

/** 頁のカードを作るときに引くもの（ファイルと頁の並びを key から引く表）。描き直すたびに作る。 */
function cardContext() {
  return {
    files: new Map(files.map((file) => [file.key, file])),
    entries: new Map(view.order.map((entry) => [entry.pageKey, entry])),
    // 並びの位置と、新しいファイルを始める頁 → 何番目のファイルか（分ける位置の印）。
    indexes: new Map(view.order.map((entry, index) => [entry.pageKey, index])),
    parts: new Map(view.starts.map((index, k) => [view.order[index].pageKey, k + 2])),
  };
}

/** すべての頁の一覧で、その頁の前後を見せる（項目の中の頁から飛ぶ）。 */
function jumpToPage(pageKey) {
  const card = $('pageGrid').querySelector(`[data-page-key="${pageKey}"]`);
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('focus');
  setTimeout(() => card.classList.remove('focus'), 1600);
}

function renderGrid() {
  const indexOf = new Map(view.order.map((entry, index) => [entry.pageKey, index]));
  // 何番目のファイルの頁か（0 から）。ファイルごとに地の色を変えるのに使う。
  const partAt = splitRanges(view.order.length, view.starts).flatMap(({ start, end }, k) => Array(end - start).fill(k));
  const cards = [];
  const seen = new Map(); // 抜けの札の key が重ならないように（番号が前後と合わないと、同じ抜けが 2 度出る）
  for (const item of gridItems(view.order)) {
    if (item.type === 'missing') {
      const range = `${item.part}:${item.from}-${item.to}${item.branch ? `-${item.branch}` : ''}`;
      seen.set(range, (seen.get(range) ?? 0) + 1);
      cards.push({ key: `missing:${range}:${seen.get(range)}`, sig: range, build: () => missingCard(item) });
      continue;
    }
    cards.push(pageCardItem(item.entry));
  }
  reconcile($('pageGrid'), cards);
  // ファイルごとの地の色は、札を作り直さずに付け替える（分ける位置を 1 つ変えると、
  // 後ろの頁のすべてで変わるので、札の中身の要約には入れない）。
  for (const card of $('pageGrid').children) {
    if (card.dataset.pageKey) card.classList.toggle('part-alt', partAt[indexOf.get(card.dataset.pageKey)] % 2 === 1);
  }
}

/** 頁の縮小画像。押すと拡大して見る。 */
function thumbButton(entry) {
  const file = files.find((f) => f.key === entry.fileKey);
  const thumb = el(document, 'button', 'bm-thumb');
  thumb.type = 'button';
  thumb.title = '拡大して見る';
  const image = el(document, 'img');
  image.src = file.pages[entry.pageIndex].thumbUrl;
  image.alt = `${displayLabel(entry)}（${file.name} の ${entry.pageIndex + 1} 頁目）`;
  image.loading = 'lazy';
  thumb.append(image);
  thumb.addEventListener('click', () => openPreview(entry.pageKey));
  return thumb;
}

/**
 * 頁のカードを reconcile に渡す形にする（すべての頁の一覧と、指摘の項目の中で使う）。
 * jump: すべての頁の一覧のその頁へ飛ぶボタンを付ける（項目の中の頁）。
 */
function pageCardItem(entry, { jump = false } = {}) {
  const issues = view.issues.get(entry.pageKey) || [];
  const file = contextNow.files.get(entry.fileKey);
  const index = contextNow.indexes.get(entry.pageKey);
  const split = { first: index === 0, part: contextNow.parts.get(entry.pageKey) ?? null, candidate: view.breaks[index] };
  const sig = JSON.stringify([
    entry,
    issues,
    file.name,
    file.pages.length,
    file.pages[entry.pageIndex].thumbUrl,
    overrides.get(entry.pageKey) ?? null,
    split,
  ]);
  return { key: entry.pageKey, sig, build: () => pageCard(entry, file, issues, { jump, split }) };
}

function missingCard(item) {
  const card = el(document, 'li', 'bm-page missing');
  card.append(
    el(document, 'span', 'bm-missing-label', missingLabel(item)),
    el(document, 'span', 'hint', 'ありません')
  );
  return card;
}

function pageCard(entry, file, issues, { jump, split }) {
  const level = worstLevel(issues);
  const marks = [level, split.part ? 'split-start' : split.candidate ? 'split-candidate' : ''].filter(Boolean);
  const card = el(document, 'li', ['bm-page', ...marks].join(' '));
  card.dataset.pageKey = entry.pageKey;
  if (split.part) card.append(el(document, 'div', 'bm-split-mark', `ここから ${split.part} つ目のファイル`));
  card.append(thumbButton(entry));

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

  // 番号で並べる配置のファイルの頁には、番号の欄を出す（番号を読めずに一覧の位置で先頭・
  // 末尾に置いた頁も。何頁か直せば、残りの頁はその番号から推定し直す）。
  if (entry.role === 'body' || file.role === 'body') {
    const input = el(document, 'input', 'bm-page-number');
    input.type = 'text';
    input.placeholder = '番号を直す';
    // 指摘の項目の中にも同じ頁が並ぶので、読み上げでどちらの欄か分かるようにする。
    input.setAttribute('aria-label', `${displayLabel(entry)} の番号を直す${jump ? '（指摘の項目の中）' : ''}`);
    input.value = overrides.has(entry.pageKey) ? pageNumberText(overrides.get(entry.pageKey)) : '';
    input.addEventListener('change', () => {
      const value = input.value.trim();
      const number = parsePageNumber(value);
      if (!value) {
        overrides.delete(entry.pageKey);
      } else if (number) {
        overrides.set(entry.pageKey, number);
      } else {
        showMessage('番号は数字（枝番の付いた頁は 57-1 の形）で入れてください。', 'red');
        return;
      }
      showMessage('');
      refresh();
    });
    card.append(input);
  }
  if (jump) {
    const title = 'すべての頁の一覧で、この頁の前後を見る';
    card.append(smallButton('前後を見る', title, () => jumpToPage(entry.pageKey), 'secondary bm-page-jump'));
  } else if (!split.first) {
    // すべての頁の一覧では、先頭の頁のほかは、その頁の前で分ける・分けないを切り替え
    // られる。候補なら、その理由も出す。
    const row = el(document, 'div', 'bm-split-toggle');
    if (split.candidate) row.append(el(document, 'span', 'bm-split-reason', breakReason(split.candidate)));
    row.append(
      smallButton(
        split.part ? '分けない' : 'ここから分ける',
        split.part ? 'この頁の前で分けるのをやめる' : 'この頁から新しいファイルにする',
        () => toggleSplit(entry.pageKey)
      )
    );
    card.append(row);
  }
  return card;
}

// --- 分ける ------------------------------------------------------------------

/** その頁の前で分ける・分けないを切り替える（以後は、手で決めた位置に従う）。 */
function toggleSplit(pageKey) {
  keepSplits();
  // 手で切り替えた位置は、上限に収まるように選んだ位置ではなくなる。
  limitCuts.delete(pageKey);
  const removed = manualSplits.delete(pageKey);
  if (!removed) manualSplits.add(pageKey);
  const entry = view.order.find((item) => item.pageKey === pageKey);
  log(`${displayLabel(entry)}の前で${removed ? '分けるのをやめました' : '分けます'}`);
  refresh();
}

/** 手で決める前なら、いまの分ける位置を、手で決めた位置の始まりにする。 */
function keepSplits() {
  if (manualSplits) return;
  const keyOf = (index) => view.order[index].pageKey;
  manualSplits = new Set(view.starts.map(keyOf));
  limitCuts = new Set(view.starts.filter((index) => !view.breaks[index]).map(keyOf));
}

/** 区切りの候補と、分ける位置（並びの位置、小さい順）。 */
function seamIndexes() {
  const at = new Set(view.starts);
  view.shown.forEach((shown, index) => {
    if (shown) at.add(index);
  });
  return [...at].sort((a, b) => a - b);
}

/** その位置で分ける・分けうる訳。 */
function seamReason(index) {
  const candidate = view.breaks[index];
  if (candidate) return breakReason(candidate);
  return manualSplits && !limitCuts.has(view.order[index].pageKey) ? '手で決めた位置' : '上限に収まるように選んだ位置';
}

/** 自動の提案に戻す。 */
function autoSplits() {
  manualSplits = null;
  log('分ける位置を、自動の提案に戻しました');
  refresh();
}

/**
 * ファイルを足したり外したりして本が変わったら、手で決めた分ける位置は捨てて、
 * 自動の提案に戻す（前の本で決めた位置に、次の本が黙って従わないように）。
 */
function resetSplits() {
  if (!manualSplits) return;
  manualSplits = null;
  log('ファイルが変わったので、分ける位置を自動の提案に戻しました');
}

/** 分ける上限を覚えておいたものから読む（読めなければ既定のまま）。 */
function loadLimits() {
  const positive = (value) => (Number.isFinite(value) && value > 0 ? value : null);
  try {
    const saved = JSON.parse(localStorage.getItem(LIMITS_KEY));
    if (saved) {
      splitLimits = { megabytes: positive(saved.megabytes), pages: positive(saved.pages) };
    }
  } catch {
    // 覚えた値を読めなくても（保存を禁じたブラウザ・壊れた値）、既定の上限で使える。
  }
  $('splitMegabytes').value = splitLimits.megabytes ?? '';
  $('splitPages').value = splitLimits.pages ?? '';
}

/** 分ける上限を覚えておく（覚えておけなくても、この画面の間は使える）。 */
function saveLimits() {
  try {
    localStorage.setItem(LIMITS_KEY, JSON.stringify(splitLimits));
  } catch {
    // 保存を禁じたブラウザなど。
  }
}

/** 上限の欄を変えたら、覚えておき、自動の提案をし直す。 */
function setLimit(key, input) {
  // 日本語入力のまま打った全角の数字も受ける。
  const value = normalizeDigits(input.value).replace(/．/g, '.').trim();
  const number = Number(value);
  if (value && (!(number > 0) || (key === 'pages' && !Number.isInteger(number)))) {
    showMessage(`上限は${key === 'pages' ? '1 以上の整数' : '0 より大きい数'}で入れてください（空なら上限なし）。`, 'red');
    input.value = splitLimits[key] ?? '';
    return;
  }
  splitLimits = { ...splitLimits, [key]: value ? number : null };
  saveLimits();
  manualSplits = null;
  showMessage('');
  refresh();
  // 分ける位置が変わらなければ結合した PDF は残るので、上限を超えたかの知らせを出し直す。
  if (merged) renderVerify();
}

/** 分ける位置の説明と、分けたファイルの一覧（頁の範囲・大きさの見積もり）。 */
function renderSplit() {
  const { order, starts } = view;
  const spans = splitRanges(order.length, starts);
  $('splitAutoBtn').hidden = !manualSplits;
  // 分けるとき（how）と、1 ファイルにまとめるとき（why）の、そうした訳。
  const limited = splitLimits.megabytes || splitLimits.pages;
  let how;
  let why;
  if (manualSplits) {
    how = '手で決めた位置で';
    why = '手で分ける位置を外しました';
  } else {
    how = '上限を超えるので、確からしい区切りから順に';
    why = limited ? '上限に収まります' : '上限がありません';
  }
  const tail =
    order.length > 1 ? '下の一覧でファイルを選ぶと、その始まりと終わりを前後の頁を見ながら動かせます。' : '';
  $('splitNote').textContent =
    spans.length > 1 ? `${spans.length} ファイルに分けます（${how}）。${tail}` : `1 ファイルにまとめます（${why}）。${tail}`;
  // 分けたファイルの一覧。1 ファイルにまとめるときも、そのファイルの大きさと上限に
  // 対する棒を出す。選んだファイルの下には、始まりと終わりを動かす欄を出す。前と
  // 同じ中身の行は作り直さない。
  const shown = order.length ? spans : [];
  const at = order.findIndex((entry) => entry.pageKey === selectedKey);
  // 選んだ頁が本から外れたら、選ぶのをやめる。
  if (at < 0) selectedKey = '';
  const name = outputName();
  const plan = [];
  shown.forEach(({ start, end }, k) => {
    const selected = start <= at && at < end;
    if (!selected) {
      plan.push(partEntry({ start, end, k, count: spans.length, name, limited, controls: null }));
      return;
    }
    // 選んだファイルは、上（前のファイルとの間）に始まりの帯、下（次のファイルとの間）に
    // 終わりの帯を出す（境目のある場所に置き、2 つの帯が同じところに並ばないように）。
    // 本の最初と最後には境目が無いので、帯は出さない。
    const [first, last] = fileEdges(spans, k);
    const ids = [first.index !== null ? 'partEditorStart' : '', last.index !== null ? 'partEditorEnd' : ''].filter(Boolean);
    if (first.index !== null) plan.push(edgeEntry(first, 'before'));
    plan.push(partEntry({ start, end, k, count: spans.length, name, limited, controls: ids.join(' ') }));
    if (last.index !== null) plan.push(edgeEntry(last, 'after'));
    if (end - start >= 2) plan.push(splitEntry(start, end));
  });
  if (dragging) return;
  // 境目を動かしたあとは、動かした先の間（動かさなかった方の帯は今の境目）を、動かす
  // 前と同じ見た目の位置に置く（帯が送られて見失わないように）。ファイルを選び直した
  // とき・まとめたときは、真ん中に置く。
  const kept = new Map();
  if (keepAt !== null) {
    for (const strip of $('splitPlan').querySelectorAll('.bm-edge-strip')) {
      const edge = strip.closest('.bm-edge').dataset.edge;
      const page = strip.querySelector(edge === keepAt.edge ? `.bm-edge-page[data-at="${keepAt.at}"]` : '.bm-edge-page.cut');
      kept.set(edge, page.getBoundingClientRect().left - strip.getBoundingClientRect().left);
    }
  }
  keepAt = null;
  reconcile($('splitPlan'), plan);
  for (const editor of $('splitPlan').querySelectorAll('[data-fresh]')) {
    delete editor.dataset.fresh;
    for (const strip of editor.querySelectorAll('.bm-edge-strip')) {
      // 今の境目（その後ろの頁の左の縁）の、帯の左端からの見た目の位置。
      const now = strip.querySelector('.bm-edge-page.cut').getBoundingClientRect().left - strip.getBoundingClientRect().left;
      strip.scrollLeft += now - (kept.get(strip.closest('.bm-edge').dataset.edge) ?? strip.clientWidth / 2);
    }
  }
  if (refocus) {
    // 押したボタンは描き直すと無くなるので、描き直したものへキーボードの位置を戻す
    // （まとめたときなど、もう無ければそのまま）。
    $('splitPlan').querySelector(refocus)?.focus();
    refocus = '';
  }
  if (previewKey) renderPreviewSplit();
}

/** 一覧でファイルを選ぶ・選ぶのをやめる（start はそのファイルの最初の頁の位置）。 */
function selectPart(start, selected) {
  const key = view.order[start].pageKey;
  selectedKey = selected ? '' : key;
  refocus = `[data-key="part:${key}"] .bm-part-select`;
  // 上に始まりの帯が入っても（無くなっても）、押した行が画面の同じ高さに残るように送る。
  const row = () => $('splitPlan').querySelector(`[data-key="part:${key}"]`).getBoundingClientRect().top;
  const before = row();
  renderSplit();
  document.documentElement.scrollTop += row() - before;
}

/** 分ける位置 from を to へ動かす（以後は、手で決めた位置に従う）。 */
function moveCut(from, to, edge) {
  keepSplits();
  keepAt = { edge, at: to };
  const { order } = view;
  for (const index of [from, to]) limitCuts.delete(order[index].pageKey);
  manualSplits.delete(order[from].pageKey);
  manualSplits.add(order[to].pageKey);
  // 選んだファイルの最初の頁を後ろへ動かしたら、選んだ頁も付いていく（前のファイルに
  // 移った頁を選んだままにしない）。
  if (selectedKey === order[from].pageKey && to > from) selectedKey = order[to].pageKey;
  // 描き直したあと、動かした境目（✂）にキーボードの位置を置く。
  refocus = `[data-edge="${edge}"] .bm-cut-marker`;
  log(`${displayLabel(order[from])}の前で分けていたのを、${displayLabel(order[to])}の前にしました`);
  refresh();
}

/** ファイルを 2 つに分ける（中の区切りのうち、いちばん確からしいもので。無ければ真ん中で）。 */
function splitPart(start, end) {
  toggleSplit(view.order[middleCut(view.ranks, start, end)].pageKey);
}

/**
 * 境目を動かせる範囲の頁を左右に並べた帯。頁と頁の間は線だけにし、上の段に今の境目
 * （✂）、下の段に区切りの候補（▲）を置く。頁の段を横にスワイプすると帯が送られ、
 * 上の段で ✂ を左右にドラッグする（か、上の段を押す）と境目が動く（送る動きと動かす
 * 動きを段で分ける）。▲ を押すと、その候補へ動かす。✂ は矢印キーでも 1 頁ずつ動かせる。
 * 頁を押すと拡大して見る。開いたときは、今の境目が帯の真ん中に来るように送る
 * （renderSplit）。位置は、頁の幅（--edge-page）の何倍かで決める。
 */
function edgeStrip({ title, index, from, to }) {
  const { order, shown, breaks } = view;
  const first = from - 1;
  const at = (k) => `calc(var(--edge-page) * ${k - first})`;
  const scroll = el(document, 'div', 'bm-edge-strip');
  const inner = el(document, 'div', 'bm-edge-inner');
  const rail = el(document, 'div', 'bm-edge-rail');
  const marker = el(document, 'button', 'bm-cut-marker', '✂');
  marker.type = 'button';
  marker.style.left = at(index);
  marker.setAttribute('aria-label', `${title}（${displayLabel(order[index])}の前）`);
  marker.title = '左右にドラッグするか、矢印キーで、境目を動かせます';
  // 読み上げでは、矢印キーで動かせるつまみ（スライダー）として伝える。
  marker.setAttribute('role', 'slider');
  marker.setAttribute('aria-valuemin', String(from));
  marker.setAttribute('aria-valuemax', String(to));
  marker.setAttribute('aria-valuenow', String(index));
  marker.setAttribute('aria-valuetext', `${displayLabel(order[index])}の前`);
  const move = (to) => moveCut(index, to, title);
  marker.addEventListener('pointerdown', (event) => dragCut(event, { scroll, inner, marker, index, from, to, at, move }));
  marker.addEventListener('keydown', (event) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!step || index + step < from || index + step > to) return;
    event.preventDefault();
    move(index + step);
  });
  // 上の段のほかのところを押すと、いちばん近い頁と頁の間へ動かす。
  rail.addEventListener('click', (event) => {
    if (event.target !== rail) return;
    const target = boundaryAt(inner, from, to, event.clientX);
    if (target !== index) move(target);
  });
  rail.append(marker);
  const pages = el(document, 'div', 'bm-edge-pages');
  const hints = el(document, 'div', 'bm-edge-hints');
  for (let k = first; k <= to; k++) {
    const page = el(document, 'div', `bm-edge-page${k === index ? ' cut' : ''}`);
    page.dataset.at = String(k);
    page.append(thumbButton(order[k]), el(document, 'span', null, displayLabel(order[k])));
    pages.append(page);
    // 候補の ▲ は、今の境目と重なっていても出す（今の境目なら、押しても何もしない）。
    if (k >= from && shown[k]) {
      const reason = breakReason(breaks[k]);
      // 今の境目の ▲ は、押せない印にする（押しても動かないので、ボタンにしない）。
      const hint =
        k === index
          ? el(document, 'span', 'bm-hint on', '▲')
          : smallButton('▲', `${title}を${displayLabel(order[k])}の前（${reason}）へ動かす`, () => move(k), 'bm-hint');
      hint.dataset.at = String(k);
      // 節などの見出し（読み違いもしやすい）は、薄い ▲ にする。
      if (shown[k] >= RANKS.section) hint.classList.add('weak');
      hint.style.left = at(k);
      hint.title = reason;
      hints.append(hint);
    }
  }
  inner.append(rail, pages, hints);
  scroll.append(inner);
  return scroll;
}

/** 帯の中の x（画面の位置）にいちばん近い頁と頁の間（並びの位置。from〜to に収める）。 */
function boundaryAt(inner, from, to, x) {
  const box = inner.getBoundingClientRect();
  const width = box.width / (to - from + 2);
  return Math.min(to, Math.max(from, from - 1 + Math.round((x - box.left) / width)));
}

/** 境目をドラッグするとき、帯の端からこれだけの内側に指が来たら、帯を送る（px）。 */
const DRAG_EDGE = 40;
/** そのとき、DRAG_TICK ミリ秒ごとに送る幅（px）。指を止めていても送り続ける。 */
const DRAG_STEP = 12;
const DRAG_TICK = 30;

/**
 * 今の境目（✂）を左右にドラッグして動かす。✂ は指（ポインタ）にいちばん近い頁と頁の
 * 間へ付いていき、離したところへ境目を動かす。帯の端に指があれば、帯を送り続ける。
 * ドラッグの間は一覧を描き直さない（renderSplit）。
 */
function dragCut(event, { scroll, inner, marker, index, from, to, at, move }) {
  event.preventDefault();
  // 押した ✂ にキーボードの位置を置く（preventDefault で、押しただけでは移らないので）。
  marker.focus();
  marker.setPointerCapture(event.pointerId);
  dragging = true;
  let target = index;
  let x = event.clientX;
  const pages = [...inner.querySelectorAll('.bm-edge-page')];
  // ✂ と、境目の太い線を、動かす先へ付いていかせる。
  const hints = [...inner.querySelectorAll('.bm-hint')];
  const show = (position) => {
    marker.style.left = at(position);
    for (const page of pages) page.classList.toggle('cut', Number(page.dataset.at) === position);
    for (const hint of hints) hint.classList.toggle('on', Number(hint.dataset.at) === position);
  };
  const follow = () => {
    target = boundaryAt(inner, from, to, x);
    show(target);
  };
  const timer = setInterval(() => {
    const box = scroll.getBoundingClientRect();
    if (x < box.left + DRAG_EDGE) scroll.scrollLeft -= DRAG_STEP;
    else if (x > box.right - DRAG_EDGE) scroll.scrollLeft += DRAG_STEP;
    else return;
    follow();
  }, DRAG_TICK);
  const moved = (next) => {
    x = next.clientX;
    follow();
  };
  const stop = (drop) => {
    clearInterval(timer);
    marker.removeEventListener('pointermove', moved);
    marker.removeEventListener('pointerup', finish);
    marker.removeEventListener('pointercancel', cancel);
    marker.removeEventListener('lostpointercapture', cancel);
    dragging = false;
    if (drop && target !== index) {
      move(target);
    } else {
      // 動かさなければ ✂ と線を元へ戻し、ドラッグの間に止めていた描き直しをする。
      show(index);
      renderSplit();
    }
  };
  const finish = () => stop(true);
  const cancel = () => stop(false);
  marker.addEventListener('pointermove', moved);
  marker.addEventListener('pointerup', finish);
  marker.addEventListener('pointercancel', cancel);
  marker.addEventListener('lostpointercapture', cancel);
}

/**
 * 選んだファイルの始まりと終わり（の境目）。index は境目の位置（その頁の前で分ける）、
 * low・high は動かせる範囲（前後のファイルが空にならない範囲）。本の最初・最後なら
 * index は null。
 */
function fileEdges(spans, k) {
  const { start, end } = spans[k];
  return [
    { title: '始まり', side: '前', index: k > 0 ? start : null, low: spans[k - 1]?.start + 1, high: end - 1 },
    { title: '終わり', side: '次', index: k < spans.length - 1 ? end : null, low: start + 1, high: spans[k + 1]?.end - 1 },
  ].map((edge) =>
    edge.index === null
      ? edge
      : {
          ...edge,
    // 帯に並べるのは、今の境目の前後 STRIP_REACH 頁まで（長いファイルの頁をすべて
    // 並べない。端まで動かせば、帯はそこを中心に描き直すので、続けて遠くまで動かせる）。
          from: Math.max(edge.low, edge.index - STRIP_REACH),
          to: Math.min(edge.high, edge.index + STRIP_REACH),
        }
  );
}

/** 境目を動かす帯に並べる、今の境目の前後の頁の数。 */
const STRIP_REACH = 20;

/** 境目を動かす欄。その境目で分ける訳と、境目を動かす頁の帯、前後のファイルとまとめるボタン。 */
function edgeRow(edge) {
  const { title, side, index } = edge;
  const { order } = view;
  const row = el(document, 'div', 'bm-edge');
  row.dataset.edge = title;
  const head = el(document, 'div', 'bm-edge-head');
  head.append(
    el(document, 'strong', null, title),
    el(document, 'span', 'bm-edge-reason', `${displayLabel(order[index])}の前で分ける（${seamReason(index)}）`)
  );
  const tools = el(document, 'div', 'bm-edge-tools');
  tools.append(
    // まとめても、選んだ頁はまとめたファイルの中に残るので、そのファイルを選んだまま。
    smallButton(`${side}のファイルとまとめる`, `この境目で分けるのをやめて、${side}のファイルとまとめる`, () =>
      toggleSplit(order[index].pageKey)
    )
  );
  row.append(head, edgeStrip(edge), tools);
  return row;
}

/** 選んだファイルの上（始まり）か下（終わり）に出す、境目を動かす欄。 */
function edgeEntry(edge, place) {
  const { order, shown, breaks } = view;
  const { index, from, to } = edge;
  // 欄の帯の頁と、そこに出す区切りの候補（▲ とその訳）。
  const near = order.slice(from - 1, to + 1).map((entry, k) => {
    const at = from - 1 + k;
    return [displayLabel(entry), pageOf(entry).thumbUrl, shown[at] ? [shown[at], breakReason(breaks[at])] : null];
  });
  const sig = JSON.stringify([edge, seamReason(index), near]);
  const build = () => {
    const item = el(document, 'li', `bm-part-editor ${place}`);
    item.id = place === 'before' ? 'partEditorStart' : 'partEditorEnd';
    // 描いたあとに、帯を今の境目まで送る（renderSplit）。
    item.dataset.fresh = 'true';
    item.append(edgeRow(edge));
    return item;
  };
  return { key: `edge-${place}:${order[index].pageKey}`, sig, build };
}

/** 選んだファイルの下に出す、2 つに分けるボタン。 */
function splitEntry(start, end) {
  const build = () => {
    const item = el(document, 'li', 'bm-part-tools');
    item.append(
      smallButton('このファイルを 2 つに分ける', 'このファイルの中の区切りの候補（無ければ真ん中）で 2 つに分ける', () => splitPart(start, end))
    );
    return item;
  };
  return { key: `split:${view.order[start].pageKey}`, sig: `${start}-${end}`, build };
}

/** 一覧の、分けたファイル（1 ファイルにまとめるときは、そのファイル）の行。押すと選ぶ。 */
function partEntry({ start, end, k, count, name, limited, controls }) {
  // controls は、選んだファイルなら、上下に出した帯の id（帯が無ければ ''）。
  const selected = controls !== null;
  const { order, breaks, labels } = view;
  const pages = end - start;
  const bytes = order.slice(start, end).reduce((sum, entry) => sum + pageOf(entry).bytes, 0);
  const over = overLimit(pages, bytes, splitLimits);
  const range = `${displayLabel(order[start])}〜${displayLabel(order[end - 1])}`;
  const reason = breaks[start] ? `・${breakReason(breaks[start])}から` : '';
  const text = `${partFileName(name, k, count, labels[k])}: ${range}（${pages} 頁・約 ${megabytes(bytes)}${reason}）`;
  const thumbUrl = pageOf(order[start]).thumbUrl;
  const sig = JSON.stringify([start, text, over, thumbUrl, limited ? limitRatio(pages, bytes) : null, selected]);
  const build = () => {
    const item = el(document, 'li', `bm-part${over ? ' warn' : ''}${selected ? ' selected' : ''}`);
    // 行の全体がボタン。押すと、そのファイルの始まりと終わりを動かす欄を開く・閉じる。
    const button = el(document, 'button', 'bm-part-select');
    button.type = 'button';
    button.setAttribute('aria-expanded', String(selected));
    if (controls) button.setAttribute('aria-controls', controls);
    button.title = selected ? '閉じる' : 'このファイルの始まりと終わりを動かす';
    // 最初の頁の縮小画像（どこから始まるファイルか、絵で分かるように）。
    const thumb = el(document, 'img', 'bm-part-thumb');
    thumb.src = thumbUrl;
    thumb.alt = '';
    thumb.loading = 'lazy';
    button.append(thumb, el(document, 'span', 'bm-part-name', text));
    if (over) button.append(el(document, 'span', 'hint', '上限を超えています'));
    if (limited) button.append(limitBar(pages, bytes));
    button.addEventListener('click', () => selectPart(start, selected));
    item.append(button);
    return item;
  };
  return { key: `part:${order[start].pageKey}`, sig, build };
}

/** 上限に対する大きさの割合（大きさ・頁数のうち、上限に近い方）。 */
function limitRatio(pages, bytes) {
  const { megabytes: mb, pages: most } = splitLimits;
  return Math.max(mb ? bytes / (mb * MEGABYTE) : 0, most ? pages / most : 0);
}

/** 上限に対する大きさの棒。 */
function limitBar(pages, bytes) {
  const ratio = limitRatio(pages, bytes);
  const bar = el(document, 'span', 'bm-part-bar');
  bar.title = `上限の ${Math.round(ratio * 100)}%`;
  const fill = el(document, 'span');
  fill.style.width = `${Math.min(100, Math.round(ratio * 100))}%`;
  bar.append(fill);
  return bar;
}

/** 拡大表示の、その頁から分けるかどうか（と、前後の区切りへの移り先）。 */
function renderPreviewSplit() {
  const at = view.order.findIndex((entry) => entry.pageKey === previewKey);
  const seams = seamIndexes();
  $('previewPrevSeamBtn').disabled = !seams.some((index) => index < at);
  $('previewNextSeamBtn').disabled = !seams.some((index) => index > at);
  $('previewSplit').hidden = at <= 0;
  if (at <= 0) return;
  const part = view.starts.indexOf(at);
  const candidate = view.breaks[at];
  $('previewSplitText').textContent =
    part >= 0
      ? `この頁から ${part + 2} つ目のファイル（${seamReason(at)}）`
      : candidate
        ? `区切りの候補: ${breakReason(candidate)}（分けていません）`
        : 'この頁の前では分けません';
  $('previewSplitBtn').textContent = part >= 0 ? '分けない' : 'ここから分ける';
}

/** 前・次の区切り（の候補）の頁を拡大して見る。 */
function stepSeam(delta) {
  const at = view.order.findIndex((entry) => entry.pageKey === previewKey);
  const seams = seamIndexes();
  const target = delta > 0 ? seams.find((index) => index > at) : seams.findLast((index) => index < at);
  // 移り先が無いときは、ボタンを押せない（renderPreviewSplit）。
  openPreview(view.order[target].pageKey);
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
  renderPreviewSplit();
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
    const url = await renderPreview(await pdfOf(file), entry.pageIndex, {
      softMasks: file.pages[entry.pageIndex].softMasks,
    });
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
  // この結合で保存領域に書いたもの（うまくいかなければ消す）。
  const written = [];
  let done = false;
  try {
    const fileName = outputName();
    const ranges = pageLabelRanges(order);
    // 分けたファイルごとに、並び・名前・頁ラベル（本の頁番号のまま）を切り出す。
    const spans = splitRanges(order.length, view.starts);
    const parts = spans.map(({ start, end }, k) => ({
      start,
      order: order.slice(start, end),
      fileName: partFileName(fileName, k, spans.length, view.labels[k]),
      labels: sliceLabelRanges(ranges, start, end),
    }));
    // 中身は、結合するときに 1 ファイルずつ読む（保存領域に置いたものは、そこから）。
    const sources = new Map(readyFiles().map((file) => [file.key, { name: file.name, load: () => bytesOf(file) }]));
    const infoFrom = order.find((entry) => entry.role === 'body')?.fileKey;
    const started = performance.now();
    const many = parts.length > 1;
    // 結合と検証で、バーの前半と後半を受け持つ。結合の道具を読み込む間も、
    // 始めたことが分かるように先に出す。
    mergeProgress.label = () => '結合しています';
    mergeProgress.stage(0, 0.5);
    mergeProgress.show('結合しています…', 0);
    log(
      `結合を始めます（${sources.size} ファイル・${order.length} 頁` +
        `${many ? `を ${parts.length} ファイルに分けて` : ''}、` +
        `${stashDescription(stash, '結合した PDF は')}、` +
        `${navigator.userAgent}）`
    );
    // 結合の道具（pdf-lib）は、結合するときになってから読み込む。
    const { mergePdfs, pageDigests, writeMergedPdfs } = await import('./merge.js');
    const options = {
      sources,
      parts: parts.map(({ order: partOrder, fileName: name, labels }) => ({
        order: partOrder,
        title: name.replace(/\.pdf$/i, ''),
        labels,
      })),
      infoFrom,
      onProgress: (done, total) => mergeProgress.show(`結合しています（${done} / ${total} 頁）`, done / total),
    };
    // 保存領域があれば、そこへ少しずつ書き出す（結合した PDF をメモリに持たない）。
    // 書けなければ（容量の上限など）、メモリの上で結合し直す。分けたときも、
    // 元のファイルは 1 度だけ読み、分けたファイルを同時に書き出す（merge.js）。
    // 何百にも分けたときは、PARTS_AT_ONCE ずつ書き出す。
    const stashRun = ++mergeCount;
    const results = [];
    for (let at = 0; at < parts.length; at += PARTS_AT_ONCE) {
      const group = { ...options, parts: options.parts.slice(at, at + PARTS_AT_ONCE) };
      const before = results.reduce((sum, output) => sum + output.digests.length, 0);
      group.onProgress = (done) => options.onProgress(before + done, order.length);
      let outputs = null;
      if (stash) {
        const names = group.parts.map((_, k) => (many ? `merged-${stashRun}-${at + k + 1}.pdf` : `merged-${stashRun}.pdf`));
        outputs = await mergeIntoStash(writeMergedPdfs, group, names);
        if (outputs) written.push(...names);
      }
      outputs ??= await mergePdfs(group);
      results.push(...outputs);
    }
    const size = results.reduce((sum, output) => sum + (output.size ?? output.bytes.length), 0);
    const where = results.every((output) => output.file)
      ? stash.kind === 'opfs'
        ? '保存領域に書き出し'
        : 'Blob に書き出し'
      : 'メモリの上で';
    log(`結合しました（${order.length} 頁、${megabytes(size)}、${where}、${seconds(started)}）`);

    if (stale()) {
      abandon();
      return;
    }
    const outputs = [];
    for (const [k, part] of parts.entries()) {
      const output = await verifyPart(part, results[k], k, parts.length, { originals, stale, pageDigests });
      if (!output) {
        abandon();
        return;
      }
      outputs.push(output);
    }
    log(`すべて結合して検証しました（${parts.length} ファイル、${seconds(started)}）`);
    merged = { parts: outputs };
    done = true;
    renderVerify();
    renderDownloads();
  } catch (error) {
    // 並びが変わっていれば（外したファイルの中身を読めなかったなど）、捨てたことにする。
    if (stale()) {
      abandon();
      return;
    }
    showMessage(error.message || String(error), 'red');
  } finally {
    // 書き終えたら前に結合したものを消し、うまくいかなければ書いたものを消す
    // （保存している最中のものを書き換えないように、前のものは書き終えてから消す）。
    const unused = done ? mergedNames : written;
    for (const name of unused) stash.remove(name);
    if (done) mergedNames = written;
    merging = false;
    keepLog(); // 処理を終えたので、残した記録を消す（調べている途中なら、そちらを残す）
    mergeProgress.show('');
    button.disabled = false;
    // 結合の途中に開いた拡大表示は縮小画像だけなので、大きく描き直す。
    if (previewKey) openPreview(previewKey);
  }
}

/**
 * 結合した PDF（分けたときは、分けたファイル 1 つ）を読み直し、元の頁と突き合わせる
 * （頁を描き直さないので軽い）。途中で並び・名前が変わったら、読むのをやめる。
 */
async function verifyPart(part, output, k, count, { originals, stale, pageDigests }) {
  const many = count > 1;
  // 記録・進み具合に出す名前（分けたときは、分けたファイルの名前）。
  const name = many ? `「${part.fileName}」` : '結合した PDF ';
  const total = part.order.length;
  const { digests, size = output.bytes.length } = output;
  // 分けたファイルごとに、バーの後半を等分する。
  const counter = many ? `（${k + 1} / ${count} ファイル）` : '';
  mergeProgress.label = () => `検証しています${counter}`;
  mergeProgress.stage(0.5 + k / count / 2, 0.5 + (k + 1) / count / 2);
  mergeProgress.show(`${name}を検証しています…`, null);
  // 保存領域に置いたものは、読んだ中身を pdf.js へそのまま渡す（写しを作らない）。
  // メモリの上のものは、保存するために手元に残す。
  const bytes = output.bytes ?? new Uint8Array(await output.file.arrayBuffer());
  log(`検証: ${name}を読みました`);
  // ZIP にまとめるときの CRC は、中身を読んだ今のうちに求めておく（pdf.js へ渡すと読めなくなる）。
  const crc = many ? await checksum(bytes) : null;
  const mergedDigests = await pageDigests(bytes);
  log('検証: 頁の指紋を求めました');
  const doc = await openPdf(bytes, { transfer: !output.bytes });
  // 結合と検証はいちばんメモリを使うので、新しい書体を持ち込んだ頁を読むたびに
  // 書体を手放す（1 頁のファイルを何百もつないだ PDF は頁ごとに別の書体を持つので、
  // iPhone では検証の途中でページごと落ちた）。
  keepFewFonts(doc);
  log('検証: pdf.js で開きました');
  const actual = [];
  let labels;
  let info;
  let read = false;
  try {
    for (let index = 0; index < doc.numPages; index++) {
      if (stale()) break;
      mergeProgress.show(`${name}を検証しています（${index + 1} / ${doc.numPages} 頁）`, index / doc.numPages);
      const page = await withContext(`${name}の ${index + 1} 頁目を検証できませんでした`, () =>
        readPageText(doc, index)
      );
      actual.push({ size: page.size, signature: page.signature, digest: mergedDigests[index] });
      if (index % 16 === 0) await breathe();
    }
    // 最後の頁の書体の手放しを終えてから、頁ラベル・文書の情報を読む（重ねない）。
    await fontReleases(doc);
    if (!stale()) {
      labels = await doc.getPageLabels();
      ({ info } = await doc.getMetadata());
    }
    read = true;
  } finally {
    // 最後に始めた書体の手放しを、終えてから閉じる（失敗したときも。閉じるのと重ねない）。
    await fontReleases(doc);
    // 失敗しても閉じる（結合した PDF 全体を worker に残さない）。
    await closePdf(doc);
    // ほかに開いている文書が無ければ worker ごと止めて、写しをその場で返す
    // （保存で共有シートへ渡すときに、メモリを空けておく）。次の分けたファイルを
    // 検証するときは止めない（worker を起こし直す手間が、分けた数だけ掛かる）。
    const more = read && k < count - 1 && !stale();
    if (!more && releasePdfWorker()) log('検証: pdf.js の worker を止めて、結合した PDF の写しを手放しました');
  }
  if (stale()) return null;

  const expected = part.order.map((entry, i) => ({
    pageKey: entry.pageKey,
    label: displayLabel(entry),
    ...originals[part.start + i],
    digest: digests[i],
  }));
  const result = compareOutput(expected, actual);
  const wantLabels = pageLabelTexts(part.labels, total);
  // 頁ラベルを付けない（本文が無い・部が分かれている）ときは、付いていないこと。
  const labelsOk = part.labels.length
    ? Array.isArray(labels) && labels.every((label, i) => label === wantLabels[i])
    : labels === null;
  log(
    result.ok && labelsOk
      ? `${name}を検証しました（${result.pageCount.actual} 頁すべて一致）`
      : `${name}を検証して、食い違いが見つかりました（${result.mismatches.length} 頁${labelsOk ? '' : '、頁ラベルが違う'}）`
  );
  return {
    data: output.file ?? output.bytes,
    size,
    crc,
    fileName: part.fileName,
    result,
    labelsOk,
    noLabels: part.labels.length === 0,
    title: info.Title || '',
  };
}

/**
 * 結合した PDF（分けたときは、分けたファイルごと）を、保存領域へ少しずつ書き出す。
 * 書けなかったら null（メモリの上で結合し直す）。結合そのものの失敗（暗号化された
 * ファイルなど）はそのまま投げる。
 */
async function mergeIntoStash(writeMergedPdfs, options, names) {
  let failed = null;
  const guard = async (run) => {
    try {
      return await run();
    } catch (error) {
      failed = error;
      throw error;
    }
  };
  // 結合するたびに別の名前で書く（前に結合した PDF を、保存している最中に
  // 書き換えないように）。前のものは、すべて書き終えてから消す（mergeAndVerify）。
  const writers = [];
  try {
    for (const name of names) writers.push(await guard(() => stash.writer(name)));
    const results = await writeMergedPdfs({
      ...options,
      parts: options.parts.map((part, k) => ({ ...part, write: (chunk) => guard(() => writers[k].write(chunk)) })),
    });
    const outputs = [];
    for (const [k, writer] of writers.entries()) {
      outputs.push({ ...results[k], file: await guard(() => writer.close()) });
    }
    return outputs;
  } catch (error) {
    // 書きかけは閉じて消す（書き口を開いたままにすると、次の結合で開けない）。
    for (const writer of writers) await writer.close().catch(() => {});
    for (const name of names) await stash.remove(name);
    if (error !== failed) throw error;
    log(`結合した PDF を保存領域に書けなかったので、メモリの上で結合し直します（${error.message}）`);
    return null;
  }
}

/**
 * CRC-32（ZIP にまとめるときに要る）。数百 MB を一息に求めると画面が固まるので、
 * 少しずつ求めて、間に一息つく。
 */
async function checksum(bytes) {
  let crc = 0;
  for (let at = 0; at < bytes.length; at += CRC_CHUNK) {
    crc = crc32(bytes.subarray(at, at + CRC_CHUNK), crc);
    await breathe();
  }
  return crc;
}

function renderVerify() {
  const box = $('verifyResult');
  const { parts } = merged;
  const many = parts.length > 1;
  const ok = parts.every((part) => part.result.ok && part.labelsOk);
  const pages = parts.reduce((sum, part) => sum + part.result.pageCount.actual, 0);
  const mismatches = parts.flatMap((part) => part.result.mismatches.map((mismatch) => ({ ...mismatch, part })));
  box.className = `bm-verify ${ok ? 'ok' : 'ng'}`;
  const lines = [];
  lines.push(
    ok
      ? `検証できました。${many ? `${parts.length} ファイル・計 ` : ''}${pages} 頁すべてが、元の頁と大きさ・文字情報・画像まで一致しています。`
      : `検証で食い違いが見つかりました（${mismatches.length} 頁）。`
  );
  for (const part of parts) {
    const { result, labelsOk, noLabels, size, title } = part;
    const head = many ? `${part.fileName}: ${result.pageCount.actual} 頁。` : '';
    if (result.pageCount.expected !== result.pageCount.actual) {
      lines.push(
        `${many ? `${part.fileName}: ` : ''}頁の数が違います（並べた数 ${result.pageCount.expected}、結合した PDF ${result.pageCount.actual}）。`
      );
    }
    lines.push(
      `${head}文字情報（検索できる文字）のある頁: ${result.textPages} / ${result.pageCount.actual} 頁。` +
        `頁ラベル（ビューアーに出る頁番号）: ${
          !labelsOk ? '書き込みを確かめられませんでした' : noLabels ? '付けていません（通し番号）' : '本の頁番号と一致'
        }。` +
        `タイトル: ${title || '（なし）'}。大きさ: ${megabytes(size)}。`
    );
  }
  // 分ける位置は大きさの見積もりで決めたので、結合した大きさが上限を超えたら知らせる
  // （分けたファイルどうしで共有していた書体などは、どのファイルにも入る）。
  for (const part of parts) {
    if (overLimit(part.result.pageCount.actual, part.size, splitLimits)) {
      lines.push(
        `${part.fileName} は ${part.result.pageCount.actual} 頁・${megabytes(part.size)} で、上限を超えました。` +
          '頁の一覧の「ここから分ける」で分ける位置を足して、結合し直してください。'
      );
    }
  }
  box.replaceChildren(...lines.map((line) => el(document, 'p', null, line)));
  if (mismatches.length) {
    const list = el(document, 'ul', 'bm-mismatches');
    for (const mismatch of mismatches.slice(0, 50)) {
      const where = many ? `${mismatch.part.fileName} の ` : '';
      const item = el(document, 'li', null, `${where}${mismatch.index + 1} 枚目（${mismatch.label}）: ${mismatch.reasons.join('・')}`);
      list.append(item);
    }
    if (mismatches.length > 50) list.append(el(document, 'li', null, `ほか ${mismatches.length - 50} 頁`));
    box.append(list);
  }
  box.hidden = false;
}

/**
 * 保存のボタン。1 ファイルなら「ダウンロード」、分けたときは「ZIP にまとめて
 * ダウンロード」と、分けたファイルごとの「ダウンロード」。
 */
function renderDownloads() {
  const parts = merged?.parts ?? [];
  const many = parts.length > 1;
  $('downloadBtn').hidden = many;
  $('downloadBtn').disabled = !merged;
  $('zipBtn').hidden = !many;
  $('partDownloads').hidden = !many;
  $('partDownloads').replaceChildren(
    ...(many
      ? parts.map((part, k) => {
          const item = el(document, 'li', 'bm-part');
          item.append(
            el(document, 'span', null, `${part.fileName}（${part.result.pageCount.actual} 頁・${megabytes(part.size)}）`),
            smallButton('ダウンロード', `「${part.fileName}」をダウンロード`, () => download(k))
          );
          return item;
        })
      : [])
  );
}

/** 結合した PDF（分けたときは k 番目のファイル）を保存する。 */
async function download(k = 0) {
  // ボタンは、結合した PDF があるときだけ押せる（捨てたら押せなくする。renderDownloads）。
  // 共有シートを開いている間に、名前を変えるなどして結合した PDF が捨てられる
  // ことがあるので、渡すものは先に取っておく。
  const { data, fileName, size } = merged.parts[k];
  await save(data, fileName, size, PDF_MIME);
}

/** 分けたファイルを ZIP にまとめて保存する（中身は読まずに、Blob の部品にする）。 */
async function downloadZip() {
  const { parts } = merged;
  const fileName = outputName().replace(/\.pdf$/i, '.zip');
  let blob;
  try {
    blob = zipBlob(parts.map((part) => ({ name: part.fileName, data: part.data, size: part.size, crc: part.crc })));
  } catch (error) {
    showMessage(error.message, 'red');
    return;
  }
  await save(blob, fileName, blob.size, ZIP_MIME);
}

async function save(data, fileName, size, type) {
  saving = true;
  log(`「${fileName}」を保存します（${megabytes(size)}）`);
  // 大きくて共有シートに渡せないとき（save-file.js）は、そう記録しておく。
  const method = saveMethod(size, navigator);
  if (isMobile(navigator) && method === 'download') {
    log('大きいので、共有シートではなく、ダウンロード（既定のダウンロードフォルダ）に保存します');
  }
  const how = await savePdf(data, fileName, navigator, method, type).finally(() => {
    saving = false;
    keepLog();
  });
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
  addFiles(
    picked
      .slice()
      .sort(byName)
      .map((file) => ({
        name: file.name,
        driveId: file.id,
        modified: file.modifiedTime ? Date.parse(file.modifiedTime) : null,
        load: (onProgress, onWait, reserve) => downloadDriveFile(file, { onProgress, onWait, reserve }),
      }))
  );
}

function addLocal(fileList) {
  const pdfs = [...fileList].filter((file) => file.type === PDF_MIME || /\.pdf$/i.test(file.name));
  if (pdfs.length < fileList.length) showMessage('PDF 以外のファイルは外しました。', 'red');
  else showMessage('');
  addFiles(
    pdfs.sort(byName).map((file) => ({
      name: file.name,
      modified: file.lastModified,
      load: async (onProgress, onWait, reserve) => {
        await reserve(file.size);
        const bytes = new Uint8Array(await file.arrayBuffer());
        onProgress(bytes.length, bytes.length);
        return bytes;
      },
    }))
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
  // 前回、途中でページが落ちていたら、その記録を出す。
  crashLog.clearOnLeave();
  crashLog.takePrevious().then((previous) => {
    if (!previous.length) return;
    logLines.unshift('── 前回、途中でページが終わる前の記録 ──', ...previous, '── ここから今回の記録 ──');
    $('logBox').hidden = false;
    renderLog();
    showMessage(
      '前回は処理の途中でページが終わったようです。下の「処理の記録」を開いて「ログをコピー」し、知らせてください。',
      'red'
    );
  });
  if (!pdfLibViews) {
    // ファイルを読む前に知らせる（読み込んだ時点で、写しはもう作られる）。
    log('pdf-lib にバイト列を写させない設定が効いていません。大きな本ではメモリが足りなくなることがあります');
  }
  stashReady = openStash().then(
    (target) => (stash = target),
    (error) => {
      // 保存領域を使えなければ、Blob にしてページの外に置く（stash.js）。
      stashProblem = error.message;
      stash = blobStash();
      return stash;
    }
  );
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

  $('fileSort').addEventListener('change', (event) => setFileSort(event.target.value));
  // ファイルの行のメニューは、外を押すか Esc で閉じる。
  const closeMenus = (except) => {
    for (const menu of document.querySelectorAll('.bm-file-menu[open]')) {
      if (menu === except) continue;
      menu.open = false;
      menu.forget();
    }
  };
  // iPhone・iPad の Safari は、押せない要素を押しても document に click を送らないので、
  // 押し始め（pointerdown）で受ける。
  // 押した・キーを受けた要素を含むメニュー（document そのものに届いたときは無し）。
  const menuOf = (target) => (target instanceof Element ? target.closest('.bm-file-menu') : null);
  document.addEventListener('pointerdown', (event) => closeMenus(menuOf(event.target)));
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    // メニューの中にいたら、閉じたあとはつまみ（…）に戻る（隠れたボタンに残さない）。
    const inside = menuOf(event.target);
    closeMenus(null);
    inside?.querySelector('summary').focus();
  });
  for (const [value, text] of Object.entries(ROLES)) {
    const option = el(document, 'option', null, `すべて${text}`);
    option.value = value;
    $('bulkRole').append(option);
  }
  $('bulkRole').addEventListener('change', (event) => {
    if (event.target.value) setAllRoles(event.target.value);
  });
  $('outputName').addEventListener('input', () => {
    $('outputName').dataset.suggested = 'false';
    discardMerged();
    renderSplit();
    // 入力した名前を覚えておく（このあと裏の処理で並べ直しても、捨て直さない）。
    orderKey = mergeKey();
  });
  $('mergeBtn').addEventListener('click', mergeAndVerify);
  $('downloadBtn').addEventListener('click', () => download());
  $('zipBtn').addEventListener('click', downloadZip);
  loadLimits();
  $('splitMegabytes').addEventListener('change', (event) => setLimit('megabytes', event.target));
  $('splitPages').addEventListener('change', (event) => setLimit('pages', event.target));
  $('splitAutoBtn').addEventListener('click', autoSplits);
  $('logCopyBtn').addEventListener('click', copyLog);
  $('logBox').addEventListener('toggle', renderLog);

  $('previewPrevBtn').addEventListener('click', () => stepPreview(-1));
  $('previewNextBtn').addEventListener('click', () => stepPreview(1));
  $('previewPrevSeamBtn').addEventListener('click', () => stepSeam(-1));
  $('previewNextSeamBtn').addEventListener('click', () => stepSeam(1));
  $('previewSplitBtn').addEventListener('click', () => toggleSplit(previewKey));
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
