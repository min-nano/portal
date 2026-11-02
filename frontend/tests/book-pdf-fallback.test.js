// @vitest-environment jsdom
//
// PDF 結合ツール: pdf.js で頁を描く（pdf-source.js）。pdf.js は偽物に差し替える。
//
//   - WebKit（Safari・iPhone・iPad）で描けなかったとき、OffscreenCanvas も
//     切った文書で開き直して描き直す。渡した設定と描き直しを確かめる
//   - ソフトマスクの多い頁は粗く描き、iPhone・iPad では帯に分けて描く

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const opened = [];
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  PDFWorker: class PDFWorker {
    destroy() {
      this.destroyed = true;
    }
  },
  AnnotationMode: { DISABLE: 0 },
  getDocument: (params) => {
    const doc = {
      params,
      destroyed: false,
      rendered: 0,
      canvases: [],
      offsets: [],
      loadingTask: {
        destroy: async () => {
          doc.destroyed = true;
        },
      },
      getPage: async (pageNumber) => ({
        pageNumber,
        getViewport: function viewportOf({ scale, offsetY = 0 }) {
          return {
            width: 100 * scale,
            height: 140 * scale,
            offsetY,
            transform: [scale, 0, 0, -scale, 0, 140 * scale + offsetY],
            clone: (changes) => viewportOf({ scale, offsetY, ...changes }),
          };
        },
        render: ({ canvas, viewport }) => ({
          promise: (async () => {
            doc.rendered++;
            doc.canvases.push([canvas.width, canvas.height]);
            doc.offsets.push(viewport.offsetY);
            if (doc.failAt === doc.rendered) throw new Error('render');
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
    if (globalThis.__failToOpen) return { promise: Promise.reject(new Error('Invalid PDF structure')) };
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
  globalThis.__failToOpen = false;
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
    expect(source.redrawnSafely(doc)).toBe(false);

    expect(await source.renderPreview(doc, 0, { longSide: 200 })).toBe('blob:preview');
    // 描き直したことは、記録に出せるように覚えておく。
    expect(source.redrawnSafely(doc)).toBe(true);
    expect(opened).toHaveLength(2);
    const [, safe] = opened;
    expect([safe.params.isImageDecoderSupported, safe.params.isOffscreenCanvasSupported]).toEqual([false, false]);
    expect([...safe.params.data]).toEqual([1, 2, 3]);
    expect([doc.rendered, safe.rendered]).toEqual([1, 1]);

    // 2 頁目からは、初めから安全な文書で描く（失敗を繰り返さない）。
    await source.renderPreview(doc, 1, { longSide: 200 });
    expect([doc.rendered, safe.rendered]).toEqual([1, 2]);
    expect(opened).toHaveLength(2);

    // 閉じると、開き直した文書も閉じる。
    await source.closePdf(doc);
    expect([doc.destroyed, safe.destroyed]).toEqual([true, true]);
  });

  it('どの文書も（開き直した文書も）、1 つの worker で開く', async () => {
    vi.stubGlobal('navigator', { userAgent: MAC_SAFARI, platform: 'MacIntel', maxTouchPoints: 0 });
    globalThis.__failWithOffscreen = true;
    const doc = await source.openPdf(new Uint8Array([1]));
    await source.renderPreview(doc, 0, 200);
    await source.closePdf(doc);
    await source.openPdf(new Uint8Array([2]));

    expect(opened).toHaveLength(3);
    const [{ params: first }] = opened;
    expect(first.worker).toBeTruthy();
    expect(opened.every(({ params }) => params.worker === first.worker)).toBe(true);
  });

  it('開いている文書が無いときだけ、worker を止める（次に開くときに作り直す）', async () => {
    vi.stubGlobal('navigator', { userAgent: CHROME });
    // まだ worker が無ければ、止めるものは無い。
    expect(source.releasePdfWorker()).toBe(false);

    const doc = await source.openPdf(new Uint8Array([1]));
    const worker = opened[0].params.worker;
    expect(source.releasePdfWorker()).toBe(false);
    expect(worker.destroyed).toBeUndefined();

    await source.closePdf(doc);
    expect(source.releasePdfWorker()).toBe(true);
    expect(worker.destroyed).toBe(true);

    // 開けなかった文書は数えない。
    globalThis.__failToOpen = true;
    await expect(source.openPdf(new Uint8Array([2]))).rejects.toThrow('Invalid PDF structure');
    expect(source.releasePdfWorker()).toBe(true);

    globalThis.__failToOpen = false;
    await source.openPdf(new Uint8Array([3]));
    expect(opened.at(-1).params.worker).not.toBe(worker);
  });

  it('写さずに渡すときは、渡したバイト列をそのまま pdf.js に渡す', async () => {
    vi.stubGlobal('navigator', { userAgent: CHROME });
    const bytes = new Uint8Array([1, 2]);
    await source.openPdf(bytes, { transfer: true });
    await source.openPdf(bytes);

    expect(opened[0].params.data).toBe(bytes);
    expect(opened[1].params.data).not.toBe(bytes);
    expect([...opened[1].params.data]).toEqual([1, 2]);
  });

  it('WebKit でなければ、描けなかったらそのまま失敗を返す', async () => {
    vi.stubGlobal('navigator', { userAgent: CHROME });
    globalThis.__failWithOffscreen = true;
    const doc = await source.openPdf(new Uint8Array([1]));

    await expect(source.renderPreview(doc, 0, { longSide: 200 })).rejects.toThrow('invalid state');
    expect(opened).toHaveLength(1);
    expect(source.redrawnSafely(doc)).toBe(false);
  });
});

describe('ソフトマスクの多い頁は、粗く描く', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { userAgent: CHROME });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** jsdom の canvas は描けないので、使う分だけ用意する。drawImage の置き場所を drawn に残す。 */
  function fakeContexts() {
    const drawn = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function getContext() {
      const canvas = this;
      return {
        drawImage: (image, x, y) => drawn.push([canvas.width, canvas.height, image.width, image.height, x, y]),
        setTransform() {},
        getImageData: () => ({ data: new Uint8ClampedArray(canvas.width * canvas.height * 4) }),
      };
    });
    return drawn;
  }

  // 偽物の頁は 100×140。測る画像は長辺 1000px、OCR の帯は頁の高さ 2400px の上下 14%。
  const SOFT_MASKS = 1032;
  const BASE = { width: 100, height: 140 };

  it('描く画素の数 × ソフトマスクの数が上限に収まるまで小さくする（少なければそのまま）', () => {
    const normal = 1000 / 140;
    expect(source.cappedScale(BASE, 1000, 0)).toBe(normal);
    expect(source.cappedScale(BASE, 1000, source.MANY_SOFT_MASKS)).toBe(normal);
    // 1,032 回なら、100×140 の頁を 7.7 万画素ほどに（長辺 330px ほど）。
    const scale = source.cappedScale(BASE, 1000, SOFT_MASKS);
    expect(BASE.width * BASE.height * scale ** 2 * SOFT_MASKS).toBeCloseTo(source.SOFT_MASK_WORK, -3);
    expect(Math.round(BASE.height * scale)).toBe(329);
    // ソフトマスクが多くても、もとの大きさより大きくはしない。
    expect(source.cappedScale(BASE, 10, SOFT_MASKS)).toBe(10 / 140);
    expect(source.manySoftMasks()).toBe(false);
    expect(source.manySoftMasks(source.MANY_SOFT_MASKS + 1)).toBe(true);
  });

  it('ソフトマスクの多い頁は、測る画像も拡大表示も粗く描く', async () => {
    fakeContexts();
    const doc = await source.openPdf(new Uint8Array([1]));
    const { image } = await source.renderPageImage(doc, 0, null, { softMasks: SOFT_MASKS });
    expect([image.width, image.height]).toEqual([235, 329]);
    expect(doc.canvases).toEqual([[235, 329]]);

    doc.canvases.length = 0;
    await source.renderPreview(doc, 0, { softMasks: SOFT_MASKS });
    // 拡大表示は、一覧の 2 倍の画素まで。
    expect(doc.canvases).toEqual([[333, 466]]);
    doc.canvases.length = 0;
    await source.renderPreview(doc, 0);
    expect(doc.canvases).toEqual([[1143, 1600]]);
  });

  it('ソフトマスクが少なければ、いちばん細かい大きさで頁を 1 回だけ描いて切り出す', async () => {
    fakeContexts();
    const doc = await source.openPdf(new Uint8Array([1]));
    const { image } = await source.renderPageImage(doc, 0, null, { margins: true, softMasks: source.MANY_SOFT_MASKS });
    expect([image.width, image.height]).toEqual([714, 1000]);
    expect(doc.canvases).toEqual([[1714, 2400]]);

    doc.canvases.length = 0;
    await source.renderMargins(doc, 0, null);
    expect(doc.canvases).toEqual([[1714, 2400]]);
  });

  it('iPhone・iPad では、ソフトマスクの多い頁を帯に分けて描いてつなぐ（pdf.js が持つ canvas を小さくする）', async () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE });
    const drawn = fakeContexts();
    const doc = await source.openPdf(new Uint8Array([1]));
    await source.renderPageImage(doc, 0, null, { softMasks: SOFT_MASKS });

    // 測る画像（235×329）: 4,800 万画素 ÷（幅 235 × 1,032）= 197 行ずつ。
    const rows = source.bandRows(235.3, SOFT_MASKS);
    expect(rows).toBe(197);
    expect(doc.canvases).toEqual([
      [235, rows],
      [235, 329 - rows],
    ]);
    expect(doc.offsets).toEqual([0, -rows]);
    // 帯は、つないだ canvas の上から順に置く。
    const placed = drawn.filter(([width, height]) => width === 235 && height === 329);
    expect(placed.map(([, , , , x, y]) => [x, y])).toEqual([
      [0, 0],
      [0, rows],
    ]);

    // 拡大表示も分けて描く。
    doc.canvases.length = 0;
    await source.renderPreview(doc, 0, { softMasks: SOFT_MASKS });
    const previewRows = source.bandRows(332.8, SOFT_MASKS);
    expect(doc.canvases).toHaveLength(Math.ceil(466 / previewRows));
    expect(doc.canvases.every(([width, height]) => width === 333 && height <= previewRows)).toBe(true);
  });

  it('帯の高さは、ソフトマスクの少ない頁と iPhone・iPad でない端末では分けない。多すぎても下限より細くしない', () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE });
    expect(source.bandRows(1000, source.MANY_SOFT_MASKS)).toBe(Infinity);
    expect(source.bandRows(1000, 100000)).toBe(16);
    vi.stubGlobal('navigator', { userAgent: CHROME });
    expect(source.bandRows(1000, SOFT_MASKS)).toBe(Infinity);
  });

  it('帯の途中で描けなければ、つなぎかけの canvas を手放して失敗を返す', async () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE });
    fakeContexts();
    const doc = await source.openPdf(new Uint8Array([1]));
    doc.failAt = 3;
    const created = [];
    const create = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((name) => {
      const element = create(name);
      if (name === 'canvas') created.push(element);
      return element;
    });
    await expect(source.renderPreview(doc, 0, { softMasks: SOFT_MASKS })).rejects.toThrow('render');
    expect(doc.rendered).toBe(3);
    expect(created.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
  });
});
