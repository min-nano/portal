// PDF を読む（pdf.js）。頁の文字情報と、手元のファイルの頁の画像。
//
// 頁の文字情報（readPageText）は画像を展開しないので軽い。読み込むファイルの
// すべてで、ここで読む。
//
// 頁の画像（測定用・一覧用・OCR 用）は重い。スキャンの頁は数百万画素の JPEG で、
// 展開に時間がかかる（とくに iPhone・iPad）。頁が「JPEG 画像 1 枚」の形なら、
// JPEG をブラウザ自身に展開させて描く（scan-images.js）。そうでない頁と、
// そちらで描けなかった頁は pdf.js で描く。

// 通常のビルドは最新のブラウザ向けで、まだ多くのブラウザに無い機能
// （Map.prototype.getOrInsertComputed など）を前提にしている。社内の端末は
// ブラウザの種類も版もまちまちなので、補ってある legacy のビルドを使う。
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { toGray } from './image-checks.js';
import { MARGIN_ZONE } from './page-numbers.js';
import { isIOS, isWebKit } from './device.js';
import { BundledDataFactory } from '../pdf-data.js';
import { drawScan } from './scan-images.js';
import { multiply, textItems, textSignature } from './text-layer.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

/** 測定に使う画像の長辺（px）。傾き 0.1° を見分けられる大きさ。 */
export const ANALYSIS_LONG_SIDE = 1000;
/** 一覧に並べる縮小画像の幅（px）。 */
export const THUMB_WIDTH = 160;
/** 余白を OCR するときの、頁の高さ（px）。頁番号の数字が 20px ほどになる。 */
export const OCR_PAGE_HEIGHT = 2400;
/** 拡大表示の長辺（px）。 */
export const PREVIEW_LONG_SIDE = 1600;
/**
 * ソフトマスクを使う回数（scan-images.js の softMaskCount）がこれより多い頁は
 * 「ソフトマスクの多い頁」として、粗く描き、余白を OCR しない（manySoftMasks）。
 * スキャナの作る PDF では 0 か数回で、InDesign の影・ぼかしのある頁では
 * 数百〜千回を超える。
 */
export const MANY_SOFT_MASKS = 8;
/**
 * ソフトマスクの多い頁を描くときの、描く画素の数 × ソフトマスクを使う回数の
 * 上限（cappedScale）。pdf.js はソフトマスクを使うたびに描く canvas と同じ
 * 大きさの作業をするので、描く手間はおよそこの積に比例する。1,032 回使う頁
 * （InDesign の表紙）は 7.7 万画素（A4 で長辺 330px ほど）になり、iPhone mini で
 * 1.7 秒で描けた。
 */
export const SOFT_MASK_WORK = 80e6;
/** 拡大表示では、SOFT_MASK_WORK の何倍まで描くか（一覧より大きく見せる。粗くてよいので、待たせない方を取る）。 */
const PREVIEW_SOFT_MASK_WORK = 2;
/**
 * iPhone・iPad で、ソフトマスクの多い頁を描くときに、pdf.js が同時に持つ
 * canvas の画素の目安の上限（4,800 万画素 ≒ 190 MB）。bandRows を参照。
 */
export const IOS_SOFT_MASK_PIXELS = 48e6;
/** 帯に分けて描くときの、帯の高さの下限（px。細かく分けすぎると、帯ごとの手間が積み重なる）。 */
const MIN_BAND_ROWS = 16;

/**
 * どの文書も、1 つの worker で開く。
 *
 * pdf.js は、worker を渡さないと文書ごとに worker を作り、閉じたら止める。
 * 1 頁のファイルを何百も読むと、そのたびに worker を起こして pdf.js の本体
 * （数 MB）を読み直すことになる（200 ファイルで、調べる時間の半分ほどが
 * これだった）。同じ worker を使い回し、文書を閉じたときは、その文書の
 * 中身だけを手放す。
 */
let sharedWorker = null;
/** 開いている（開きかけを含む）文書の数。0 のときだけ worker を止められる。 */
let activeDocs = 0;

function workerOf() {
  sharedWorker ??= new pdfjs.PDFWorker();
  return sharedWorker;
}

