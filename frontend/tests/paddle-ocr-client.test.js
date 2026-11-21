// 写真の文字の読み取り（src/paddle-ocr/）のうち、画面の側（client.js）。
// 写真を画素にするところ（縮め方・向き）と、worker への頼み方・受け取り方・
// 壊れたときの扱いを、偽物の Worker と canvas で縛る。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeWorker {
  static instances = [];

  constructor(url, options) {
    this.url = String(url);
    this.options = options;
    this.posted = [];
    this.terminated = false;
    FakeWorker.instances.push(this);
  }

  postMessage(data, transfer) {
    this.posted.push({ data, transfer });
  }

  terminate() {
    this.terminated = true;
  }

  /** worker からの返事を真似る。 */
  reply(data) {
    this.onmessage({ data });
  }
}

let drawn;
let bitmaps;

function fakeCanvas() {
  const canvas = {
    width: 0,
    height: 0,
    getContext: (type, options) => ({
      options,
      drawImage: (bitmap, x, y, w, h) => drawn.push({ bitmap, x, y, w, h }),
      getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    }),
  };
  return canvas;
}

let client;

beforeEach(async () => {
  vi.resetModules();
  FakeWorker.instances = [];
  drawn = [];
  bitmaps = [];
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('document', { createElement: () => fakeCanvas() });
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async (file, options) => {
      if (file.broken) throw new Error('decode');
      if (file.oldBrowser && options) throw new TypeError('unknown imageOrientation');
      const bitmap = { width: file.width, height: file.height, closed: false, close() { this.closed = true; } };
      bitmaps.push(bitmap);
      return bitmap;
    })
  );
  client = await import('../src/paddle-ocr/client.js');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('imageDataOf', () => {
  it('長いほうの辺を MAX_SIDE までに縮めて描き、写真は閉じる', async () => {
    const image = await client.imageDataOf({ width: 4000, height: 3000 });
    expect([image.width, image.height]).toEqual([client.MAX_SIDE, 2400]);
    expect(drawn[0]).toMatchObject({ x: 0, y: 0, w: client.MAX_SIDE, h: 2400 });
    expect(bitmaps[0].closed).toBe(true);
    expect(createImageBitmap).toHaveBeenCalledWith(expect.anything(), { imageOrientation: 'from-image' });
  });

  it('向きの指定を知らない古いブラウザでは、指定なしで開き直す', async () => {
    const image = await client.imageDataOf({ width: 800, height: 600, oldBrowser: true });
    expect(image.width).toBe(800);
    expect(createImageBitmap).toHaveBeenLastCalledWith({ width: 800, height: 600, oldBrowser: true });
  });

  it('小さい写真は大きくしない', async () => {
    const image = await client.imageDataOf({ width: 800, height: 600 });
    expect([image.width, image.height]).toEqual([800, 600]);
  });

  it('開けない写真は、その旨のエラーにする', async () => {
    await expect(client.imageDataOf({ broken: true })).rejects.toThrow(
      '写真を開けませんでした。JPEG か PNG の画像を選んでください。'
    );
  });
});

describe('readImageFile', () => {
  it('画素を worker へ渡し（写さずに移す）、返ってきた読みを返す', async () => {
    const reading = client.readImageFile({ width: 20, height: 10 });
    await vi.waitFor(() => expect(FakeWorker.instances[0]?.posted).toHaveLength(1));
    const worker = FakeWorker.instances[0];
    expect(worker.options).toEqual({ type: 'module' });
    expect(worker.url).toContain('ocr-worker.js');
    const { data, transfer } = worker.posted[0];
    expect(data.image).toMatchObject({ width: 20, height: 10 });
    expect(transfer).toEqual([data.image.data.buffer]);

    worker.reply({ id: 999, items: [] }); // 知らない番号の返事は無視する
    worker.reply({ id: data.id, items: [{ text: '和室' }] });
    await expect(reading).resolves.toEqual([{ text: '和室' }]);

    // 2 枚目は同じ worker に頼む。
    const second = client.readImageFile({ width: 20, height: 10 });
    await vi.waitFor(() => expect(worker.posted).toHaveLength(2));
    worker.reply({ id: worker.posted[1].data.id, error: 'だめ' });
    await expect(second).rejects.toThrow('だめ');
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it('worker が壊れたら、待っていたものを失敗にし、次は作り直す', async () => {
    const reading = client.readImageFile({ width: 20, height: 10 });
    await vi.waitFor(() => expect(FakeWorker.instances[0]?.posted).toHaveLength(1));
    FakeWorker.instances[0].onerror(new Event('error'));
    await expect(reading).rejects.toThrow('写真の読み取りが止まりました。もう一度お試しください。');
    expect(FakeWorker.instances[0].terminated).toBe(true);

    client.readImageFile({ width: 20, height: 10 });
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(2));
  });

  it('手放すと worker を止め、読んでいる途中のものは失敗にする', async () => {
    client.releaseReader(); // まだ何も無くても失敗しない
    const reading = client.readImageFile({ width: 20, height: 10 });
    await vi.waitFor(() => expect(FakeWorker.instances[0]?.posted).toHaveLength(1));
    client.releaseReader();
    await expect(reading).rejects.toThrow('写真の読み取りを止めました。');
    expect(FakeWorker.instances[0].terminated).toBe(true);
  });

  it('Worker の無いブラウザでは読めない', async () => {
    vi.stubGlobal('Worker', undefined);
    await expect(client.readImageFile({ width: 20, height: 10 })).rejects.toThrow(
      'このブラウザでは写真を読み取れません。'
    );
  });
});
