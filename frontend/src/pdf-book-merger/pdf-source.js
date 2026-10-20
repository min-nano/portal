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
import { drawScan } from './scan-images.js';
import { textItems, textSignature } from './text-layer.js';

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
export function openPdf(bytes) {
  const webkit = isWebKit(globalThis.navigator);
  return pdfjs.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    // Safari（と、中身が同じ WebKit の iPhone・iPad のブラウザ）では、worker の
    // 中で画像を ImageDecoder・OffscreenCanvas で展開すると「The object is in
    // an invalid state.」で失敗することがある（スキャンの JPEG で起きる）。
    // pdf.js 自身の展開に任せる（少し遅くなるが確実に読める）。
    isImageDecoderSupported: !webkit,
    isOffscreenCanvasSupported: !webkit,
  }).promise;
}

/**
 * WebKit で動いているか（Safari と、iPhone・iPad のすべてのブラウザ）。
 *
 * iPad の Safari は Mac を名乗るので、タッチの有無で見分ける。
 *
 * @param {{userAgent?:string, platform?:string, maxTouchPoints?:number}} [nav]
 */
export function isWebKit(nav) {
  if (!nav) return false;
  const userAgent = nav.userAgent || '';
  const ios =
    /\b(?:iPad|iPhone|iPod)\b/.test(userAgent) ||
    (nav.platform === 'MacIntel' && (nav.maxTouchPoints || 0) > 1);
  const safari = /Safari\//.test(userAgent) && !/Chrome\/|Chromium\/|Edg\/|Firefox\//.test(userAgent);
  return ios || safari;
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
export function closePdf(doc) {
  return doc ? doc.loadingTask.destroy() : Promise.resolve();
}

function canvasOf(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

/** pdf.js で、viewport のとおりに描く。注釈（付箋・リンクの枠）は検査の邪魔なので描かない。 */
async function drawPage(page, viewport, size = viewport) {
  const canvas = canvasOf(size.width, size.height);
  await page.render({ canvas, viewport, annotationMode: pdfjs.AnnotationMode.DISABLE }).promise;
  return canvas;
}

/**
 * 頁を viewport ごとの canvas に描く。
 *
 * scan（scan-images.js の findScanImages が見つけた JPEG）があれば、それを
 * ブラウザに展開させて描く。描けなければ（古いブラウザ・壊れた JPEG など）、
 * その頁は pdf.js で描く。
 */
async function drawViewports(page, viewports, sizes, scan) {
  if (scan) {
    try {
      return await drawScan(scan, viewports, sizes);
    } catch {
      // pdf.js で描き直す。
    }
  }
  const canvases = [];
  for (const [k, viewport] of viewports.entries()) canvases.push(await drawPage(page, viewport, sizes[k]));
  return canvases;
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

/**
 * 1 頁を測る画像（白黒）と、一覧の縮小画像にする。
 *
 * @param {object} doc openPdf の結果
 * @param {number} index 0 から数えた頁の位置
 * @param {object|null} [scan] その頁の JPEG（scan-images.js）。無ければ pdf.js で描く
 * @returns {Promise<{image:{width:number,height:number,gray:Uint8Array}, thumbUrl:string}>}
 */
export async function renderPageImage(doc, index, scan = null) {
  const page = await doc.getPage(index + 1);
  try {
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: ANALYSIS_LONG_SIDE / Math.max(base.width, base.height) });
    const [canvas] = await drawViewports(page, [viewport], [], scan);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const image = {
      width: canvas.width,
      height: canvas.height,
      gray: toGray(context.getImageData(0, 0, canvas.width, canvas.height).data),
    };
    const thumbUrl = await thumbnailUrl(canvas);
    releaseCanvas(canvas);
    return { image, thumbUrl };
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
    const base = page.getViewport({ scale: 1 });
    const scale = OCR_PAGE_HEIGHT / base.height;
    const full = page.getViewport({ scale });
    const size = { width: full.width, height: full.height * MARGIN_ZONE };
    const zones = [
      { zone: 'top', top: 0 },
      { zone: 'bottom', top: 1 - MARGIN_ZONE },
    ];
    const viewports = zones.map(({ top }) => page.getViewport({ scale, offsetY: -top * full.height }));
    const canvases = await drawViewports(page, viewports, [size, size], scan);
    return zones.map(({ zone, top }, k) => ({ zone, canvas: canvases[k], top, height: MARGIN_ZONE }));
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
    const canvas = await drawPage(page, viewport);
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