/**
 * 開いている文書が無ければ、worker を止める（次に開くときに作り直す）。
 *
 * 文書を閉じても、worker が持っていた中身（渡したファイルの写し）は、worker の
 * 中で片付けられるまでメモリに残る。結合した PDF（数百 MB）を検証したあとに
 * これが残ったまま共有シートへ渡すと、iPhone では保存のところでページごと
 * 落ちた（共有シートへ渡すときも、Safari はファイルの中身をページのメモリに
 * 読む）。worker ごと止めれば、その場で返る。
 *
 * @returns {boolean} 止めたか
 */
export function releasePdfWorker() {
  if (activeDocs > 0 || !sharedWorker) return false;
  sharedWorker.destroy();
  sharedWorker = null;
  return true;
}

/**
 * PDF を開く。
 *
 * pdf.js は受け取ったバイト列を worker へ渡して手放してしまうので、
 * 結合に使う元のバイト列は渡さず、複製を渡す。transfer なら、写さずにそのまま
 * 渡す（手元では使えなくなる。結合した PDF を検証するときや、保存領域から
 * 読んだときに、本 1 冊ぶんの写しを作らないため）。reload は、WebKit で描き
 * 直しのために開き直すときに中身を読み直す関数（transfer のときに渡す）。
 *
 * @param {Uint8Array} bytes
 */
export async function openPdf(bytes, { safe = false, transfer = false, reload = null } = {}) {
  const webkit = isWebKit(globalThis.navigator);
  // iPhone・iPad では、はじめから OffscreenCanvas を切る。worker の中で
  // 600dpi のスキャン（3000 万画素ほど）を OffscreenCanvas に描くと、canvas の
  // 大きさの上限（1600 万画素ほど）を超えて「invalid state」になり、描き直す
  // 間にメモリが尽きてページごと落ちた。
  safe ||= isIOS(globalThis.navigator);
  activeDocs++;
  const loading = pdfjs.getDocument({
    data: transfer ? bytes : bytes.slice(),
    worker: workerOf(),
    isEvalSupported: false,
    // CMap・標準フォント・画像の展開の wasm（../pdf-data.js）。渡さないと、ToUnicode を
    // 持たない日本語のフォント（カタログの PDF によくある）の文字が消える。
    BinaryDataFactory: BundledDataFactory,
    // Safari（と、中身が同じ WebKit の iPhone・iPad のブラウザ）では、worker の
    // 中で画像を ImageDecoder で展開すると「The object is in an invalid
    // state.」で失敗することがある（スキャンの JPEG で起きた）。ImageDecoder は
    // 使わず、pdf.js 自身の展開に任せる。
    isImageDecoderSupported: !webkit,
    // OffscreenCanvas は使う。使わないと、pdf.js はスキャンの画像を画面の
    // スレッドで描くので、頁ごとに画面が固まる。ただし WebKit でこちらが失敗の
    // 元だったときに備え、描けなければ両方を切った文書（safe）で描き直す
    // （drawPage）。
    isOffscreenCanvasSupported: !(webkit && safe),
    // iPhone・iPad では、埋め込みのフォントをブラウザに渡さず（FontFace を作らず）、
    // pdf.js が字形を線として描く。1 頁のファイルを何百も調べると、ファイルごとに
    // 別のフォント（InDesign の書き出しなど）をブラウザに渡すことになり、文書を
    // 閉じてフォントを外しても、400 ファイルを超えるあたりで描くのが遅くなって
    // ページごと落ちた（Chromium では、ページと worker の JavaScript のメモリは
    // 増えなかったので、Safari がフォントを抱えていると見ている）。描いたものは
    // 変わらない（文字情報は別に読むので、こちらも変わらない）。
    disableFontFace: isIOS(globalThis.navigator),
  });
  let doc;
  try {
    doc = await loading.promise;
  } catch (error) {
    activeDocs--;
    throw error;
  }
  // 描き直しで開き直すときの中身（写さずに渡したときは、もう手元に無いので読み直す）。
  if (webkit && !safe) fallbacks.set(doc, { load: reload ?? (() => bytes), safe: null, failed: false });
  return doc;
}

/** WebKit で開いた文書 → 描けなかったときに開き直す、安全な設定の文書。 */
const fallbacks = new WeakMap();

