// @vitest-environment jsdom
//
// PDF 結合ツール: OCR（ocr.js）。
//
// Tesseract.js は差し替え、worker を用意する順番と、失敗したときの扱い、
// 読んだかたまりの数え方を確かめる。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tesseract = vi.hoisted(() => ({
  /** createWorker の呼び出しごとの { resolve, reject, worker }。 */
  pending: [],
  scheduler: null,
}));

vi.mock('tesseract.js', () => ({
  OEM: { LSTM_ONLY: 1 },
  PSM: { SINGLE_LINE: '7' },
  createScheduler: () => tesseract.scheduler,
  createWorker: () =>
    new Promise((resolve, reject) => {
      const worker = {
        setParameters: vi.fn().mockResolvedValue({}),
        terminate: vi.fn().mockResolvedValue({}),
      };
      tesseract.pending.push({ resolve: () => resolve(worker), reject, worker });
    }),
}));

let prepareOcr;
let readStrip;
let boxesReadSoFar;
let releaseOcr;
let keepDarkest;
let hasLightInk;

beforeEach(async () => {
  tesseract.pending = [];
  tesseract.scheduler = { addWorker: vi.fn() };
  vi.resetModules();
  ({ prepareOcr, readStrip, boxesReadSoFar, releaseOcr, keepDarkest, hasLightInk } = await import(
    '../src/pdf-book-merger/ocr.js'
  ));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** createWorker が呼ばれるまで待つ（tesseract.js の読み込みを挟むので）。 */
async function workersRequested(count) {
  await vi.waitFor(() => expect(tesseract.pending).toHaveLength(count));
}

/** 約束が決着しているか（決着していなければ 'pending'）。 */
async function state(promise) {
  const pending = Symbol('pending');
  const result = await Promise.race([promise.then(() => 'resolved', () => 'rejected'), Promise.resolve(pending)]);
  return result === pending ? 'pending' : result;
}

describe('prepareOcr', () => {
  it('worker を同時に用意し、1 つ目が用意できたところで使い始める', async () => {
    const ready = prepareOcr();
    // 1 つ目を待たずに、2 つ目も頼んでいる。
    await workersRequested(2);
    expect(await state(ready)).toBe('pending');

    tesseract.pending[1].resolve();
    await expect(ready).resolves.toBe(tesseract.scheduler);
    expect(tesseract.scheduler.addWorker).toHaveBeenCalledTimes(1);
    expect(tesseract.scheduler.addWorker).toHaveBeenCalledWith(tesseract.pending[1].worker);
    expect(tesseract.pending[1].worker.setParameters).toHaveBeenCalledWith(
      expect.objectContaining({ tessedit_char_whitelist: '0123456789-()' })
    );

    // 残りも、用意できたら加わる。
    tesseract.pending[0].resolve();
    await vi.waitFor(() => expect(tesseract.scheduler.addWorker).toHaveBeenCalledTimes(2));
    // 用意は 1 度だけ。
    expect(prepareOcr()).toBe(ready);
  });

  it('1 つが用意できなくても、ほかが用意できれば使える', async () => {
    const ready = prepareOcr();
    await workersRequested(2);
    tesseract.pending[0].reject(new Error('first'));
    await Promise.resolve();
    expect(await state(ready)).toBe('pending');
    tesseract.pending[1].resolve();
    await expect(ready).resolves.toBe(tesseract.scheduler);
  });

  it('1 つも用意できなければ最初の失敗を返し、次の呼び出しでやり直す', async () => {
    const ready = prepareOcr();
    await workersRequested(2);
    tesseract.pending[1].reject(new Error('first'));
    tesseract.pending[0].reject(new Error('second'));
    await expect(ready).rejects.toThrow('first');

    const again = prepareOcr();
    expect(again).not.toBe(ready);
    await workersRequested(4);
    tesseract.pending[2].resolve();
    await expect(again).resolves.toBe(tesseract.scheduler);
  });

  it('設定できなかった worker は止めて、使わない', async () => {
    const ready = prepareOcr();
    await workersRequested(2);
    const [broken, fine] = tesseract.pending;
    broken.worker.setParameters.mockRejectedValue(new Error('setParameters'));
    broken.worker.terminate.mockRejectedValue(new Error('terminate'));
    broken.resolve();
    await vi.waitFor(() => expect(broken.worker.terminate).toHaveBeenCalled());
    expect(await state(ready)).toBe('pending');

    fine.resolve();
    await expect(ready).resolves.toBe(tesseract.scheduler);
    expect(tesseract.scheduler.addWorker).toHaveBeenCalledTimes(1);
    expect(tesseract.scheduler.addWorker).toHaveBeenCalledWith(fine.worker);
  });
});

describe('releaseOcr', () => {
  it('用意したものを止め、次は用意し直す', async () => {
    tesseract.scheduler.terminate = vi.fn().mockResolvedValue();
    const ready = prepareOcr();
    await workersRequested(2);
    tesseract.pending.forEach((pending) => pending.resolve());
    await ready;

    await releaseOcr();
    expect(tesseract.scheduler.terminate).toHaveBeenCalledTimes(1);
    expect(prepareOcr()).not.toBe(ready);
  });

  it('止め損ねても失敗にしない（次に読むときは、新しく用意する）', async () => {
    tesseract.scheduler.terminate = vi.fn().mockRejectedValue(new Error('terminate'));
    const ready = prepareOcr();
    await workersRequested(2);
    tesseract.pending[0].resolve();
    await ready;

    await expect(releaseOcr()).resolves.toBeUndefined();
  });

  it('用意している途中に手放して、その用意が失敗しても、あとで用意し直したものは残す', async () => {
    tesseract.scheduler.terminate = vi.fn().mockResolvedValue();
    const first = prepareOcr();
    first.catch(() => {});
    await workersRequested(2);
    const releasing = releaseOcr();
    const second = prepareOcr();
    await workersRequested(4);
    tesseract.pending[0].reject(new Error('network'));
    tesseract.pending[1].reject(new Error('network'));
    await expect(first).rejects.toThrow('network');
    // 用意できなかったので、止めるものは無い。
    await expect(releasing).resolves.toBeUndefined();
    expect(tesseract.scheduler.terminate).not.toHaveBeenCalled();

    // 失敗した前の用意が、あとの用意を消さない。
    tesseract.pending[2].resolve();
    await second;
    expect(prepareOcr()).toBe(second);
  });

  it('用意していなければ、手放すものは無い', async () => {
    await expect(releaseOcr()).resolves.toBeUndefined();
  });
});

/** 切り出しに使う canvas の 2D の偽物（jsdom の canvas は描けないので）。 */
function cropContextMock() {
  return {
    fillRect() {},
    drawImage() {},
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255, 170, 170, 170, 255]) }),
    putImageData: vi.fn(),
  };
}

