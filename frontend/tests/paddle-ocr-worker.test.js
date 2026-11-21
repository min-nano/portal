// 写真の文字の読み取り（src/paddle-ocr/）のうち、worker（ocr-worker.js）。
// onnxruntime-web とモデルのファイルは偽物にして、モデルの読み込み方（1 度だけ・
// 失敗したらやり直す）と、届いた知らせの受け方を縛る。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessions: [],
  createFails: false,
  readText: null,
}));

vi.mock('onnxruntime-web/wasm', () => ({
  env: { wasm: {} },
  Tensor: class {
    constructor(type, data, dims) {
      Object.assign(this, { type, data, dims });
    }
  },
  InferenceSession: {
    create: vi.fn(async (bytes, options) => {
      if (mocks.createFails) throw new Error('モデルを開けません');
      const session = {
        bytes,
        options,
        inputNames: ['x'],
        outputNames: ['out'],
        run: vi.fn(async (feeds) => ({ out: { data: feeds.x.data, dims: feeds.x.dims } })),
      };
      mocks.sessions.push(session);
      return session;
    }),
  },
}));
vi.mock('onnxruntime-web/ort-wasm-simd-threaded.wasm?url', () => ({ default: '/assets/ort.wasm' }));
vi.mock('pdfmarkdown-ppocrv5-models/detection/PP-OCRv5_mobile_det_infer.ort?url', () => ({
  default: '/assets/det.ort',
}));
vi.mock('pdfmarkdown-ppocrv5-models/recognition/PP-OCRv5_mobile_rec_infer.onnx?url', () => ({
  default: '/assets/rec.onnx',
}));
vi.mock('pdfmarkdown-ppocrv5-models/recognition/ppocrv5_dict.txt?url', () => ({
  default: '/assets/dict.txt',
}));
vi.mock('../src/paddle-ocr/pipeline.js', () => ({
  readText: (...args) => mocks.readText(...args),
}));

const image = () => ({ width: 2, height: 1, data: new Uint8ClampedArray(8) });

let worker;
let posted;
let fetched;

/** worker の self に知らせを送り、返事を待つ。 */
async function send(data, origin = '') {
  await worker.self.onmessage({ data, origin });
  return posted.at(-1);
}

beforeEach(async () => {
  vi.resetModules();
  mocks.sessions = [];
  mocks.createFails = false;
  mocks.readText = vi.fn(async () => [{ text: '洋室' }]);
  posted = [];
  fetched = [];
  const scope = {
    location: { href: 'https://portal.example/tools/x/', origin: 'https://portal.example' },
    postMessage: (message) => posted.push(message),
  };
  vi.stubGlobal('self', scope);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      fetched.push(url);
      if (url.endsWith('/missing')) return { ok: false, status: 404 };
      return {
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        text: async () => '一\n\n丁\n ',
      };
    })
  );
  const module = await import('../src/paddle-ocr/ocr-worker.js');
  worker = { module, self: scope };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ocr-worker', () => {
  it('最初に頼まれたときにモデルを読み込み、読んだものを返す（2 回目は使い回す）', async () => {
    const ort = await import('onnxruntime-web/wasm');
    const reply = await send({ id: 1, image: image() });

    expect(reply).toEqual({ id: 1, items: [{ text: '洋室' }] });
    expect(fetched.sort()).toEqual([
      'https://portal.example/assets/det.ort',
      'https://portal.example/assets/dict.txt',
      'https://portal.example/assets/rec.onnx',
    ]);
    expect(ort.env.wasm).toEqual({ numThreads: 1, wasmPaths: { wasm: 'https://portal.example/assets/ort.wasm' } });
    expect(mocks.sessions).toHaveLength(2);
    expect(mocks.sessions[0].options).toEqual({ executionProviders: ['wasm'], graphOptimizationLevel: 'all' });

    // readText には画像と、モデルを動かす関数・辞書が渡る。
    const [passedImage, models] = mocks.readText.mock.calls[0];
    expect(passedImage).toEqual(image());
    expect(models.chars).toEqual(['一', '丁', ' ']);
    const data = new Float32Array([0.5]);
    await expect(models.detect(data, [1, 1, 1, 1])).resolves.toEqual({ data, dims: [1, 1, 1, 1] });
    expect(mocks.sessions[0].run.mock.calls[0][0].x.type).toBe('float32');
    await models.recognize(data, [1, 1, 1, 1]);
    expect(mocks.sessions[1].run).toHaveBeenCalled();

    await send({ id: 2, image: image() });
    expect(fetched).toHaveLength(3);
  });

  it('モデルを読み込めなければ失敗を返し、次に頼まれたときに読み込み直す', async () => {
    mocks.createFails = true;
    expect(await send({ id: 1, image: image() })).toEqual({ id: 1, error: 'モデルを開けません' });

    mocks.createFails = false;
    expect(await send({ id: 2, image: image() })).toEqual({ id: 2, items: [{ text: '洋室' }] });
  });

  it('モデルのファイルを取れなければ、その旨を返す', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 404 }));
    expect(await send({ id: 1, image: image() })).toEqual({
      id: 1,
      error: '読み取りのモデルを読み込めませんでした（404）。',
    });
  });

  it('読み取りで投げられたものが Error でなくても、文字にして返す', async () => {
    mocks.readText = async () => {
      throw 'こわれた';
    };
    expect(await send({ id: 1, image: image() })).toEqual({ id: 1, error: 'こわれた' });
  });

  it('形の違う知らせには、番号があれば失敗を返し、無ければ黙る', async () => {
    expect(await send({ id: 1, image: { width: 2, height: 2, data: new Uint8ClampedArray(8) } })).toEqual({
      id: 1,
      error: '読む画像の形が正しくありません。',
    });
    posted = [];
    await send({ image: image() });
    expect(posted).toEqual([]);
  });

  it('ほかのところから送られた知らせは受けない', async () => {
    await send({ id: 1, image: image() }, 'https://evil.example');
    expect(posted).toEqual([]);
    await send({ id: 2, image: image() }, 'https://portal.example');
    expect(posted).toEqual([{ id: 2, items: [{ text: '洋室' }] }]);
  });
});

describe('imageFrom', () => {
  it('RGBA の画素と縦横の数が合っているものだけを受ける', () => {
    const { imageFrom } = worker.module;
    expect(imageFrom({ id: 1, image: image() })).toEqual(image());
    expect(imageFrom(null)).toBeNull();
    expect(imageFrom({ id: 'a', image: image() })).toBeNull();
    expect(imageFrom({ id: 1 })).toBeNull();
    expect(imageFrom({ id: 1, image: { ...image(), data: new Uint8Array(8) } })).toBeNull();
    expect(imageFrom({ id: 1, image: { ...image(), width: 0 } })).toBeNull();
    expect(imageFrom({ id: 1, image: { ...image(), height: 1.5 } })).toBeNull();
  });
});