/**
 * その文書を、描けなかったために安全な設定で開き直して描いたか（記録に出す。
 * 開き直すと PDF をもう 1 度読み、描き直すので、時間がかかる）。
 */
export function redrawnSafely(doc) {
  return fallbacks.get(doc)?.failed === true;
}

function safeDocOf(doc) {
  const fallback = fallbacks.get(doc);
  if (!fallback) return null;
  fallback.safe ??= Promise.resolve(fallback.load()).then((bytes) => openPdf(bytes, { safe: true }));
  return fallback.safe;
}

/**
 * canvas の画素を手放す。
 *
 * iPhone・iPad の Safari は、ページ全体で使える canvas のメモリに上限があり、
 * 使い終えた canvas も片付けられるまで数えられる。数百頁を順に描くと上限に
 * 届いて描けなくなるので、使い終えたら大きさを 0 にして、その場で返す。
 */
export function releaseCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

/** 開いた PDF を閉じる（worker の側に持っている中身も手放す）。 */
export async function closePdf(doc) {
  if (!doc) return;
  const safe = fallbacks.get(doc)?.safe;
  fallbacks.delete(doc);
  if (safe) await closePdf(await safe.catch(() => null));
  await doc.loadingTask.destroy();
  activeDocs--;
}

function canvasOf(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

/**
 * ソフトマスクの多い頁か（粗く描き、余白を OCR しない）。
 *
 * @param {number} [softMasks] 頁のソフトマスクの数（scan-images.js の findScanImages。
 *   PDF を調べられなかったときは無い）
 */
export function manySoftMasks(softMasks = 0) {
  return softMasks > MANY_SOFT_MASKS;
}

/**
 * 頁を長辺 longSide で描く scale。ソフトマスクの多い頁は、描く画素の数 ×
 * ソフトマスクの数が work に収まるまで小さくする。
 *
 * ソフトマスクを数百持つ頁（InDesign の影・ぼかし）を、ほかの頁と同じ細かさで
 * 描くと、Mac の Safari で十数秒、iPhone で 30 秒ほどかかった。粗く描いても、
 * 結合する PDF は頁をそのまま写すので変わらない。変わるのは一覧の縮小画像・
 * 拡大表示の細かさと、測る画像の細かさ（中身の範囲や傾きは割合で測る）だけ。
 *
 * @param {{width:number, height:number}} base 頁の大きさ（scale 1 の viewport）
 */
export function cappedScale(base, longSide, softMasks = 0, work = SOFT_MASK_WORK) {
  const scale = longSide / Math.max(base.width, base.height);
  if (!manySoftMasks(softMasks)) return scale;
  return Math.min(scale, Math.sqrt(work / softMasks / (base.width * base.height)));
}

/**
 * ソフトマスクの多い頁を、何行ずつの帯に分けて描くか（分けないなら Infinity）。
 *
 * pdf.js は、ソフトマスクのために作った canvas（使う 1 回につき 1 枚ほど、
 * 大きさは描く canvas に収まる分）を、頁を描き終えるまで手放さない。
 * 1,032 回使う頁を長辺 1000px で描くと、それだけで 1.4 GB（1,037 枚）になる。
 * Mac では描けるが、iPhone・iPad はメモリが尽きてページごと落ちた。そこで
 * iPhone・iPad では、頁を横長の帯に分けて描いてつなぐ（帯ごとに pdf.js が
 * 持つ canvas は帯の大きさに収まる）。帯ごとに頁の中身を描き直す手間が
 * 掛かるので（1,032 回使う頁で、帯 1 本につき 1 秒ほど）、Mac などでは
 * 分けない。
 *
 * @param {number} width 描く canvas の幅（px）
 * @param {number} softMasks 頁がソフトマスクを使う回数
 */
export function bandRows(width, softMasks) {
  if (!manySoftMasks(softMasks) || !isIOS(globalThis.navigator)) return Infinity;
  return Math.max(MIN_BAND_ROWS, Math.floor(IOS_SOFT_MASK_PIXELS / (width * softMasks)));
}

/** pdf.js で、viewport のとおりに描く。注釈（付箋・リンクの枠）は検査の邪魔なので描かない。 */
async function renderTo(page, viewport, size) {
  const canvas = canvasOf(size.width, size.height);
  try {
    await page.render({ canvas, viewport, annotationMode: pdfjs.AnnotationMode.DISABLE }).promise;
  } catch (error) {
    releaseCanvas(canvas);
    throw error;
  }
  return canvas;
}

/**
 * pdf.js で描く。rows が canvas の高さより小さければ、その行数ずつの帯に
 * 分けて描いてつなぐ（bandRows）。
 */
async function drawPage(doc, page, viewport, size = viewport, rows = Infinity) {
  // 書体を手放さないように「この文書を描いている」とするのは、呼ぶ側（drawInTurn）。
  try {
    return await drawBands(doc, page, viewport, size, rows);
  } finally {
    // 描いた頁の書体を数える（文字情報を読んだ頁なら、その書体の名前で。描けなかった
    // ときも、途中まで読み込んだ書体があるので数える）。
    noteFonts(doc, page.pageNumber - 1);
  }
}

async function drawBands(doc, page, viewport, size, rows) {
  const height = Math.max(1, Math.round(size.height));
  if (rows >= height) return drawWhole(doc, page, viewport, size);
  const canvas = canvasOf(size.width, height);
  const context = canvas.getContext('2d');
  try {
    for (let y = 0; y < height; y += rows) {
      const band = await drawWhole(doc, page, viewport.clone({ offsetY: viewport.offsetY - y }), {
        width: canvas.width,
        height: Math.min(rows, height - y),
      });
      context.drawImage(band, 0, y);
      releaseCanvas(band);
    }
  } catch (error) {
    releaseCanvas(canvas);
    throw error;
  }
  return canvas;
}

/**
 * pdf.js で描く。WebKit で描けなかったときは、OffscreenCanvas も切った文書で
 * 描き直し、その文書の残りの頁もそちらで描く。
 */
async function drawWhole(doc, page, viewport, size = viewport) {
  const fallback = fallbacks.get(doc);
  if (!fallback?.failed) {
    try {
      return await renderTo(page, viewport, size);
    } catch (error) {
      if (!fallback) throw error;
      fallback.failed = true;
    }
  }
  const safe = await safeDocOf(doc);
  const safePage = await safe.getPage(page.pageNumber);
  try {
    return await renderTo(safePage, viewport, size);
  } finally {
    safePage.cleanup();
  }
}

/** 変換行列の逆（画素 → 頁の座標を、頁の座標 → 画素に戻す）。 */
function inverse([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/**
 * 頁全体を描いた canvas（full の viewport）から、別の viewport の canvas へ
 * 写すときの変換。full の画素 → その viewport の画素。
 */
export function cropTransform(viewport, full) {
  return multiply(viewport.transform, inverse(full.transform));
}

// --- 書体を手放す --------------------------------------------------------------
//
// pdf.js は、読んだ頁・描いた頁の書体を、文書を閉じるまで抱える（doc.cleanup で
// 手放せる）。頁ごとに別の書体を持つ PDF（1 頁ずつ書き出した PDF をつないだもの。
// 施工ガイドブックの各ファイルなど）では、頁を読むたびにメモリが増え、iPhone では
// 47 MB・25 頁のファイルの文字情報を読む途中でページごと落ちた（Node で同じ作りの
// 40 MB・12 頁を読むと、1 頁ごとに 9 MB ほど増えた）。毎頁手放すと、全頁で同じ
// 書体を使う本では書体を読み直すので、文字情報を読むのが 6 倍ほど遅くなる。
//
// そこで文書ごとに、新しい書体を持ち込んだ頁（文字情報が使う書体の名前
// ——getTextContent の styles——に、手放してからまだ見ていない名前がある頁。手放した
// 書体は、次に読む・描くときに読み込み直すので、また新しく数える）を数え、手放して
// から NEW_FONT_PAGES を超えたら手放す。同じ書体を使い回す本では、新しい書体を持ち
// 込む頁はすぐに無くなるので、まず手放さない。頁の書体の名前は、文字情報を読んだ
// ときのものを使い続ける（pdf.js は手放すと名前を付け直すが、それに惑わされない）。文字情報を
// 読むとき（readPageText。結合した PDF の検証も）と、pdf.js で頁を描いたとき
// （drawPage。調べる・拡大表示・あとからの OCR のどれでも）に数える。文字情報を
// 読んでいない頁（拡大表示などのために開き直した文書）は、頁を書体 1 つとして数える。
//
// 読んでいる・描いている途中に手放すと読めなく・描けなくなるので、同じ文書の読み・
// 描きが済むのを待ってから手放し、手放している間は、同じ文書の読み・描きを待たせる
// （pdf.js で描く順番には並べない。並べると、ほかの文書を描く間に書体がまた溜まる。
// 描くときは、描く順番に並ぶ前から「描いている」とするので、手放し終えるのを順番の
// 先頭で待って、ほかの文書の描画を止めることはない）。描き直しのために開き直した
// 文書（safe）も手放す。手放すのはメモリのためだけなので、失敗しても読み・描きは
// 続ける（手放せた回数だけを数える）。文書を閉じるときは、手放し終えるのを待たない
// （閉じた文書を手放しても何も起きない。待つと、描くのに何十秒もかかる頁を描いて
// いる間、閉じられない）。

/** 新しい書体を持ち込んだ頁が、手放してからこれだけを超えたら手放す。 */
export const NEW_FONT_PAGES = 4;

/**
 * 文書 → 書体の数え。seen: 手放してから見た書体の名前、fresh: 手放してから新しい
 * 書体を持ち込んだ頁の数、limit: fresh がこれを超えたら手放す、pages: 頁ごとの書体、
 * busy: 読んでいる・描いている途中の約束、cleaning: 手放している最中なら、その約束、
 * releases: 手放せた回数。
 */
const budgets = new WeakMap();

function budgetOf(doc) {
  let budget = budgets.get(doc);
  if (!budget) {
    budget = {
      seen: new Set(),
      fresh: 0,
      limit: NEW_FONT_PAGES,
      pages: new Map(),
      busy: new Set(),
      cleaning: null,
      releases: 0,
    };
    budgets.set(doc, budget);
  }
  return budget;
}

/**
 * 文書を読む・描く（手放している最中なら待ってから。途中は手放さない）。
 *
 * @template T
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
async function usingDoc(doc, run) {
  const budget = budgetOf(doc);
  await fontsSettled(doc);
  const running = run();
  const done = running.catch(() => {});
  budget.busy.add(done);
  try {
    return await running;
  } finally {
    budget.busy.delete(done);
  }
}

/**
 * 頁が使った書体を数え、新しい書体を持ち込んだ頁が多くなったら手放す（待たない）。
 * 文字情報を読んでいない頁（拡大表示などのために開き直した文書）は、書体の名前が
 * 分からないので、その頁を書体 1 つとして数える（文字の無い頁は、文字情報を読んで
 * いれば書体 0 として数えない。文字の無いスキャンを pdf.js で描くたびに手放さない
 * ように）。
 */
function noteFonts(doc, index) {
  const budget = budgetOf(doc);
  const names = budget.pages.get(index) ?? [`page:${index}`];
  const fresh = names.filter((name) => !budget.seen.has(name));
  for (const name of fresh) budget.seen.add(name);
  if (fresh.length) budget.fresh++;
  if (budget.fresh <= budget.limit || budget.cleaning) return;
  budget.cleaning = (async () => {
    // すぐに済んでも、cleaning を入れてから片付けるように、いったん待つ。
    await null;
    while (budget.busy.size) await Promise.all(budget.busy);
    // 元の文書と、描き直しのための文書を、それぞれ手放す（片方で失敗しても、もう
    // 片方は手放す。描き直しの文書を開けなかったときは、手放すものが無い）。
    const done = await Promise.all([
      cleanupOf(doc),
      Promise.resolve(fallbacks.get(doc)?.safe)
        .catch(() => null)
        .then((safe) => (safe ? cleanupOf(safe) : true)),
    ]);
    if (done.every(Boolean)) budget.releases++;
    // 数え直しは、手放し終えてから（それまでに読み・描きした頁の書体も手放したので）。
    budget.fresh = 0;
    budget.seen.clear();
    budget.cleaning = null;
  })();
}

/** 文書の書体を手放す。手放せたか（失敗しても、読み・描きは続ける）。 */
async function cleanupOf(doc) {
  try {
    await doc.cleanup();
    return true;
  } catch {
    return false;
  }
}

/**
 * 書体を読み込んだ頁を読むたびに手放すようにする（結合した PDF の検証。結合と
 * 検証はいちばんメモリを使うので、書体を溜めない。手放した書体は次の頁で読み込み
 * 直すので、全頁で同じ書体を使う本でも毎頁手放す。前からの検証と同じ）。
 */
export function keepFewFonts(doc) {
  budgetOf(doc).limit = 0;
}

/** その文書で書体を手放せた回数（記録に出す。手放している最中なら、終えるのを待つ）。 */
export async function fontReleases(doc) {
  await fontsSettled(doc);
  return budgets.get(doc)?.releases ?? 0;
}

// pdf.js で描く頁は、1 頁ずつ描く。WebKit では大きなスキャンの画像を画面の
// スレッドで描くので、何頁も並べて描くと画面が長く固まり、メモリも足りなくなる。
let pdfjsTurn = Promise.resolve();

function inTurn(run) {
  const result = pdfjsTurn.then(run);
  pdfjsTurn = result.catch(() => {});
  return result;
}

// iPhone・iPad では、JPEG の展開も 1 頁ずつにする。600dpi の頁は、縮めて頼んでも
// 展開の途中で 1 枚 100 MB を超えるメモリを使い、並べるとページごと落ちる。
let scanTurn = Promise.resolve();

function inScanTurn(run) {
  if (!isIOS(globalThis.navigator)) return run();
  const result = scanTurn.then(run);
  scanTurn = result.catch(() => {});
  return result;
}

/**
 * 頁を viewport ごとの canvas に描く。
 *
 * scan（scan-images.js の findScanImages が見つけた JPEG）があれば、それを
 * ブラウザに展開させて描く。描けなければ（古いブラウザ・壊れた JPEG など）、
 * その頁は pdf.js で描く。pdf.js では、細かさの違う何枚か（測る画像と OCR の
 * 帯）を、いちばん細かい大きさで頁を 1 回だけ描いてから切り出す（pdf.js は
 * 描くたびにスキャンの画像を描き直すので、1 回にまとめる）。
 *
 * softMasks は頁のソフトマスクの数。iPhone・iPad では、ソフトマスクの多い頁を
 * 帯に分けて描く（bandRows）。
 */
async function drawViewports(doc, page, viewports, sizes, scan, softMasks = 0) {
  if (scan) {
    try {
      return await inScanTurn(() => drawScan(scan, viewports, sizes));
    } catch {
      // pdf.js で描き直す。
    }
  }
  return drawInTurn(doc, async () => {
    if (viewports.length === 1) {
      const size = sizes[0] ?? viewports[0];
      return [await drawPage(doc, page, viewports[0], size, bandRows(size.width, softMasks))];
    }
    const finest = Math.max(...viewports.map((viewport) => Math.hypot(viewport.transform[0], viewport.transform[1])));
    const full = page.getViewport({ scale: finest });
    const source = await drawPage(doc, page, full);
    try {
      return viewports.map((viewport, k) => {
        const size = sizes[k] ?? viewport;
        const canvas = canvasOf(size.width, size.height);
        const context = canvas.getContext('2d');
        context.imageSmoothingQuality = 'high';
        context.setTransform(...cropTransform(viewport, full));
        context.drawImage(source, 0, 0);
        return canvas;
      });
    } finally {
      releaseCanvas(source);
    }
  });
}

/**
 * pdf.js で描く順番に並べて描く。並ぶ前から「この文書を描いている」とする（並んで
 * いる間に書体を手放し始めると、順番が来ても手放し終えるのを待つことになり、ほかの
 * 文書の描画も止まる）。描いた頁の書体は drawPage が数える。
 */
function drawInTurn(doc, run) {
  return usingDoc(doc, () => inTurn(run));
}

function thumbnailUrl(source) {
  const height = Math.round((source.height * THUMB_WIDTH) / source.width);
  const canvas = canvasOf(THUMB_WIDTH, height);
  const context = canvas.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, THUMB_WIDTH, height);
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        releaseCanvas(canvas);
        resolve(blob ? URL.createObjectURL(blob) : '');
      },
      'image/jpeg',
      0.8
    );
  });
}