let cropContext;

/**
 * 余白の帯の canvas の代わり。白地に、黒い四角（数字のかたまりの代わり）を
 * 横に並べて置く。
 */
function stripCanvas(blocks, { dots = false } = {}) {
  const width = 400;
  const height = 60;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const paint = (x0, x1, value) => {
    for (let y = 20; y < 40; y++) {
      for (let x = x0; x < x1; x++) data.fill(value, (y * width + x) * 4, (y * width + x) * 4 + 3);
    }
  };
  blocks.forEach((x0) => {
    paint(x0, x0 + 12, 0);
    // dots: 両側に灰色の丸（「● 2 ●」の飾り）の代わり。
    if (dots) {
      paint(x0 - 16, x0 - 4, 150);
      paint(x0 + 16, x0 + 28, 150);
    }
  });
  return { width, height, getContext: () => ({ getImageData: () => ({ data }) }) };
}

describe('readStrip', () => {
  beforeEach(() => {
    // jsdom の canvas は描けないので、切り出しに使う分だけ用意する。
    cropContext = cropContextMock();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(cropContext);
  });

  it('読んだかたまりを数える（記録に出す。読み取りの手間はこれに比例する）', async () => {
    tesseract.scheduler.addJob = vi.fn().mockResolvedValue({ data: { text: '12', confidence: 90 } });
    const reading = readStrip({ canvas: stripCanvas([100, 280]), top: 0.86, height: 0.14 });
    await workersRequested(2);
    tesseract.pending.forEach((pending) => pending.resolve());
    const items = await reading;

    expect(items.map((item) => item.text)).toEqual(['12', '12']);
    // かたまりごとに 3 通りの大きさで読む。
    expect(tesseract.scheduler.addJob).toHaveBeenCalledTimes(6);
    expect(boxesReadSoFar()).toBe(2);

    await readStrip({ canvas: stripCanvas([]), top: 0, height: 0.14 });
    expect(boxesReadSoFar()).toBe(2);
  });
});

