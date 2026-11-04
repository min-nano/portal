// PDF の頁を <canvas> に描いて並べる（雛形のプレビュー。template-preview.js）。
//
// ブラウザ自身の PDF 表示（<iframe> / <embed>）は、Android の Chrome では
// 開けず（ダウンロードになる）、iPhone の Safari では 1 頁目しか出ないので、
// pdf.js で描く。pdf.js は大きいので、このファイルはプレビューを開いたとき
// にだけ読み込まれる（template-preview.js が import() する）。

// 社内の端末はブラウザの種類も版もまちまちなので、補ってある legacy の
// ビルドを使う（PDF 結合ツールの pdf-source.js と同じ）。
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { BundledDataFactory } from './pdf-data.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

/** 描く細かさの上限（端末の画素の比）。3 倍の端末でも 2 倍で十分に読める。 */
export const MAX_PIXEL_RATIO = 2;
/** 描く幅（CSS の px）の下限。並べる場所の幅が測れないときにも使う。 */
export const MIN_WIDTH = 320;

/**
 * PDF の頁を、container の幅に合わせて 1 頁ずつ描いて足していく。
 *
 * @param {Uint8Array} bytes PDF
 * @param {HTMLElement} container 頁を足していく場所
 * @param {object} [options]
 * @param {() => boolean} [options.stopped] true を返したら、残りの頁は描かない
 *   （描いている途中でプレビューを閉じたとき）
 * @returns {Promise<number>} 描いた頁の数
 */
export async function renderPdfPages(bytes, container, { stopped = () => false } = {}) {
  const loading = pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
    // CMap・標準フォント（pdf-data.js）。渡さないと、ToUnicode を持たない
    // 日本語のフォントの文字が消える。
    BinaryDataFactory: BundledDataFactory,
    // Safari では worker の中の ImageDecoder が失敗することがある
    // （pdf-source.js 参照）。1〜数頁なので、どのブラウザでも使わない。
    isImageDecoderSupported: false,
  });
  let drawn = 0;
  try {
    const doc = await loading.promise;
    const width = Math.max(container.clientWidth, MIN_WIDTH);
    const ratio = Math.min(globalThis.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    for (let number = 1; number <= doc.numPages && !stopped(); number++) {
      const page = await doc.getPage(number);
      // 頁を読んでいる間に閉じられたら、足さない（開き直した中身に混ざらないように）。
      if (stopped()) break;
      const scale = (width * ratio) / page.getViewport({ scale: 1 }).width;
      const viewport = page.getViewport({ scale });
      const canvas = container.ownerDocument.createElement('canvas');
      canvas.className = 'pdf-page';
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `${number} / ${doc.numPages} 頁`);
      container.append(canvas);
      await page.render({ canvas, viewport, annotationMode: pdfjs.AnnotationMode.DISABLE }).promise;
      drawn++;
    }
  } finally {
    await loading.destroy();
  }
  return drawn;
}
