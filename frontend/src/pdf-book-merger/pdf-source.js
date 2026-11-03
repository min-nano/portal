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
import { BundledDataFactory } from './pdf-data.js';
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
    // CMap・標準フォント・画像の展開の wasm（pdf-data.js）。渡さないと、ToUnicode を
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
  return inTurn(async () => {
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
  const page = await doc.getPage(index + 1);
  try {
    const base = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    return {
      size: { width: base.width, height: base.height },
      items: textItems(content, base),
      signature: textSignature(content.items),
    };
  } finally {
    page.cleanup();
  }
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
    const canvas = await inTurn(() => drawPage(doc, page, viewport, viewport, bandRows(viewport.width, softMasks)));
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
