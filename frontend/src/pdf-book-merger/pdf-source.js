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
 * PDF を開く。
 *
 * pdf.js は受け取ったバイト列を worker へ渡して手放してしまうので、
 * 結合に使う元のバイト列は渡さず、複製を渡す。
 *
 * @param {Uint8Array} bytes
 */
export async function openPdf(bytes, { safe = false } = {}) {
  const webkit = isWebKit(globalThis.navigator);
  // iPhone・iPad では、はじめから OffscreenCanvas を切る。worker の中で
  // 600dpi のスキャン（3000 万画素ほど）を OffscreenCanvas に描くと、canvas の
  // 大きさの上限（1600 万画素ほど）を超えて「invalid state」になり、描き直す
  // 間にメモリが尽きてページごと落ちた。
  safe ||= isIOS(globalThis.navigator);
  const doc = await pdfjs.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
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
  }).promise;
  if (webkit && !safe) fallbacks.set(doc, { bytes, safe: null, failed: false });
  return doc;
}

/** WebKit で開いた文書 → 描けなかったときに開き直す、安全な設定の文書。 */
const fallbacks = new WeakMap();

function safeDocOf(doc) {
  const fallback = fallbacks.get(doc);
  if (!fallback) return null;
  fallback.safe ??= openPdf(fallback.bytes, { safe: true });
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
}

function canvasOf(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
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
 * pdf.js で描く。WebKit で描けなかったときは、OffscreenCanvas も切った文書で
 * 描き直し、その文書の残りの頁もそちらで描く。
 */
async function drawPage(doc, page, viewport, size = viewport) {
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
 */
async function drawViewports(doc, page, viewports, sizes, scan) {
  if (scan) {
    try {
      return await inScanTurn(() => drawScan(scan, viewports, sizes));
    } catch {
      // pdf.js で描き直す。
    }
  }
  return inTurn(async () => {
    if (viewports.length === 1) return [await drawPage(doc, page, viewports[0], sizes[0])];
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
 * @param {{margins?: boolean}} [options]
 * @returns {Promise<{image:{width:number,height:number,gray:Uint8Array}, thumbUrl:string,
 *                    strips:{zone:'top'|'bottom', canvas:HTMLCanvasElement, top:number, height:number}[]}>}
 *   strips は margins のときだけ（そうでなければ空）。
 */
export async function renderPageImage(doc, index, scan = null, { margins = false } = {}) {
  const page = await doc.getPage(index + 1);
  try {
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: ANALYSIS_LONG_SIDE / Math.max(base.width, base.height) });
    const bands = margins ? marginViewports(page) : [];
    const [canvas, ...stripCanvases] = await drawViewports(
      doc,
      page,
      [viewport, ...bands.map((band) => band.viewport)],
      [undefined, ...bands.map((band) => band.size)],
      scan
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
 * @param {number} longSide 長辺の大きさ（px）
 */
export async function renderPreview(doc, index, longSide = PREVIEW_LONG_SIDE) {
  const page = await doc.getPage(index + 1);
  try {
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: longSide / Math.max(base.width, base.height) });
    const canvas = await inTurn(() => drawPage(doc, page, viewport));
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