/**
 * 1 頁の文字情報を読む（画像は展開しないので軽い）。
 *
 * @param {object} doc openPdf の結果
 * @param {number} index 0 から数えた頁の位置
 * @returns {Promise<{size:{width:number,height:number}, items:object[],
 *                    signature:{length:number,hash:string}}>}
 */
export async function readPageText(doc, index) {
  return usingDoc(doc, async () => {
    try {
      return await readText(doc, index);
    } catch (error) {
      // 読めなかった頁は、書体を読み込まなかったものとする（頁を書体 1 つと数えない）。
      const { pages } = budgetOf(doc);
      if (!pages.has(index)) pages.set(index, []);
      throw error;
    } finally {
      // 「読んでいる」を外す前に数える（手放すのと数えるのが食い違わないように）。
      noteFonts(doc, index);
    }
  });
}

/** 文書の書体を手放している最中なら、終えるのを待つ（続けて手放し始めたら、それも）。 */
async function fontsSettled(doc) {
  const budget = budgets.get(doc);
  while (budget?.cleaning) await budget.cleaning;
}

async function readText(doc, index) {
  const page = await doc.getPage(index + 1);
  try {
    const base = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    // 書体の名前は、最初に読んだときのものを使い続ける（手放すと pdf.js は名前を
    // 付け直すので、読み直すたびに入れ替えると、同じ書体を別の書体と数えてしまう）。
    const { pages } = budgetOf(doc);
    if (!pages.has(index)) pages.set(index, Object.keys(content.styles));
    return {
      size: { width: base.width, height: base.height },
      items: textItems(content, base),
      signature: textSignature(content.items),
    };
  } finally {
    page.cleanup();
  }
}

