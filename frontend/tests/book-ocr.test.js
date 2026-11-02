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

beforeEach(async () => {
  tesseract.pending = [];
  tesseract.scheduler = { addWorker: vi.fn() };
  vi.resetModules();
  ({ prepareOcr, readStrip, boxesReadSoFar } = await import('../src/pdf-book-merger/ocr.js'));
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

/**
 * 余白の帯の canvas の代わり。白地に、黒い四角（数字のかたまりの代わり）を
 * 横に並べて置く。
 */
function stripCanvas(blocks) {
  const width = 400;
  const height = 60;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  blocks.forEach((x0) => {
    for (let y = 20; y < 40; y++) {
      for (let x = x0; x < x0 + 12; x++) data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
    }
  });
  return { width, height, getContext: () => ({ getImageData: () => ({ data }) }) };
}

describe('readStrip', () => {
  beforeEach(() => {
    // jsdom の canvas は描けないので、切り出しに使う分だけ用意する。
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillRect() {}, drawImage() {} });
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
