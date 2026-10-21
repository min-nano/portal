// @vitest-environment jsdom
//
// 書籍スキャン PDF 結合ツール: WebKit（Safari・iPhone・iPad）で pdf.js が頁を
// 描けなかったとき、OffscreenCanvas も切った文書で開き直して描き直す
// （pdf-source.js）。pdf.js は偽物に差し替え、渡した設定と描き直しを確かめる。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const opened = [];
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  AnnotationMode: { DISABLE: 0 },
  getDocument: (params) => {
    const doc = {
      params,
      destroyed: false,
      rendered: 0,
      loadingTask: {
        destroy: async () => {
          doc.destroyed = true;
        },
      },
      getPage: async (pageNumber) => ({
        pageNumber,
        getViewport: ({ scale }) => ({ width: 100 * scale, height: 140 * scale, transform: [scale, 0, 0, -scale, 0, 140 * scale] }),
        render: () => ({
          promise: (async () => {
            doc.rendered++;
            // OffscreenCanvas を使う設定では描けない、という WebKit の偽物。
            if (params.isOffscreenCanvasSupported && doc.failWithOffscreen) {
              throw new DOMException('The object is in an invalid state.', 'InvalidStateError');
            }
          })(),
        }),
        cleanup: () => {},
      }),
    };
    doc.failWithOffscreen = globalThis.__failWithOffscreen;
    opened.push(doc);
    return { promise: Promise.resolve(doc) };
  },
}));
vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => ({ default: 'worker.js' }));

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

let source;

beforeEach(async () => {
  vi.resetModules();
  opened.length = 0;
  globalThis.__failWithOffscreen = false;
  HTMLCanvasElement.prototype.toBlob = function toBlob(callback) {
    callback(new Blob(['x']));
  };
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  source = await import('../src/pdf-book-merger/pdf-source.js');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WebKit での pdf.js の設定と描き直し', () => {
  it('Mac の Safari では ImageDecoder を切り、OffscreenCanvas は使う。iPhone は両方切る。ほかのブラウザは両方使う', async () => {
    vi.stubGlobal('navigator', { userAgent: MAC_SAFARI, platform: 'MacIntel', maxTouchPoints: 0 });
    await source.openPdf(new Uint8Array([1]));
    vi.stubGlobal('navigator', { userAgent: IPHONE });
    await source.openPdf(new Uint8Array([1]));
    vi.stubGlobal('navigator', { userAgent: CHROME });
    await source.openPdf(new Uint8Array([1]));

    expect(opened.map(({ params }) => [params.isImageDecoderSupported, params.isOffscreenCanvasSupported])).toEqual([
      [false, true],
      [false, false],
      [true, true],
    ]);
  });

  it('WebKit で描けなければ、両方を切った文書で描き直し、以後はそちらで描く', async () => {
    vi.stubGlobal('navigator', { userAgent: MAC_SAFARI, platform: 'MacIntel', maxTouchPoints: 0 });
    globalThis.__failWithOffscreen = true;
    const doc = await source.openPdf(new Uint8Array([1, 2, 3]));

    expect(await source.renderPreview(doc, 0, 200)).toBe('blob:preview');
    expect(opened).toHaveLength(2);
    const [, safe] = opened;
    expect([safe.params.isImageDecoderSupported, safe.params.isOffscreenCanvasSupported]).toEqual([false, false]);
    expect([...safe.params.data]).toEqual([1, 2, 3]);
    expect([doc.rendered, safe.rendered]).toEqual([1, 1]);

    // 2 頁目からは、初めから安全な文書で描く（失敗を繰り返さない）。
    await source.renderPreview(doc, 1, 200);
    expect([doc.rendered, safe.rendered]).toEqual([1, 2]);
    expect(opened).toHaveLength(2);

    // 閉じると、開き直した文書も閉じる。
    await source.closePdf(doc);
    expect([doc.destroyed, safe.destroyed]).toEqual([true, true]);
  });

  it('WebKit でなければ、描けなかったらそのまま失敗を返す', async () => {
    vi.stubGlobal('navigator', { userAgent: CHROME });
    globalThis.__failWithOffscreen = true;
    const doc = await source.openPdf(new Uint8Array([1]));

    await expect(source.renderPreview(doc, 0, 200)).rejects.toThrow('invalid state');
    expect(opened).toHaveLength(1);
  });
});