/**
 * しおり（目次）の、いちばん上の段の項目が指す頁（頁の位置 → 項目の名前）。
 *
 * 分ける位置の候補にする（split.js）。しおりが書名 1 つだけで、その下に章が
 * 並ぶ形なら、その下の段を使う。指す先の分からない項目と、しおりを読めない
 * PDF は飛ばす（分ける候補が減るだけなので）。名前の中の改行・タブは空白 1 つに
 * する（画面に候補の理由として出すため）。
 *
 * @returns {Promise<Map<number, string>>}
 */
export async function readOutline(doc) {
  const titles = new Map();
  let items = (await doc.getOutline().catch(() => null)) ?? [];
  if (items.length === 1 && items[0].items?.length) items = items[0].items;
  // 行き先は並べて引き、項目の順に、頁ごとに最初の項目の名前を使う。名前の無い
  // 項目と、指す先の分からない項目は使わない（名前の中の改行・タブは空白 1 つにする）。
  const pages = await Promise.all(items.map((item) => outlinePage(doc, item.dest).catch(() => null)));
  items.forEach((item, k) => {
    const title = item.title.replace(/[\r\n\t]+/g, ' ').trim();
    if (title && pages[k] !== null && !titles.has(pages[k])) titles.set(pages[k], title);
  });
  return titles;
}

