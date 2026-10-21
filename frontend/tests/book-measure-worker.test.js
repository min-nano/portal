// 書籍スキャン PDF 結合ツール: 画像を worker で測るところ（measure-client.js・
// measure-worker.js）。worker の偽物で、頼み方・受け取り方・壊れたときに
// その場で測り直すことを縛る。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { measurePage } from '../src/pdf-book-merger/image-checks.js';

const image = () => {
  const width = 80;
  const height = 100;
  const gray = new Uint8Array(width * height).fill(245);
  for (let y = 10; y < 90; y += 8) for (let x = 10; x < 70; x++) gray[y * width + x] = 20;
  return { width, height, gray };
};

/** measure-worker.js をそのまま動かす偽の Worker。 */
class FakeWorker {
  static instances = [];
  static broken = false;

  constructor(url, options) {
    this.url = String(url);
    this.options = options;
    this.terminated = false;
    FakeWorker.instances.push(this);
  }

  async postMessage(data) {
    if (FakeWorker.broken) {
      this.onerror?.(new Event('error'));
      return;
    }
    // worker の中で動く測り方（measure-worker.js）を、そのまま通す。worker の
    // self は beforeEach で用意した workerScope（読み込みは 1 度だけ）。
    await import('../src/pdf-book-merger/measure-worker.js');
    workerScope.postMessage = (reply) => setTimeout(() => this.onmessage?.({ data: reply }), 0);
    workerScope.onmessage({ data, origin: '' });
  }

  terminate() {
    this.terminated = true;
  }
}

let workerScope;

beforeEach(() => {
  vi.resetModules();
  workerScope = {};
  vi.stubGlobal('self', workerScope);
  FakeWorker.instances = [];
  FakeWorker.broken = false;
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('measure（worker で測る）', () => {
  it('worker で測り、同じ結果を返す（worker は 1 つを使い回す）', async () => {
    const { measure } = await import('../src/pdf-book-merger/measure-client.js');

    const [a, b] = await Promise.all([measure(image()), measure(image())]);

    expect(a).toEqual(measurePage(image()));
    expect(b).toEqual(a);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].url).toContain('measure-worker.js');
    expect(FakeWorker.instances[0].options).toEqual({ type: 'module' });
  });

  it('形の違うものは測らず、その理由で失敗する', async () => {
    const { measure } = await import('../src/pdf-book-merger/measure-client.js');

    await expect(measure({ width: 1, height: 1, gray: null })).rejects.toThrow('測る画像の形が正しくありません。');
    await expect(measure({ width: 2, height: 2, gray: new Uint8Array(3) })).rejects.toThrow(
      '測る画像の形が正しくありません。'
    );
  });

  it('よそから届いた知らせ・id の無い知らせには答えない', async () => {
    await import('../src/pdf-book-merger/measure-worker.js');
    const replies = [];
    workerScope.postMessage = (reply) => replies.push(reply);
    workerScope.location = { origin: 'https://portal.example' };

    workerScope.onmessage({ data: { id: 1, image: image() }, origin: 'https://evil.example' });
    workerScope.onmessage({ data: { image: image() }, origin: '' });
    expect(replies).toEqual([]);

    workerScope.onmessage({ data: { id: 2, image: image() }, origin: 'https://portal.example' });
    expect(replies.map((reply) => reply.id)).toEqual([2]);
  });

  it('形の確かめ（imageFrom）は、画素を写して返す', async () => {
    const { imageFrom } = await import('../src/pdf-book-merger/measure-worker.js');
    const original = image();

    const copied = imageFrom({ id: 1, image: original });

    expect(copied).toEqual(original);
    expect(copied.gray).not.toBe(original.gray);
    expect(imageFrom({ id: 1.5, image: original })).toBeNull();
    expect(imageFrom({ id: 1, image: { ...original, width: 0 } })).toBeNull();
    expect(imageFrom({ id: 1, image: { ...original, gray: [1, 2] } })).toBeNull();
    expect(imageFrom(null)).toBeNull();
  });

  it('worker が壊れたら、その場で測り直し、以後はその場で測る', async () => {
    FakeWorker.broken = true;
    const { measure } = await import('../src/pdf-book-merger/measure-client.js');

    expect(await measure(image())).toEqual(measurePage(image()));
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(await measure(image())).toEqual(measurePage(image()));
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it('worker を作れなければ、その場で測る', async () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('module workers are not supported');
        }
      }
    );
    const { measure } = await import('../src/pdf-book-merger/measure-client.js');

    expect(await measure(image())).toEqual(measurePage(image()));
  });
});
