// PDF 結合ツール: JPEG の符号の表の作り直し（jpeg-optimize.js）。
//
// 縛ること:
//   - 書き直した JPEG の表と係数の符号が、libjpeg-turbo の `jpegtran -optimize`
//     と同じになる（tests/fixtures/jpeg/*.optimized.jpg がその出力。表は区切りの
//     まとめ方が違うだけなので、走査ごとの表の中身と係数の符号を比べる）
//   - 係数は 1 つも変わらない（sameCoefficients）
//   - 扱えない形・壊れたデータは投げ（rewriteJpeg）、optimizeJpeg は null を返す
//
// fixtures の JPEG は、ノイズを足したグラデーションを cjpeg（-quality 90）で
// 書いたもの: color（37×21・4:2:0）、gray（19×13）、restart（72×24・MCU ごとに
// リスタート。RST7 の後に RST0 へ戻る）、multiscan（color を 1 色ずつの 3 走査に
// したもの。走査の間に表を足す）、progressive（扱わない形）。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { optimalTable, optimizeJpeg, rewriteJpeg, sameCoefficients } from '../src/pdf-book-merger/jpeg-optimize.js';

const FIXTURES = resolve(import.meta.dirname, 'fixtures/jpeg');

function fixture(name) {
  return new Uint8Array(readFileSync(resolve(FIXTURES, name)));
}

/**
 * JPEG を走査ごとに分ける: [{tables:[表（番号つき）...], header, data}]。
 * 表は、その走査の前に置かれたもの（区切りのまとめ方によらず、1 つずつ）。
 */
function scansOf(bytes) {
  const scans = [];
  let tables = [];
  let pos = 2;
  for (;;) {
    const marker = bytes[pos + 1];
    if (marker === 0xd9) return scans;
    const length = (bytes[pos + 2] << 8) | bytes[pos + 3];
    const body = bytes.subarray(pos + 4, pos + 2 + length);
    pos += 2 + length;
    if (marker === 0xc4) {
      for (let at = 0; at < body.length; ) {
        const total = body.subarray(at + 1, at + 17).reduce((sum, count) => sum + count, 0);
        tables.push([...body.subarray(at, at + 17 + total)].join(','));
        at += 17 + total;
      }
    } else if (marker === 0xda) {
      let end = pos;
      while (!(bytes[end] === 0xff && bytes[end + 1] !== 0 && (bytes[end + 1] < 0xd0 || bytes[end + 1] > 0xd7))) end++;
      scans.push({ tables: tables.sort(), header: [...body], data: bytes.subarray(pos, end) });
      tables = [];
      pos = end;
    }
  }
}

/** 区切り（FF xx と長さ）を作る。 */
function segment(marker, body) {
  return [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body];
}

/** 符号の表を作る。lengths は {符号の長さ: [記号...]}。 */
function table(id, lengths) {
  const counts = Array.from({ length: 16 }, (_, i) => (lengths[i + 1] ?? []).length);
  return [id, ...counts, ...Object.values(lengths).flat()];
}

/** ビットの並び（'0101…'）を、1 で埋めて 0xFF の後に 0x00 を挟んだバイト列にする。 */
function entropy(bits) {
  const padded = bits + '1'.repeat((8 - (bits.length % 8)) % 8);
  const out = [];
  for (let i = 0; i < padded.length; i += 8) {
    const byte = parseInt(padded.slice(i, i + 8), 2);
    out.push(byte);
    if (byte === 0xff) out.push(0x00);
  }
  return out;
}

/** 8 の倍数の大きさの 1 色の画像の、SOF0。 */
function grayFrame(width = 8, height = 8, { marker = 0xc0, sampling = 0x11 } = {}) {
  return segment(marker, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, sampling, 0]);
}

/** DC は「0」= 記号 0、AC は「0」= ブロックの終わり（EOB）だけの表。 */
const SIMPLE_TABLES = segment(0xc4, [...table(0x00, { 1: [0] }), ...table(0x10, { 1: [0x00] })]);