/** しおりの項目の行き先（名前か、頁の参照か頁の番号の並び）が指す頁の位置。 */
async function outlinePage(doc, dest) {
  const target = (typeof dest === 'string' ? await doc.getDestination(dest) : dest)?.[0];
  return Number.isInteger(target) ? target : doc.getPageIndex(target);
}

/** 余白の帯（上下 MARGIN_ZONE）を、OCR に足りる細かさで描く viewport と canvas の大きさ。 */
function marginViewports(page) {
  const base = page.getViewport({ scale: 1 });
  const scale = OCR_PAGE_HEIGHT / base.height;
  const full = page.getViewport({ scale });
  const size = { width: full.width, height: full.height * MARGIN_ZONE };
  return [
    { zone: 'top', top: 0 },
    { zone: 'bottom', top: 1 - MARGIN_ZONE },
  ].map(({ zone, top }) => ({
    zone,
    top,
    size,
    viewport: page.getViewport({ scale, offsetY: -top * full.height }),
  }));
}

function stripsOf(margins, canvases) {
  return margins.map(({ zone, top }, k) => ({ zone, canvas: canvases[k], top, height: MARGIN_ZONE }));
}

/**
 * 1 頁を測る画像（白黒）と、一覧の縮小画像にする。margins なら、頁番号を
 * OCR する余白の帯も、同じ展開から描く（600dpi のスキャンは展開そのものが
 * 重いので、1 頁につき 1 回にする）。
 *
 * @param {object} doc openPdf の結果
 * @param {number} index 0 から数えた頁の位置
 * @param {object|null} [scan] その頁の JPEG（scan-images.js）。無ければ pdf.js で描く
 * @param {{margins?: boolean, softMasks?: number}} [options] softMasks は頁のソフトマスクの数
 *   （scan-images.js の findScanImages）。ソフトマスクの多い頁は粗く描く（cappedScale）。
 *   その頁の余白は OCR しない（呼ぶ側が margins を頼まない）
 * @returns {Promise<{image:{width:number,height:number,gray:Uint8Array}, thumbUrl:string,
 *                    strips:{zone:'top'|'bottom', canvas:HTMLCanvasElement, top:number, height:number}[]}>}
 *   strips は margins のときだけ（そうでなければ空）。
 */
