// 現況検査レポート作成ツール: 写真から読んだ文字を、物件名と部屋（階・室名）に
// するところ（photo-reading.js）。読んだ文字は、資料の写真を読んだときの形
// （文字とその位置）を手で作る。物件名・住所は架空のもの。

import { describe, expect, it } from 'vitest';
import {
  classify,
  findPropertyName,
  findRooms,
  mergeRooms,
  normalize,
} from '../src/excel-report-formatter/photo-reading.js';

/** 文字のかたまり（左上と幅・高さ）。 */
const item = (text, x, y, w = 100, h = 40) => ({ text, x0: x, y0: y, x1: x + w, y1: y + h });

describe('normalize', () => {
  it('全角の英数字・括弧を半角にし、空白を外す', () => {
    expect(normalize('Ｌ Ｄ Ｋ（１７.９帖）')).toBe('LDK(17.9帖)');
  });
});

describe('classify', () => {
  it.each([
    ['1F', { kind: 'floor', floor: '1' }],
    ['２階', { kind: 'floor', floor: '2' }],
    ['floor2', { kind: 'floor', floor: '2' }],
    ['6帖', { kind: 'size', size: '6' }],
    ['(17.9帖)', { kind: 'size', size: '17.9' }],
    ['（8畳）', { kind: 'size', size: '8' }],
    ['6J', { kind: 'size', size: '6' }],
    ['LDK', { kind: 'room', name: 'LDK', size: '' }],
    ['洋室C', { kind: 'room', name: '洋室C', size: '' }],
    ['洋室2', { kind: 'room', name: '洋室2', size: '' }],
    ['洋室6.0帖', { kind: 'room', name: '洋室', size: '6.0' }],
    ['LDK19.0帖', { kind: 'room', name: 'LDK', size: '19.0' }],
    ['和室(8帖)', { kind: 'room', name: '和室', size: '8' }],
    ['子ども部屋', { kind: 'room', name: '子ども部屋', size: '' }],
    ['リビング・ダイニング12帖', { kind: 'room', name: 'リビング・ダイニング', size: '12' }],
  ])('%s', (text, expected) => {
    expect(classify(text)).toEqual(expected);
  });

  it.each(['CL', '押入', '浴室', 'バルコニー', '洋室ホール', '床下点検口', '3F平面図', ''])(
    '部屋・広さ・階でないもの（%s）は null',
    (text) => {
      expect(classify(text)).toBeNull();
    }
  );
});

describe('findPropertyName', () => {
  it('見出し「物件名」の右に並ぶ、いちばん近いかたまり', () => {
    const items = [
      item('物件ID', 100, 360, 130),
      item('202600000000', 300, 362, 200),
      item('物件名', 845, 360, 130),
      item('住戸番号', 1900, 365, 150),
      item(' 架空市本町1丁目2-3 ', 1131, 367, 500, 54),
      item('物件住所', 100, 430, 160),
    ];
    expect(findPropertyName(items)).toBe('架空市本町1丁目2-3');
  });

  it('斜めから撮って値が上下にずれていても、縦の範囲が重なれば同じ行とみなす', () => {
    const items = [item('物件名', 825, 477, 106, 64), item('架空市本町1-2', 1038, 420, 434, 97)];
    expect(findPropertyName(items)).toBe('架空市本町1-2');
  });

  it('見出しと値が 1 つのかたまりに読まれたら、見出しの後ろを値とする', () => {
    expect(findPropertyName([item('物件 名：架空市本町1-2', 0, 0)])).toBe('架空市本町1-2');
  });

  it('「物件名」で始まる別の見出し（物件名称）は見出しとみなさない', () => {
    expect(findPropertyName([item('物件名称', 0, 0), item('架空市本町1-2', 200, 0)])).toBe('');
  });

  it('見出しはあるが値が無い・見出しが無いときは空', () => {
    expect(findPropertyName([item('物件名', 0, 0), item('物件住所', 0, 100)])).toBe('');
    expect(findPropertyName([item('物件住所', 0, 0)])).toBe('');
  });
});