const SCAN = segment(0xda, [1, 1, 0x00, 0, 63, 0]);

/** 手で組み立てた JPEG（SOI・…・EOI）。 */
function jpeg(...parts) {
  return Uint8Array.from([0xff, 0xd8, ...parts.flat(), 0xff, 0xd9]);
}

/** 1 ブロック（DC も AC も 0）の画像。 */
const TINY = jpeg(grayFrame(), SIMPLE_TABLES, SCAN, entropy('00'));

describe('rewriteJpeg（libjpeg-turbo と同じに書き直す）', () => {
  it.each(['color', 'gray', 'restart', 'multiscan'])('%s.jpg は jpegtran -optimize と同じ表と符号になる', (name) => {
    const original = fixture(`${name}.jpg`);
    const out = rewriteJpeg(original);
    const want = scansOf(fixture(`${name}.optimized.jpg`));
    const got = scansOf(out);

    expect(got.length).toBe(want.length);
    got.forEach((scan, i) => {
      expect(scan.tables).toEqual(want[i].tables);
      expect(scan.header).toEqual(want[i].header);
      expect(Buffer.from(scan.data).equals(Buffer.from(want[i].data))).toBe(true);
    });
    expect(out.length).toBeLessThan(original.length);
    expect(sameCoefficients(original, out)).toBe(true);
  });

  it('表のほかの区切り（APP0・DQT・SOF・DRI）は、そのままの順に写し、元の表は外す', () => {
    const markers = (bytes) => {
      const list = [];
      for (let pos = 2; bytes[pos + 1] !== 0xda; pos += 2 + ((bytes[pos + 2] << 8) | bytes[pos + 3])) {
        list.push(bytes[pos + 1]);
      }
      return list;
    };
    const original = fixture('restart.jpg');

    expect(markers(original)).toEqual([0xe0, 0xdb, 0xdb, 0xc0, 0xc4, 0xc4, 0xc4, 0xc4, 0xdd]);
    expect(markers(rewriteJpeg(original))).toEqual([0xe0, 0xdb, 0xdb, 0xc0, 0xdd, 0xc4]);
  });

  it('書き直したものをもう 1 度書き直すと、同じバイト列になる（1 つの区切りに表が何個あっても読める）', () => {
    const once = rewriteJpeg(fixture('color.jpg'));

    expect(Buffer.from(rewriteJpeg(once)).equals(Buffer.from(once))).toBe(true);
  });

  it('EOI の後ろのバイト列はそのまま残し、区切りの前の埋め草（0xFF の並び）は読み飛ばす', () => {
    const original = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xff, ...grayFrame(), ...SIMPLE_TABLES, ...SCAN, ...entropy('00'), 0xff, 0xff, 0xd9, 1, 2, 3,
    ]);
    const out = rewriteJpeg(original);

    expect([...out.subarray(-5)]).toEqual([0xff, 0xd9, 1, 2, 3]);
    expect(sameCoefficients(original, out)).toBe(true);
  });

  it('拡張の順次（SOF1）も、長い符号（10 ビット以上）も、AC が 63 個並んで EOB の無いブロックも読める', () => {
    // DC: 長さ 1〜9 の符号に記号 0〜8、長さ 10 の 2 つに記号 9・10。
    const dc = table(0x00, { 1: [0], 2: [1], 3: [2], 4: [3], 5: [4], 6: [5], 7: [6], 8: [7], 9: [8], 10: [9, 10] });
    const ac = table(0x10, { 1: [0x01], 2: [0x00] });
    // 1 つ目のブロック: DC は記号 10（1111111111 + 値 10 ビット）、AC は EOB。
    // 2 つ目のブロック: DC は記号 9（1111111110 + 値 9 ビット）、AC は 1 ビットの係数が 63 個。
    const bits = `1111111111${'1010101010'}10` + `1111111110${'010101010'}${'01'.repeat(63)}`;
    const original = jpeg(grayFrame(16, 8, { marker: 0xc1 }), segment(0xc4, [...dc, ...ac]), SCAN, entropy(bits));
    const out = rewriteJpeg(original);

    expect(sameCoefficients(original, out)).toBe(true);
  });

  it('16 ビットの符号に 15 ビットの値が続いても読める（読み足してから値を読む）', () => {
    // DC: 長さ 1〜15 の符号に記号 0〜14、長さ 16 の符号（1 が 15 個と 0）に記号 15。
    const lengths = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [i + 1, [i]]));
    const dc = table(0x00, lengths);
    // 先の 8 ブロック（2 ビットずつ）で、読み足した 32 ビットのうち 16 ビットを使う。
    // 9 つ目は読み足さずに 16 ビットの符号を読み、値の 15 ビットは読み足してから読む。
    const bits = '00'.repeat(8) + '1'.repeat(15) + '0' + '101010101010101' + '0';
    const original = jpeg(grayFrame(72, 8), segment(0xc4, [...dc, ...table(0x10, { 1: [0x00] })]), SCAN, entropy(bits));

    expect(sameCoefficients(original, rewriteJpeg(original))).toBe(true);
  });

  it('元の表より大きくなることもある（その形でも書ける。optimizeJpeg はそのまま使う）', () => {
    // 1 ビットの符号を 2 つとも使い切った表（1 だけの符号も使う）。作り直す表は
    // 「1 だけの符号」を使わないので、片方が 2 ビットになり、大きくなる。
    const tables = segment(0xc4, [...table(0x00, { 1: [0, 1] }), ...table(0x10, { 1: [0x00] })]);
    const blocks = 400;
    const bits = Array.from({ length: blocks }, (_, i) => (i % 2 ? '1' + '1' + '0' : '0' + '0')).join('');
    const original = jpeg(grayFrame(8, 8 * blocks), tables, SCAN, entropy(bits));
    const out = rewriteJpeg(original);

    expect(out.length).toBeGreaterThan(original.length);
    expect(sameCoefficients(original, out)).toBe(true);
    expect(optimizeJpeg(original)).toBeNull();
  });

  it.each([
    ['JPEG でない', Uint8Array.from([1, 2, 3, 4]), 'JPEG ではありません'],
    ['短すぎる', Uint8Array.from([0xff, 0xd8]), 'JPEG ではありません'],
    ['区切りの印が無い', Uint8Array.from([0xff, 0xd8, 0x00, 0x00]), '区切りが見つかりません'],
    ['埋め草のまま終わる', Uint8Array.from([0xff, 0xd8, 0xff, 0xff]), '区切りの並びが正しくありません'],
    ['走査の外に RST', Uint8Array.from([0xff, 0xd8, 0xff, 0xd0, 0xff, 0xd9]), '区切りの並びが正しくありません'],
    ['区切りの長さが短すぎる', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0xff, 0xd9]), '区切りの長さが正しくありません'],
    ['区切りの長さが長すぎる', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]), '区切りの長さが正しくありません'],
    ['区切りの長さの途中で終わる', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), '区切りの長さが正しくありません'],
    ['画像の情報が 2 つ', jpeg(grayFrame(), grayFrame()), '画像が 2 つあります'],
    ['プログレッシブ', fixture('progressive.jpg'), 'ハフマン符号の順次の JPEG ではありません'],
    ['行数を後で書く形（DNL）', jpeg(segment(0xdc, [0, 8])), 'ハフマン符号の順次の JPEG ではありません'],
    ['リスタートの間隔の長さ', jpeg(segment(0xdd, [0, 1, 0])), 'リスタートの間隔が正しくありません'],
    ['画像の情報より前の走査', jpeg(SIMPLE_TABLES, SCAN, entropy('00')), '画像の情報より前に走査があります'],
    ['表の種類', jpeg(segment(0xc4, table(0x20, { 1: [0] }))), '符号の表の番号が正しくありません'],
    ['表の番号', jpeg(segment(0xc4, table(0x04, { 1: [0] }))), '符号の表の番号が正しくありません'],
    ['表が途中で切れる', jpeg(segment(0xc4, table(0x00, { 1: [0] }).slice(0, 10))), '符号の表が途中で切れています'],
    ['表の符号が足りない', jpeg(segment(0xc4, table(0x00, { 1: [0, 1, 2] }))), '符号の表が壊れています'],
    ['画像の情報の長さ', jpeg(segment(0xc0, [8, 0, 8, 0, 8, 1, 1, 0x11])), '画像の情報が正しくありません'],
    ['色の数が 0', jpeg(segment(0xc0, [8, 0, 8, 0, 8, 0])), '画像の情報が正しくありません'],
    ['高さが 0', jpeg(segment(0xc0, [8, 0, 0, 0, 8, 1, 1, 0x11, 0])), '画像の大きさが分かりません'],
    ['幅が 0', jpeg(segment(0xc0, [8, 0, 8, 0, 0, 1, 1, 0x11, 0])), '画像の大きさが分かりません'],
    ['横の間引きが 0', jpeg(grayFrame(8, 8, { sampling: 0x01 })), '色の間引き方が正しくありません'],
    ['縦の間引きが 0', jpeg(grayFrame(8, 8, { sampling: 0x10 })), '色の間引き方が正しくありません'],
    ['横の間引きが 5', jpeg(grayFrame(8, 8, { sampling: 0x51 })), '色の間引き方が正しくありません'],
    ['縦の間引きが 5', jpeg(grayFrame(8, 8, { sampling: 0x15 })), '色の間引き方が正しくありません'],
    ['走査の色の数が 0', jpeg(grayFrame(), SIMPLE_TABLES, segment(0xda, [0, 0, 63, 0])), '走査の頭が正しくありません'],
    [
      '走査の色の数が 5',
      jpeg(grayFrame(), SIMPLE_TABLES, segment(0xda, [5, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 63, 0])),
      '走査の頭が正しくありません',
    ],
    ['走査の頭の長さ', jpeg(grayFrame(), SIMPLE_TABLES, segment(0xda, [1, 1, 0x00, 0, 63])), '走査の頭が正しくありません'],
    ['走査に無い色', jpeg(grayFrame(), SIMPLE_TABLES, segment(0xda, [1, 2, 0x00, 0, 63, 0])), '走査の色が正しくありません'],
    [
      '走査に同じ色が 2 度',
      jpeg(grayFrame(), SIMPLE_TABLES, segment(0xda, [2, 1, 0x00, 1, 0x00, 0, 63, 0])),
      '走査の色が正しくありません',
    ],
    ['DC の表が無い', jpeg(grayFrame(), SIMPLE_TABLES, segment(0xda, [1, 1, 0x10, 0, 63, 0])), '走査が使う符号の表がありません'],
    ['AC の表が無い', jpeg(grayFrame(), SIMPLE_TABLES, segment(0xda, [1, 1, 0x01, 0, 63, 0])), '走査が使う符号の表がありません'],
    ['走査の始まりが 0 でない', jpeg(grayFrame(), SIMPLE_TABLES, segment(0xda, [1, 1, 0x00, 1, 63, 0])), '順次の走査ではありません'],
    ['走査の終わりが 63 でない', jpeg(grayFrame(), SIMPLE_TABLES, segment(0xda, [1, 1, 0x00, 0, 62, 0])), '順次の走査ではありません'],
    ['走査が近似を重ねる', jpeg(grayFrame(), SIMPLE_TABLES, segment(0xda, [1, 1, 0x00, 0, 63, 1])), '順次の走査ではありません'],
    [
      '走査のまま終わる',
      Uint8Array.from([0xff, 0xd8, ...grayFrame(), ...SIMPLE_TABLES, ...SCAN, 0x3f, 0xff, 0x00]),
      '走査の終わりが見つかりません',
    ],
    // 4 ブロックでちょうど 1 バイト（埋め草なし）。5 つ目は区切りより先を読もうとする。
    ['係数が足りない', jpeg(grayFrame(40, 8), SIMPLE_TABLES, SCAN, entropy('00'.repeat(4))), '係数の符号が途中で切れています'],
    ['係数の後ろに余り', jpeg(grayFrame(), SIMPLE_TABLES, SCAN, entropy('00'), [0x12]), '係数の符号の後ろに余りがあります'],
    [
      '係数の後ろに RST',
      jpeg(grayFrame(), SIMPLE_TABLES, SCAN, entropy('00'), [0xff, 0xd0]),
      '係数の符号の後ろに余りがあります',
    ],
    [
      'リスタートの前に余り',
      jpeg(grayFrame(16, 8), segment(0xdd, [0, 1]), SIMPLE_TABLES, SCAN, entropy('00'), [0x12, 0xff, 0xd0], entropy('00')),
      '係数の符号の後ろに余りがあります',
    ],
    [
      'リスタートの番号違い',
      jpeg(grayFrame(16, 8), segment(0xdd, [0, 1]), SIMPLE_TABLES, SCAN, entropy('00'), [0xff, 0xd1], entropy('00')),
      'リスタートの区切りが見つかりません',
    ],
    [
      'リスタートが無い',
      jpeg(grayFrame(16, 8), segment(0xdd, [0, 1]), SIMPLE_TABLES, SCAN, entropy('0000')),
      'リスタートの区切りが見つかりません',
    ],
    ['表に無い符号（短い）', jpeg(grayFrame(), SIMPLE_TABLES, SCAN, entropy('1')), '表に無い符号があります'],
    [
      '表に無い符号（長い）',
      jpeg(
        grayFrame(),
        segment(0xc4, [...table(0x00, { 1: [0], 10: [1] }), ...table(0x10, { 1: [0x00] })]),
        SCAN,
        entropy('1111111111')
      ),
      '表に無い符号があります',
    ],
    [
      'DC の記号が 16',
      jpeg(grayFrame(), segment(0xc4, [...table(0x00, { 1: [16] }), ...table(0x10, { 1: [0x00] })]), SCAN, entropy('00')),
      'DC の記号が正しくありません',
    ],
    [
      'ブロックの係数が多すぎる（16 個の 0 が 4 つ）',
      jpeg(grayFrame(), segment(0xc4, [...table(0x00, { 1: [0] }), ...table(0x10, { 1: [0xf0] })]), SCAN, entropy('00000')),
      'ブロックの係数が多すぎます',
    ],
    [
      'ブロックの係数が多すぎる（63 個目より先）',
      jpeg(grayFrame(), segment(0xc4, [...table(0x00, { 1: [0] }), ...table(0x10, { 1: [0xf1] })]), SCAN, entropy('0' + '01'.repeat(4))),
      'ブロックの係数が多すぎます',
    ],
  ])('扱えない・壊れた JPEG は投げる（%s）', (_, bytes, message) => {
    expect(() => rewriteJpeg(bytes)).toThrow(message);
    expect(optimizeJpeg(bytes)).toBeNull();
  });

  it('リスタートは MCU の数で数え、番号は 7 の次に 0 へ戻る', () => {
    const blocks = 10;
    const data = [];
    for (let i = 0; i < blocks; i++) {
      if (i) data.push(0xff, 0xd0 + ((i - 1) % 8));
      data.push(...entropy('00'));
    }
    const original = jpeg(grayFrame(8 * blocks, 8), segment(0xdd, [0, 1]), SIMPLE_TABLES, SCAN, data);

    expect(sameCoefficients(original, rewriteJpeg(original))).toBe(true);
  });

  it('リスタートの区切りの前の埋め草（0xFF の並び）は読み飛ばし、書き直したものには入れない', () => {
    const original = jpeg(grayFrame(16, 8), segment(0xdd, [0, 1]), SIMPLE_TABLES, SCAN, entropy('00'), [0xff, 0xff, 0xff, 0xd0], entropy('00'));
    const out = rewriteJpeg(original);

    expect(sameCoefficients(original, out)).toBe(true);
    const at = out.indexOf(0xd0, out.length - 6);
    expect([...out.subarray(at - 2, at + 1)]).not.toEqual([0xff, 0xff, 0xd0]);
    expect(out[at - 1]).toBe(0xff);
  });
});