describe('灰色の飾りのある頁番号', () => {
  beforeEach(() => {
    cropContext = cropContextMock();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(cropContext);
  });

  it('濃い字の色と白の真ん中より薄い画素を白にする（濃い字だけを残す。ごみの点 1 つには引きずられない）', () => {
    const pixel = (v) => [v, v, v, 255];
    // 黒い字（0）が 60 画素・灰色の丸（170）が 60 画素・白地・ごみの点はなし。
    const data = new Uint8ClampedArray([...Array(60)].flatMap(() => pixel(0)).concat(
      [...Array(60)].flatMap(() => pixel(170)),
      pixel(255)
    ));
    keepDarkest(data);
    expect(data[0]).toBe(0);
    expect(data[60 * 4]).toBe(255);
    // 灰色の字（120）が 99 画素に、黒いごみの点（0）が 1 つ。字は消さない。
    const grey = new Uint8ClampedArray(pixel(0).concat([...Array(99)].flatMap(() => pixel(120))));
    keepDarkest(grey);
    expect(grey[4]).toBe(120);
    // 白だけなら何もしない。
    const white = new Uint8ClampedArray(pixel(255));
    keepDarkest(white);
    expect([...white]).toEqual(pixel(255));
  });

  it('数字と読めたのに自信が足りないかたまりは、濃い字だけを残して読み直す（「● 2 ●」の丸を消す）', async () => {
    // 丸ごと読ませると、字は読めても自信が 0 になる。丸を消すと読める。
    let calls = 0;
    tesseract.scheduler.addJob = vi.fn(async () => {
      calls++;
      return { data: calls <= 3 ? { text: '2', confidence: 0 } : { text: '2', confidence: 96 } };
    });
    const before = boxesReadSoFar();
    const reading = readStrip({ canvas: stripCanvas([180], { dots: true }), top: 0.86, height: 0.14 });
    await workersRequested(2);
    tesseract.pending.forEach((pending) => pending.resolve());
    const items = await reading;

    expect(items.map((item) => item.text)).toEqual(['2']);
    expect(tesseract.scheduler.addJob).toHaveBeenCalledTimes(6);
    // 読み直しの 3 回だけ、薄いところを白にしてから読ませる。
    expect(cropContext.putImageData).toHaveBeenCalledTimes(3);
    const [[whitened]] = cropContext.putImageData.mock.calls;
    expect([...whitened.data]).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
    // 読み直したかたまりは 2 つと数える（読み取りの手間に比例するように）。
    expect(boxesReadSoFar() - before).toBe(2);
  });

  it('数字と読めないかたまり（和文・罫線など）は読み直さない', async () => {
    tesseract.scheduler.addJob = vi.fn().mockResolvedValue({ data: { text: '', confidence: 0 } });
    const reading = readStrip({ canvas: stripCanvas([180]), top: 0.86, height: 0.14 });
    await workersRequested(2);
    tesseract.pending.forEach((pending) => pending.resolve());
    expect(await reading).toEqual([]);
    expect(tesseract.scheduler.addJob).toHaveBeenCalledTimes(3);
    expect(cropContext.putImageData).not.toHaveBeenCalled();
  });

  it('読み直しても読めなければ、空にする（読み直したかたまりは 2 つと数える）', async () => {
    tesseract.scheduler.addJob = vi.fn().mockResolvedValue({ data: { text: '7', confidence: 10 } });
    const before = boxesReadSoFar();
    const reading = readStrip({ canvas: stripCanvas([180], { dots: true }), top: 0.86, height: 0.14 });
    await workersRequested(2);
    tesseract.pending.forEach((pending) => pending.resolve());
    expect(await reading).toEqual([]);
    expect(tesseract.scheduler.addJob).toHaveBeenCalledTimes(6);
    expect(cropContext.putImageData).toHaveBeenCalledTimes(3);
    expect(boxesReadSoFar() - before).toBe(2);
  });

  it('一様に濃いかたまり（罫線・ごみ）は、自信の低い数字と読めても読み直さない（「1」と読み違えないように）', async () => {
    tesseract.scheduler.addJob = vi.fn().mockResolvedValue({ data: { text: '1', confidence: 30 } });
    const reading = readStrip({ canvas: stripCanvas([180]), top: 0.86, height: 0.14 });
    await workersRequested(2);
    tesseract.pending.forEach((pending) => pending.resolve());
    expect(await reading).toEqual([]);
    expect(tesseract.scheduler.addJob).toHaveBeenCalledTimes(3);
  });

  it('灰色のインクがまとまってあるかを、帯の画素で見る', () => {
    const image = { width: 4, gray: new Uint8Array([0, 0, 170, 255, 0, 0, 170, 255]) };
    expect(hasLightInk(image, { x0: 0, y0: 0, x1: 4, y1: 2 })).toBe(true);
    expect(hasLightInk(image, { x0: 0, y0: 0, x1: 2, y1: 2 })).toBe(false);
    expect(hasLightInk(image, { x0: 3, y0: 0, x1: 4, y1: 2 })).toBe(false);
  });
});
