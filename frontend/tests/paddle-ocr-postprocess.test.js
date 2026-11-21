// 写真の文字の読み取り（src/paddle-ocr/）のうち、モデルの出力を文字のかたまりと
// 文字列にするところ（postprocess.js）と、画素をモデルに渡す形にするところ
// （image-ops.js）。

import { describe, expect, it } from 'vitest';
import { toTensor, wholeImage } from '../src/paddle-ocr/image-ops.js';
import {
  DET_LIMIT,
  REC_MIN_WIDTH,
  ctcDecode,
  detInputSize,
  detectBoxes,
  parseDictionary,
  principalAngle,
  readingQuad,
  recInputWidth,
} from '../src/paddle-ocr/postprocess.js';

/** width × height の地図に、fill(x, y) が返す値を塗る。 */
function mapOf(width, height, fill) {
  const map = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) map[y * width + x] = fill(x, y);
  return map;
}

describe('detInputSize', () => {
  it('長いほうの辺を上限までに縮め、32 の倍数にそろえる', () => {
    expect(detInputSize(3200, 2400)).toEqual({ width: DET_LIMIT, height: 1216 });
    expect(detInputSize(2400, 3200)).toEqual({ width: 1216, height: DET_LIMIT });
  });

  it('上限より小さければ縮めず、32 の倍数にだけそろえる', () => {
    expect(detInputSize(1000, 700)).toEqual({ width: 992, height: 704 });
  });

  it('とても小さくても 32 は下回らない', () => {
    expect(detInputSize(10, 5)).toEqual({ width: 32, height: 32 });
  });
});

describe('principalAngle', () => {
  it('横に細長いものは、その傾き', () => {
    // 傾き 10° の向きに広がる点の、2 次のモーメント。
    const a = (10 * Math.PI) / 180;
    const along = 100;
    const across = 4;
    const cxx = along * Math.cos(a) ** 2 + across * Math.sin(a) ** 2;
    const cyy = along * Math.sin(a) ** 2 + across * Math.cos(a) ** 2;
    const cxy = (along - across) * Math.sin(a) * Math.cos(a);
    expect(principalAngle(cxx, cyy, cxy)).toBeCloseTo(a);
    expect(principalAngle(cxx, cyy, -cxy)).toBeCloseTo(-a);
  });

  it('縦に細長いもの（縦書き）は、90° 回した向き（縦長の長方形になる）', () => {
    expect(principalAngle(4, 100, 0)).toBeCloseTo(0);
    // 縦から 10° 傾いたもの：主軸は 80°。返すのは −10°。
    const a = (80 * Math.PI) / 180;
    const cxx = 100 * Math.cos(a) ** 2 + 4 * Math.sin(a) ** 2;
    const cyy = 100 * Math.sin(a) ** 2 + 4 * Math.cos(a) ** 2;
    const cxy = 96 * Math.sin(a) * Math.cos(a);
    expect(principalAngle(cxx, cyy, cxy)).toBeCloseTo(-(10 * Math.PI) / 180);
    expect(principalAngle(cxx, cyy, -cxy)).toBeCloseTo((10 * Math.PI) / 180);
  });

  it('細長くないもの（1 文字など）は傾けない', () => {
    expect(principalAngle(10, 9, 1)).toBe(0);
  });
});

describe('detectBoxes', () => {
  it('つながった文字らしい画素を、広げた長方形で囲む', () => {
    // 地図の (10..29, 10..13) に横長のかたまり。
    const map = mapOf(40, 30, (x, y) => (x >= 10 && x < 30 && y >= 10 && y < 14 ? 0.9 : 0));
    const [box, ...rest] = detectBoxes(map, 40, 30);
    expect(rest).toEqual([]);
    expect(box.score).toBeCloseTo((0.9 * 80) / (21 * 5)); // 太らせた画素は 0
    // 太らせた範囲（x 10〜31・y 10〜15 の手前まで）を、広げ幅 21×5×1.6/(2×26) ≈ 3.23 だけ広げる。
    expect(box).toMatchObject({ x0: 7, y0: 7, x1: 34, y1: 18 });
    expect(box.quad[0].x).toBeCloseTo(10 - 3.23, 1);
    expect(box.quad[2].y).toBeCloseTo(15 + 3.23, 1);
  });

  it('地図の 1 画素が元の画像の何画素かに合わせて、元の画像の座標で返す（画像の外へは出さない）', () => {
    const map = mapOf(40, 30, (x, y) => (x < 20 && y < 4 ? 0.9 : 0));
    const [box] = detectBoxes(map, 40, 30, { scaleX: 2, scaleY: 3, imageWidth: 80, imageHeight: 90 });
    expect(box).toMatchObject({ x0: 0, y0: 0 });
    expect(box.x1).toBe(Math.round((21 + 3.23) * 2));
    expect(box.quad[0]).toEqual({ x: expect.any(Number), y: expect.any(Number) });
    expect(box.quad[0].x).toBeLessThan(0); // 四隅そのものは画像の外にはみ出してよい
  });

  it('傾いたかたまりは、傾きに沿って囲む', () => {
    // 傾き約 11° の帯。
    const slope = 0.2;
    const map = mapOf(80, 40, (x, y) => (x >= 10 && x < 70 && Math.abs(y - (10 + slope * x)) < 2 ? 0.9 : 0));
    const [box] = detectBoxes(map, 80, 40);
    const [tl, tr] = box.quad;
    expect((tr.y - tl.y) / (tr.x - tl.x)).toBeCloseTo(slope, 1);
    // 縦横にそろえて囲むより、ずっと薄い。
    const height = Math.hypot(box.quad[3].x - tl.x, box.quad[3].y - tl.y);
    expect(height).toBeLessThan(15);
    expect(box.y1 - box.y0).toBeGreaterThan(20);
  });

  it('文字らしさの低いもの・細すぎるものは捨てる', () => {
    const map = mapOf(40, 30, (x, y) => {
      if (y >= 2 && y < 6 && x < 20) return 0.4; // しきい値は超えるが、平均が低い
      // 1 画素の線（太らせても高さ 2）。下の行もしきい値の手前まで文字らしい。
      if (y === 20 && x >= 5 && x < 30) return 1;
      if (y === 21 && x >= 5 && x < 31) return 0.29;
      return 0;
    });
    expect(detectBoxes(map, 40, 30)).toEqual([]);
  });

  it('別々のかたまりは別々に囲む（右下の端まで塗っても外へ出ない）', () => {
    const map = mapOf(30, 20, (x, y) => ((x < 8 || x >= 22) && y >= 16 ? 0.9 : 0));
    expect(detectBoxes(map, 30, 20)).toHaveLength(2);
  });
});