describe('optimizeJpeg', () => {
  it('小さくなれば書き直したものを、ならなければ null を返す', () => {
    const original = fixture('color.jpg');
    const out = optimizeJpeg(original);

    expect(out.length).toBeLessThan(original.length);
    // 作り直した表はもう最適なので、もう 1 度書き直しても小さくならない。
    expect(optimizeJpeg(out)).toBeNull();
  });
});

describe('sameCoefficients', () => {
  /** DC の値だけが違う 1 ブロックの画像（記号 1 = 「1」の後に 1 ビットの値）。 */
  const withDc = (bits) =>
    jpeg(grayFrame(), segment(0xc4, [...table(0x00, { 1: [0, 1] }), ...table(0x10, { 1: [0x00] })]), SCAN, entropy(bits));

  it('係数が同じなら true、違えば false', () => {
    expect(sameCoefficients(fixture('color.jpg'), fixture('color.optimized.jpg'))).toBe(true);
    // 走査の数が違う。
    expect(sameCoefficients(fixture('color.jpg'), fixture('multiscan.jpg'))).toBe(false);
    // ブロックの数が違う。
    expect(sameCoefficients(fixture('color.jpg'), fixture('restart.jpg'))).toBe(false);
    // 記号が違う（DC が 0 と、1 ビットの値）。
    expect(sameCoefficients(withDc('00'), withDc('100'))).toBe(false);
    // 記号は同じで、係数の値が違う。
    expect(sameCoefficients(withDc('100'), withDc('110'))).toBe(false);
    expect(sameCoefficients(withDc('110'), withDc('110'))).toBe(true);
    expect(sameCoefficients(TINY, TINY)).toBe(true);
  });
});

