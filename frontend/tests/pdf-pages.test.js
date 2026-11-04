// @vitest-environment jsdom
//
// PDF の頁を描いて並べる（pdf-pages.js。雛形のプレビュー）。
//
// pdf.js そのものは差し替え、並べる場所の幅に合わせた細かさで頁ごとに
// <canvas> を足すこと・途中で止められること・開いた文書を必ず閉じることを
// 固定する。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pdfjs = vi.hoisted(() => ({
  GlobalWorkerOptions: {},
  AnnotationMode: { DISABLE: 0 },
  getDocument: vi.fn(),
}));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => pdfjs);
vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => ({ default: '/assets/pdf.worker.js' }));

const { MAX_PIXEL_RATIO, MIN_WIDTH, renderPdfPages } = await import('../src/pdf-pages.js');
const { BundledDataFactory } = await import('../src/pdf-data.js');

/** A4（595 × 842 pt）の頁が pages 枚の文書。 */
function fakeDocument(pages, { fail = false, onGetPage = () => {} } = {}) {
  const rendered = [];
  const loading = {
    promise: fail ? Promise.reject(new Error('壊れた PDF')) : Promise.resolve({
      numPages: pages,
      getPage: async (number) => (onGetPage(number), {
        getViewport: ({ scale }) => ({ width: 595 * scale, height: 842 * scale }),
        render: (params) => {
          rendered.push({ number, ...params });
          return { promise: Promise.resolve() };
        },
      }),
    }),
    destroy: vi.fn(async () => {}),
  };
  pdfjs.getDocument.mockReturnValue(loading);
  return { loading, rendered };
}

function container(width) {
  const div = document.createElement('div');
  Object.defineProperty(div, 'clientWidth', { value: width });
  document.body.append(div);
  return div;
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('renderPdfPages', () => {
  it('頁ごとに、並べる場所の幅 × 端末の画素の比で描いた canvas を足す', async () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const { loading, rendered } = fakeDocument(2);
    const box = container(595);
    const bytes = new Uint8Array([1, 2, 3]);

    await expect(renderPdfPages(bytes, box)).resolves.toBe(2);

    expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe('/assets/pdf.worker.js');
    expect(pdfjs.getDocument).toHaveBeenCalledWith({
      data: bytes,
      isEvalSupported: false,
      BinaryDataFactory: BundledDataFactory,
      isImageDecoderSupported: false,
    });
    const canvases = box.querySelectorAll('canvas.pdf-page');
    expect(canvases).toHaveLength(2);
    expect([canvases[0].width, canvases[0].height]).toEqual([1190, 1684]);
    expect(canvases[1].getAttribute('aria-label')).toBe('2 / 2 頁');
    expect(rendered.map((r) => [r.number, r.canvas, r.annotationMode])).toEqual([
      [1, canvases[0], 0],
      [2, canvases[1], 0],
    ]);
    expect(loading.destroy).toHaveBeenCalledTimes(1);
  });

  it('細かさは上限で抑え、幅が測れなければ下限の幅で描く', async () => {
    vi.stubGlobal('devicePixelRatio', 3);
    fakeDocument(1);
    const box = container(0);

    await renderPdfPages(new Uint8Array(), box);

    expect(box.querySelector('canvas').width).toBe(MIN_WIDTH * MAX_PIXEL_RATIO);
  });

  it('画素の比が分からない端末では等倍で描く', async () => {
    vi.stubGlobal('devicePixelRatio', undefined);
    fakeDocument(1);
    const box = container(400);

    await renderPdfPages(new Uint8Array(), box);

    expect(box.querySelector('canvas').width).toBe(400);
  });

  it('止められたら、残りの頁は描かない', async () => {
    const { loading, rendered } = fakeDocument(3);
    const box = container(400);
    // 1 頁目を描き終えたところで止められた（プレビューを閉じた）。
    const stopped = () => rendered.length >= 1;

    await expect(renderPdfPages(new Uint8Array(), box, { stopped })).resolves.toBe(1);

    expect(rendered).toHaveLength(1);
    expect(loading.destroy).toHaveBeenCalledTimes(1);
  });

  it('頁を読んでいる間に止められたら、その頁も足さない', async () => {
    let stop = false;
    const { rendered } = fakeDocument(2, { onGetPage: () => (stop = true) });
    const box = container(400);

    await expect(renderPdfPages(new Uint8Array(), box, { stopped: () => stop })).resolves.toBe(0);

    expect(box.querySelector('canvas')).toBeNull();
    expect(rendered).toHaveLength(0);
  });

  it('開けなかったときも、読み込みを片付けてから投げる', async () => {
    const { loading } = fakeDocument(1, { fail: true });

    await expect(renderPdfPages(new Uint8Array(), container(400))).rejects.toThrow('壊れた PDF');

    expect(loading.destroy).toHaveBeenCalledTimes(1);
  });
});