export async function renderPageImage(doc, index, scan = null, { margins = false, softMasks = 0 } = {}) {
  const page = await doc.getPage(index + 1);
  try {
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: cappedScale(base, ANALYSIS_LONG_SIDE, softMasks) });
    const bands = margins ? marginViewports(page) : [];
    const [canvas, ...stripCanvases] = await drawViewports(
      doc,
      page,
      [viewport, ...bands.map((band) => band.viewport)],
      [undefined, ...bands.map((band) => band.size)],
      scan,
      softMasks
    );
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const image = {
      width: canvas.width,
      height: canvas.height,
      gray: toGray(context.getImageData(0, 0, canvas.width, canvas.height).data),
    };
    const thumbUrl = await thumbnailUrl(canvas);
    releaseCanvas(canvas);
    return { image, thumbUrl, strips: stripsOf(bands, stripCanvases) };
  } finally {
    page.cleanup();
  }
}

/**
 * 頁の上下の余白だけを、OCR に足りる細かさで描く。
 *
 * 頁全体を細かく描くと 1 頁で数十 MB の画素になるので、頁番号のある帯
 * （上下 MARGIN_ZONE）だけを描く。
 *
 * @param {object} doc openPdf の結果
 * @param {number} index 0 から数えた頁の位置
 * @param {object|null} [scan] その頁の JPEG（scan-images.js）。無ければ pdf.js で描く
 * @returns {Promise<{zone:'top'|'bottom', canvas:HTMLCanvasElement, top:number, height:number}[]>}
 *   top と height は、帯の位置を頁の高さに対する割合で表したもの。
 */