describe('optimalTable', () => {
  /** 符号の長さの、クラフトの和（1 以下なら符号に組める）。 */
  const kraft = (counts) => counts.reduce((sum, count, i) => sum + count / 2 ** (i + 1), 0);

  it('数の多い記号ほど短い符号にし、仮の記号のぶんだけ空きを残す', () => {
    const frequencies = new Int32Array(256);
    frequencies[0] = 100;
    frequencies[1] = 10;
    frequencies[2] = 10;
    const { counts, symbols } = optimalTable(frequencies);

    expect([...counts.subarray(0, 3)]).toEqual([1, 1, 1]);
    expect([...symbols]).toEqual([0, 1, 2]);
    expect(kraft(counts)).toBeLessThan(1);
  });

  it('符号が 16 ビットより長くなるときは、16 ビットまでに縮める', () => {
    // フィボナッチ数の数にすると、木が一直線に深くなる（縮めないと 30 ビットを超える）。
    const frequencies = new Int32Array(256);
    let [a, b] = [1, 1];
    for (let i = 0; i < 32; i++) {
      frequencies[i] = a;
      [a, b] = [b, a + b];
    }
    const { counts, symbols } = optimalTable(frequencies);

    expect(counts.length).toBe(16);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(32);
    expect(symbols.length).toBe(32);
    expect(kraft(counts)).toBeLessThan(1);
    // いちばん多い記号は、いちばん少ない記号より短い符号。
    const lengths = [];
    let k = 0;
    counts.forEach((count, i) => {
      for (let j = 0; j < count; j++) lengths[symbols[k++]] = i + 1;
    });
    expect(lengths[31]).toBeLessThan(lengths[0]);
  });
});
