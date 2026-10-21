// 書籍スキャン PDF 結合ツール: スキャン画像の検査。
//
// 合成した画像（白い紙に黒い横線・縦線を「文字の行」として引いたもの）で、
// 傾き・中身の範囲・すじ・白紙の測り方と、頁どうしの見比べ方を縛る。

import { describe, expect, it } from 'vitest';
import {
  compareScans,
  estimateSkew,
  measurePage,
  median,
  otsuThreshold,
  shortTextBoxes,
  toGray,
} from '../src/pdf-book-merger/image-checks.js';

const W = 400;
const H = 560;

function blankImage(width = W, height = H, paper = 245) {
  return { width, height, gray: new Uint8Array(width * height).fill(paper) };
}

function dot(image, x, y, value = 20) {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= image.width || yi >= image.height) return;
  image.gray[yi * image.width + xi] = value;
}

/**
 * 文字の行を、傾けて描く（画面上で時計回りに degrees 度）。
 * 横書きなら横の行、縦書きなら縦の列を並べる。
 */
function textPage({ degrees = 0, vertical = false, left = 60, top = 70, right = 340, bottom = 490 } = {}) {
  const image = blankImage();
  const t = Math.tan((degrees * Math.PI) / 180);
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  if (!vertical) {
    for (let y = top; y <= bottom; y += 14) {
      for (let x = left; x <= right; x++) {
        // 字の切れ目を作る（文字らしく、ところどころ空ける）。
        if (x % 9 === 0) continue;
        for (let k = 0; k < 4; k++) dot(image, x, y + k + (x - cx) * t);
      }
    }
  } else {
    for (let x = left; x <= right; x += 16) {
      for (let y = top; y <= bottom; y++) {
        if (y % 9 === 0) continue;
        for (let k = 0; k < 4; k++) dot(image, x + k - (y - cy) * t, y);
      }
    }
  }
  return image;
}