export async function renderMargins(doc, index, scan = null) {
  const page = await doc.getPage(index + 1);
  try {
    const bands = marginViewports(page);
    const canvases = await drawViewports(
      doc,
      page,
      bands.map((band) => band.viewport),
      bands.map((band) => band.size),
      scan
    );
    return stripsOf(bands, canvases);
  } finally {
    page.cleanup();
  }
}

/**
 * 拡大表示用に、1 頁を大きめに描いて画像の URL を返す（使い終えたら revoke する）。
 *
 * @param {object} doc openPdf の結果
 * @param {number} index 0 から数えた頁の位置
 * @param {{longSide?: number, softMasks?: number}} [options] longSide は長辺の大きさ（px）、
 *   softMasks は頁のソフトマスクの数（ソフトマスクの多い頁は粗く描き（cappedScale）、
 *   iPhone・iPad では帯に分けて描く（bandRows））
 */
export async function renderPreview(doc, index, { longSide = PREVIEW_LONG_SIDE, softMasks = 0 } = {}) {
  const page = await doc.getPage(index + 1);
  try {
    const base = page.getViewport({ scale: 1 });
    const scale = cappedScale(base, longSide, softMasks, SOFT_MASK_WORK * PREVIEW_SOFT_MASK_WORK);
    const viewport = page.getViewport({ scale });
    const canvas = await drawInTurn(doc, () => drawPage(doc, page, viewport, viewport, bandRows(viewport.width, softMasks)));
    return await new Promise((resolve) => {
      canvas.toBlob(
        (blob) => {
          releaseCanvas(canvas);
          resolve(blob ? URL.createObjectURL(blob) : '');
        },
        'image/jpeg',
        0.9
      );
    });
  } finally {
    page.cleanup();
  }
}
