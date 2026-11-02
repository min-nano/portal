// @vitest-environment jsdom
//
// 書籍スキャン PDF 結合ツール: OCR（ocr.js）の用意と手放し。Tesseract.js は
// 偽物に差し替え、worker を作る・止めることだけを確かめる。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const schedulers = [];
vi.mock('tesseract.js', () => ({
  OEM: { LSTM_ONLY: 1 },
  PSM: { SINGLE_LINE: 7 },
  createWorker: async () => ({ setParameters: async () => {} }),
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

  it('用意していなければ、手放すものは無い', async () => {
    await ocr.releaseOcr();
    expect(schedulers).toHaveLength(0);
  });
});