describe('readingQuad', () => {
  const quad = (w, h) => [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];

  it('横長はそのまま', () => {
    expect(readingQuad(quad(30, 10))).toEqual({ quad: quad(30, 10), width: 30, height: 10 });
  });

  it('縦長（高さが幅の 1.5 倍以上）は反時計回りに 90° 回す（上の文字が左に来る）', () => {
    const { quad: turned, width, height } = readingQuad(quad(10, 15));
    expect([width, height]).toEqual([15, 10]);
    expect(turned).toEqual([
      { x: 10, y: 0 },
      { x: 10, y: 15 },
      { x: 0, y: 15 },
      { x: 0, y: 0 },
    ]);
    expect(readingQuad(quad(10, 14)).width).toBe(10);
  });
});

describe('recInputWidth', () => {
  it('高さ 48 にそろえた幅と、詰め物を含めた幅（最小 320）', () => {
    expect(recInputWidth(100, 24)).toEqual({ drawWidth: 200, tensorWidth: REC_MIN_WIDTH });
    expect(recInputWidth(400, 24)).toEqual({ drawWidth: 800, tensorWidth: 800 });
    expect(recInputWidth(0.1, 100)).toEqual({ drawWidth: 1, tensorWidth: REC_MIN_WIDTH });
  });
});

describe('parseDictionary', () => {
  it('空の行は外し、最後の半角スペース（空白の文字）は残す', () => {
    expect(parseDictionary('　\n\n一\r\n丁\n ')).toEqual(['　', '一', '丁', ' ']);
  });
});

describe('ctcDecode', () => {
  const chars = ['洋', '室'];
  /** 時刻ごとにいちばん確からしい番号と、その確からしさ。 */
  function probs(steps) {
    const data = new Float32Array(steps.length * 3);
    steps.forEach(([best, p], t) => {
      for (let c = 0; c < 3; c++) data[t * 3 + c] = c === best ? p : (1 - p) / 2;
    });
    return data;
  }

  it('「文字なし」と、続けて同じ文字を外して読む', () => {
    const steps = [
      [0, 0.9],
      [1, 0.8],
      [1, 0.6],
      [0, 0.9],
      [2, 1],
      [0, 0.9],
      [2, 0.9],
    ];
    const result = ctcDecode(probs(steps), steps.length, 3, chars);
    expect(result.text).toBe('洋室室');
    expect(result.score).toBeCloseTo((0.8 + 1 + 0.9) / 3);
  });

  it('何も読めなければ空で、確からしさは 0', () => {
    expect(ctcDecode(probs([[0, 0.9]]), 1, 3, chars)).toEqual({ text: '', score: 0 });
  });
});

describe('toTensor', () => {
  /** 2×2 の画像（左上から 赤・緑・青・白）。 */
  const image = {
    width: 2,
    height: 2,
    data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]),
  };

  it('同じ大きさなら画素をそのまま、B・G・R の順に −1〜1 へそろえて並べる', () => {
    const tensor = toTensor(image, wholeImage(image), 2, 2);
    // B の面・G の面・R の面
    expect([...tensor]).toEqual([-1, -1, 1, 1, -1, 1, -1, 1, 1, -1, -1, 1]);
  });

  it('縮めるときは線形補間（画素の中心どうしを合わせる）', () => {
    const tensor = toTensor(image, wholeImage(image), 1, 1);
    // 中心は 4 画素の真ん中。R は (255 + 0 + 0 + 255) / 4。
    expect(tensor[2]).toBeCloseTo((127.5 / 255 - 0.5) / 0.5);
  });

  it('横幅の広い入れ物に書くと、右側はそのまま残る（詰め物）', () => {
    const tensor = toTensor(image, wholeImage(image), 1, 2, { tensor: new Float32Array(3 * 2 * 3), stride: 3 });
    expect(tensor[1]).toBe(0);
    expect(tensor[2]).toBe(0);
  });

  it('回した四隅なら、回して描く', () => {
    // 右の列（上が緑・下が白）だけを囲んだ縦長の四隅。
    const turned = readingQuad([
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
      { x: 1, y: 2 },
    ]).quad;
    // 上（緑）が左、下（白）が右に来る。
    const tensor = toTensor(image, turned, 2, 1);
    expect([tensor[0], tensor[1]]).toEqual([-1, 1]); // B: 緑は 0、白は 255
    expect([tensor[2], tensor[3]]).toEqual([1, 1]); // G
  });
});
