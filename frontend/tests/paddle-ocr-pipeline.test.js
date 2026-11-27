// 写真の文字の読み取り（src/paddle-ocr/）のうち、画像 1 枚を読む流れ（pipeline.js）。
// モデルは偽物で、渡された形と、読んだものの拾い方・捨て方を縛る。

import { describe, expect, it, vi } from 'vitest';
import { readText } from '../src/paddle-ocr/pipeline.js';

/** 64×32 の真っ白な画像。 */
const image = { width: 64, height: 32, data: new Uint8ClampedArray(64 * 32 * 4).fill(255) };

/** 文字の位置の地図に、横長のかたまりを 3 つ（左・中・右）置いた偽物の det。 */
function fakeDetect() {
  return vi.fn(async (data, dims) => {
    const [, , height, width] = dims;
    const map = new Float32Array(width * height);
    for (const x0 of [2, 24, 46]) {
      for (let y = 10; y < 16; y++) for (let x = x0; x < x0 + 14; x++) map[y * width + x] = 0.9;
    }
    return { data: map, dims: [1, 1, height, width] };
  });
}

/** 呼ばれた順に、決まった読み（番号の並びと確からしさ）を返す偽物の rec。 */
function fakeRecognize(readings) {
  let call = 0;
  return vi.fn(async () => {
    const [indices, p] = readings[call++];
    const classes = 4;
    const data = new Float32Array(indices.length * classes);
    indices.forEach((best, t) => {
      for (let c = 0; c < classes; c++) data[t * classes + c] = c === best ? p : (1 - p) / 3;
    });
    return { data, dims: [1, indices.length, classes] };
  });
}

describe('readText', () => {
  it('文字の位置を探し、かたまりごとに読み、確からしいものだけを返す', async () => {
    const detect = fakeDetect();
    const recognize = fakeRecognize([
      [[1, 0, 2], 0.9], // 「和室」
      [[3], 0.95], // 空白だけ → 捨てる
      [[1, 2], 0.3], // 確からしさが低い → 捨てる
    ]);
    const items = await readText(image, { detect, recognize, chars: ['和', '室', ' '] });

    // det には画像を 32 の倍数にそろえて渡す（64×32 はそのまま）。
    expect(detect).toHaveBeenCalledWith(expect.any(Float32Array), [1, 3, 32, 64]);
    expect(detect.mock.calls[0][0]).toHaveLength(3 * 32 * 64);
    // rec には高さ 48・幅は最小の 320 で渡す。
    expect(recognize).toHaveBeenCalledTimes(3);
    expect(recognize.mock.calls[0][1]).toEqual([1, 3, 48, 320]);

    expect(items).toEqual([
      { text: '和室', score: expect.closeTo(0.9), x0: expect.any(Number), y0: expect.any(Number), x1: expect.any(Number), y1: expect.any(Number) },
    ]);
    expect(items[0].x0).toBeLessThan(2);
    expect(items[0].x1).toBeGreaterThan(16);
  });
});