describe('otsuThreshold / toGray / median', () => {
  it('インクと紙の間で分ける', () => {
    const gray = new Uint8Array(1000).fill(240);
    gray.fill(30, 0, 200);
    const threshold = otsuThreshold(gray);

    expect(threshold).toBeGreaterThanOrEqual(30);
    expect(threshold).toBeLessThan(240);
  });

  it('白紙に近い頁でも、紙のむらをインクと数えない', () => {
    const gray = new Uint8Array(1000).fill(250);
    gray.fill(235, 0, 500);

    expect(otsuThreshold(gray)).toBeLessThanOrEqual(170);
  });

  it('RGBA を明るさにする', () => {
    expect([...toGray(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255]))]).toEqual([
      255, 0, 76,
    ]);
  });

  it('中央値', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('measurePage', () => {
  it('白紙の頁', () => {
    const result = measurePage(blankImage());

    expect(result.blank).toBe(true);
    expect(result.box).toBeNull();
  });

  it('真っすぐな頁は、傾き 0・中身の範囲を割合で返す', () => {
    const result = measurePage(textPage());

    expect(result.blank).toBe(false);
    expect(Math.abs(result.skew.angle)).toBeLessThan(0.15);
    expect(result.skew.direction).toBe('horizontal');
    expect(result.box.left).toBeCloseTo(60 / W, 1);
    expect(result.box.right).toBeCloseTo(341 / W, 1);
    expect(result.box.top).toBeCloseTo(70 / H, 1);
    expect(result.streaks).toBe(0);
  });

  it.each([1.5, -2])('横書きの傾き %s°', (degrees) => {
    const { skew } = measurePage(textPage({ degrees }));

    expect(skew.angle).toBeCloseTo(degrees, 0);
    expect(Math.abs(skew.angle - degrees)).toBeLessThan(0.2);
    expect(skew.sharpness).toBeGreaterThan(1.15);
  });

  it('縦書きの傾きも、列の向きから測る', () => {
    const { skew } = measurePage(textPage({ degrees: 1.2, vertical: true }));

    expect(skew.direction).toBe('vertical');
    expect(Math.abs(skew.angle - 1.2)).toBeLessThan(0.2);
  });

  it('端から端まで通る線を、すじとして数える', () => {
    const image = textPage();
    for (let y = 0; y < H; y++) dot(image, 200, y, 0);
    for (let y = 0; y < H; y++) dot(image, 201, y, 0);

    expect(measurePage(image).streaks).toBe(1);
  });

  it('点が少なすぎれば、傾きは測らない', () => {
    expect(estimateSkew({ x: new Int32Array(5), y: new Int32Array(5), length: 5 })).toEqual({
      angle: 0,
      sharpness: 1,
      direction: 'horizontal',
    });
  });
});

describe('compareScans', () => {
  const box = (dx = 0, dy = 0) => ({ left: 0.15 + dx, right: 0.85 + dx, top: 0.12 + dy, bottom: 0.88 + dy });
  const page = (key, side, extra = {}) => ({
    key,
    side,
    size: { width: 364, height: 515 },
    measure: {
      blank: false,
      box: box(),
      skew: { angle: 0.1, sharpness: 2, direction: 'horizontal' },
      streaks: 0,
      ...extra.measure,
    },
    ...(extra.size ? { size: extra.size } : {}),
  });
  const kinds = (issues, key) => (issues.get(key) || []).map((issue) => issue.kind);

  it('揃っていれば何も指摘しない', () => {
    const pages = ['1', '2', '3', '4', '5', '6'].map((n) => page(n, Number(n) % 2 ? 'odd' : 'even'));

    expect(compareScans(pages).size).toBe(0);
  });

  it('傾き・すじ・白紙を、その頁に付ける', () => {
    const issues = compareScans([
      page('a', 'odd', { measure: { skew: { angle: -0.9, sharpness: 1.8, direction: 'horizontal' } } }),
      page('b', 'odd', { measure: { streaks: 2 } }),
      page('c', 'odd', { measure: { blank: true, box: null } }),
      // 文字の並びがぼやけた頁（写真など）の傾きは当てにしない。
      page('d', 'odd', { measure: { skew: { angle: 3, sharpness: 1.02, direction: 'horizontal' } } }),
    ]);

    expect(kinds(issues, 'a')).toEqual(['skew']);
    expect(issues.get('a')[0].message).toBe('0.9° 左に傾いています');
    expect(kinds(issues, 'b')).toEqual(['streak']);
    expect(kinds(issues, 'c')).toEqual(['blank']);
    expect(issues.get('c')[0].level).toBe('info');
    expect(kinds(issues, 'd')).toEqual([]);
  });

  it('大きさ・向きが他と違う頁', () => {
    const pages = ['1', '2', '3', '4'].map((n) => page(n, 'odd'));
    pages.push(page('big', 'odd', { size: { width: 380, height: 515 } }));
    pages.push(page('wide', 'odd', { size: { width: 515, height: 364 } }));
    const issues = compareScans(pages);

    expect(kinds(issues, 'big')).toEqual(['size']);
    expect(kinds(issues, 'wide')).toEqual(['orientation']);
  });

  it('中身の位置のずれは、同じ側の頁どうしで比べる', () => {
    const pages = [
      // 偶数頁は余白が左右逆なので、奇数頁と位置が違っていて正しい。
      ...['2', '4', '6'].map((n) => page(n, 'even', { measure: { box: box(-0.05) } })),
      ...['1', '3', '5'].map((n) => page(n, 'odd')),
      page('7', 'odd', { measure: { box: box(0.05) } }),
      page('9', 'odd', { measure: { box: box(0, -0.04) } }),
    ];
    const issues = compareScans(pages);

    expect([...issues.keys()].sort()).toEqual(['7', '9']);
    expect(issues.get('7')[0].message).toContain('右へ 5%');
    expect(issues.get('9')[0].message).toContain('上へ 4%');
  });

  it('上下の片側だけが動いたのは、中身が短いだけなのでずれとしない', () => {
    const pages = ['1', '3', '5'].map((n) => page(n, 'odd'));
    pages.push(page('7', 'odd', { measure: { box: { ...box(), bottom: 0.5 } } }));

    expect(compareScans(pages).size).toBe(0);
  });
});

describe('shortTextBoxes', () => {
  /** 横に長い帯（余白）に、黒い四角を「字」として置く。 */
  function strip(glyphs) {
    const image = blankImage(600, 120);
    for (const [x0, y0, w, h] of glyphs) {
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) dot(image, x, y);
    }
    return image;
  }

  it('ぽつんと置かれた番号を、1 つのかたまりとして切り出す', () => {
    // 「12」: 字の間は字の高さより狭いので、1 つにつなげる。
    const boxes = shortTextBoxes(strip([[290, 60, 10, 20], [304, 60, 10, 20]]));

    expect(boxes).toEqual([{ x0: 290, y0: 60, x1: 314, y1: 80 }]);
  });

  it('長くつながる本文・柱の行は外し、柱の端の番号だけを残す', () => {
    const header = Array.from({ length: 20 }, (_, i) => [40 + i * 14, 20, 12, 20]);
    const boxes = shortTextBoxes(strip([...header, [540, 20, 12, 20]]));

    expect(boxes).toEqual([{ x0: 540, y0: 20, x1: 552, y1: 40 }]);
  });

  it('紙のごみと、帯の縁に触れているもの（裁断の影）は外す', () => {
    expect(shortTextBoxes(strip([[100, 50, 3, 3], [0, 30, 8, 20]]))).toEqual([]);
  });

  it('上から下まで通るすじがあっても、番号を見落とさない', () => {
    const boxes = shortTextBoxes(strip([[400, 0, 3, 120], [290, 60, 10, 20]]));

    expect(boxes).toEqual([{ x0: 290, y0: 60, x1: 300, y1: 80 }]);
  });

  it('多すぎるときは、左右の端と中央に近いものから選ぶ', () => {
    const glyphs = [20, 160, 220, 296, 380, 440, 560].map((x) => [x, 50, 10, 20]);
    const boxes = shortTextBoxes(strip(glyphs), { maxBoxes: 3 });

    expect(boxes.map((box) => box.x0).sort((a, b) => a - b)).toEqual([20, 296, 560]);
  });
});