describe('findRooms', () => {
  it('階の見出しが図の上にある書き方（1F ↓ 部屋 ↓ 2F ↓ 部屋）', () => {
    const items = [
      item('架空市本町1-2 間取り図', 150, 150, 1000),
      item('1F', 150, 300, 40),
      item('和室', 1545, 846),
      item('(8帖)', 1545, 900),
      item('LDK', 594, 1180),
      item('(17.9帖)', 579, 1223),
      item('押入', 1425, 543),
      item('2F', 150, 1670, 40),
      item('洋室A', 436, 2547),
      item('(6帖)', 445, 2604),
    ];
    expect(findRooms(items).map(({ floor, name, size }) => [floor, name, size])).toEqual([
      ['1', '和室', '8'],
      ['1', 'LDK', '17.9'],
      ['2', '洋室A', '6'],
    ]);
  });

  it('階の見出しが図の下にある書き方（部屋 ↓ floor2 ↓ 部屋 ↓ floor1）', () => {
    const items = [
      item('洋室', 1000, 670),
      item('8.5帖', 990, 765),
      item('floor2', 1840, 1080),
      item('LDK', 1230, 1630),
      item('floor1', 1840, 1930),
      item('和室', 1940, 1960), // 最後の見出しより後ろ → 最後の見出しの階
    ];
    expect(findRooms(items).map(({ floor, name }) => [floor, name])).toEqual([
      ['2', '洋室'],
      ['1', 'LDK'],
      ['1', '和室'],
    ]);
  });

  it('階の図が左右に並ぶときは、横の位置で振り分ける', () => {
    const items = [
      item('1F', 100, 100, 40),
      item('2F', 1100, 100, 40),
      item('LDK', 300, 500),
      item('洋室', 1300, 500),
    ];
    expect(findRooms(items).map(({ floor, name }) => [floor, name])).toEqual([
      ['1', 'LDK'],
      ['2', '洋室'],
    ]);
  });

  it('見出しが 1 つなら全部その階、無ければ階は空', () => {
    expect(findRooms([item('2F', 0, 0), item('洋室', 0, 300)])[0].floor).toBe('2');
    expect(findRooms([item('洋室', 0, 300)])[0].floor).toBe('');
  });

  it('広さは名前のすぐ右でもよく、1 つの広さは 1 部屋にだけ付ける', () => {
    const items = [
      item('洋室', 0, 0, 80, 40),
      item('6帖', 90, 2, 60, 40),
      item('洋室', 300, 0, 80, 40),
      item('7帖', 300, 400, 60, 40), // 遠すぎる
    ];
    expect(findRooms(items).map((room) => room.size)).toEqual(['6', '']);

    const shared = [item('洋室', 0, 0), item('和室', 0, 30), item('6帖', 0, 60)];
    expect(findRooms(shared).map((room) => room.size)).toEqual(['6', '']);
  });

  it('近くに広さが 2 つあれば近いほう、名前と続けて読めた広さはそのまま', () => {
    const items = [item('洋室', 0, 0), item('8帖', 0, 70), item('6帖', 0, 45), item('9帖', 0, 75), item('和室6.0帖', 500, 0)];
    expect(findRooms(items).map((room) => [room.name, room.size])).toEqual([
      ['洋室', '6'],
      ['和室', '6.0'],
    ]);
  });

  it('座標（中心と高さ）も返す', () => {
    expect(findRooms([item('LDK', 100, 200, 100, 40)])).toEqual([
      { floor: '', name: 'LDK', size: '', x: 150, y: 220, h: 40 },
    ]);
  });
});

describe('mergeRooms', () => {
  const room = (floor, name, x, y, size = '', h = 40) => ({ floor, name, size, x, y, h });

  it('階の順（分からない階は最後）、写真の順、上から下・同じ行は左から右に並べる', () => {
    const merged = mergeRooms([
      [room('2', '洋室B', 900, 520), room('', '書斎', 0, 0), room('2', '洋室A', 400, 500), room('1', 'LDK', 0, 900)],
      [room('1', '和室', 0, 100)],
    ]);
    expect(merged).toEqual([
      { floor: '1', name: 'LDK' },
      { floor: '1', name: '和室' },
      { floor: '2', name: '洋室A' },
      { floor: '2', name: '洋室B' },
      { floor: '', name: '書斎' },
    ]);
  });

  it('同じ階に同じ名前が 2 つ以上あれば、広さを添えて見分ける（広さが無ければそのまま）', () => {
    const merged = mergeRooms([
      [
        room('2', '洋室', 0, 0, '8.5'),
        room('2', '洋室', 500, 0, '6.0'),
        room('2', '洋室', 0, 500),
        room('1', '洋室', 0, 900, '6'),
      ],
    ]);
    expect(merged).toEqual([
      { floor: '1', name: '洋室' },
      { floor: '2', name: '洋室（8.5帖）' },
      { floor: '2', name: '洋室（6.0帖）' },
      { floor: '2', name: '洋室' },
    ]);
  });
});
