// @vitest-environment jsdom
//
// 書籍スキャン PDF 結合ツール: OCR（ocr.js）の用意と手放し。Tesseract.js は
// 偽物に差し替え、worker を作る・止めることだけを確かめる。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const schedulers = [];
const gates = [];
vi.mock('tesseract.js', () => ({
  OEM: { LSTM_ONLY: 1 },
  PSM: { SINGLE_LINE: 7 },
  // 待たせたいときは、gates に Promise を積む（呼ばれた順に 1 つずつ待つ）。
  createWorker: async () => {
    await gates.shift();
    return { setParameters: async () => {} };
  },
  createScheduler: () => {
    const scheduler = { workers: 0, terminated: false };
    scheduler.addWorker = () => scheduler.workers++;
    scheduler.terminate = async () => {
      scheduler.terminated = true;
    };
    schedulers.push(scheduler);
    return scheduler;
  },
}));
vi.mock('tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url', () => ({ default: '/core.js' }));
vi.mock('tesseract.js/dist/worker.min.js?url', () => ({ default: '/worker.js' }));
vi.mock('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz?url', () => ({ default: '/eng.gz' }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ GlobalWorkerOptions: {} }));
vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => ({ default: 'worker.js' }));

let ocr;

beforeEach(async () => {
  vi.resetModules();
  schedulers.length = 0;
  gates.length = 0;
  ocr = await import('../src/pdf-book-merger/ocr.js');
});

describe('OCR の用意と手放し', () => {
  it('用意したものは使い回し、手放すと worker を止め、次は用意し直す', async () => {
    const first = await ocr.prepareOcr();
    expect(await ocr.prepareOcr()).toBe(first);
    expect(first.workers).toBe(2);

    await ocr.releaseOcr();
    expect(first.terminated).toBe(true);

    const second = await ocr.prepareOcr();
    expect(second).not.toBe(first);
    expect(schedulers).toHaveLength(2);
  });

  it('止め損ねても失敗にせず、次は用意し直す', async () => {
    const first = await ocr.prepareOcr();
    first.terminate = async () => {
      throw new Error('terminate');
    };

    await expect(ocr.releaseOcr()).resolves.toBeUndefined();
    expect(await ocr.prepareOcr()).not.toBe(first);
  });

  it('用意している途中に手放して、その用意が失敗しても、あとで用意し直したものは残す', async () => {
    let fail;
    gates.push(new Promise((_, reject) => (fail = reject)));
    const first = ocr.prepareOcr();
    first.catch(() => {});
    // 1 つ目の worker を待っているところまで進める（テストの偽物は、読み込みが
    // 重なると本物の Tesseract.js が返ることがあるので、重ねない）。
    await vi.waitFor(() => expect(gates).toHaveLength(0));
    const releasing = ocr.releaseOcr();
    // 前の用意（1 つ目の worker を待っている）とは別に、用意し直す。
    const second = ocr.prepareOcr();
    fail(new Error('network'));
    await expect(first).rejects.toThrow('network');
    await expect(releasing).resolves.toBeUndefined();

    // 失敗した前の用意が、あとの用意を消さない。
    const ready = await second;
    expect(ocr.prepareOcr()).toBe(second);
    await ocr.releaseOcr();
    expect(ready.terminated).toBe(true);
  });

  it('用意に失敗したら、次に呼んだときに用意し直す', async () => {
    let fail;
    gates.push(new Promise((_, reject) => (fail = reject)));
    const first = ocr.prepareOcr();
    fail(new Error('network'));
    await expect(first).rejects.toThrow('network');

    expect(await ocr.prepareOcr()).toBeTruthy();
  });

  it('用意していなければ、手放すものは無い', async () => {
    await ocr.releaseOcr();
    expect(schedulers).toHaveLength(0);
  });
});
