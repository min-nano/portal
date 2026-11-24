// PDF 結合ツール: 頁番号の読み取りと、ファイルの中での並びの推定。
//
// 裁断した本を分けてスキャンすると、1 ファイルの中では番号が一定の歩幅で
// 進む（奇数頁の束なら 2 つずつ、裏返した偶数頁の束なら 2 つずつ逆順）。
// その性質で、番号の刷られていない頁を補い、読み違えた頁を外れ値にできる
// ことを縛る。

import { describe, expect, it } from 'vitest';
import {
  chooseDepth,
  comparePaths,
  detectStep,
  formatNumber,
  groupLines,
  inferFileNumbers,
  interpret,
  manualFileNumbers,
  mergeCandidates,
  normalizeDigits,
  numberingSequence,
  pageNumberCandidates,
  pageNumberText,
  parsePageNumber,
  readMargin,
  sideOf,
  stripPageNumber,
  unsettledPages,
} from '../src/pdf-book-merger/page-numbers.js';

/** 頁に対する割合で置いた文字の断片。 */
function item(text, { x = 0.5, y = 0.95, h = 0.012, w = 0.02 } = {}) {
  return { text, x0: x - w / 2, x1: x + w / 2, y, h };
}

/** 頁番号だけが読めた頁の候補（頁番号の読み取りを通さず、直接作る）。 */
const read = (value, score = 3.5) => [{ path: [value], score, source: 'text', zone: 'bottom' }];
const none = () => [];
/** 候補の番号（12 は 12、57-1 は '57-1'）。 */
const labelOf = (c) => (c.path.length === 1 ? c.path[0] : c.path.join('-'));
/** 枝番の付いた番号（57-1）だけが読めた頁の候補。 */
const branch = (value, number) => [{ path: [value, number], score: 3.5, source: 'text', zone: 'bottom' }];

describe('normalizeDigits / groupLines', () => {
  it('全角の数字を半角にする', () => {
    expect(normalizeDigits('１２３頁')).toBe('123頁');
  });

  it('1 文字ずつの断片を、同じ高さのものどうしで行にまとめる', () => {
    const lines = groupLines([
      { text: '1', x0: 0.49, x1: 0.5, y: 0.95, h: 0.01 },
      { text: '2', x0: 0.5, x1: 0.51, y: 0.9502, h: 0.01 },
      { text: '本文', x0: 0.1, x1: 0.3, y: 0.5, h: 0.01 },
    ]);

    expect(lines.map((line) => line.text)).toEqual(['本文', '12']);
  });

  it('同じ文字を少しずらして重ね書きしたもの（太字に見せる刷り方）は 1 度だけ読む', () => {
    const bold = [0, 0.001, 0.002].map((dx) => ({ text: '3-14', x0: 0.48 + dx, x1: 0.52 + dx, y: 0.95, h: 0.012 }));
    expect(groupLines(bold).map((line) => line.text)).toEqual(['3-14']);
    // 並んだ同じ文字（「11」の 1 文字ずつの断片）は重ね書きではない。
    const digits = [
      { text: '1', x0: 0.49, x1: 0.5, y: 0.95, h: 0.01 },
      { text: '1', x0: 0.5, x1: 0.51, y: 0.95, h: 0.01 },
    ];
    expect(groupLines(digits).map((line) => line.text)).toEqual(['11']);
  });

  it('字の間が開いていれば区切る（柱と頁番号をくっつけない）', () => {
    const [line] = groupLines([
      { text: '第3章 運動の法則', x0: 0.1, x1: 0.4, y: 0.05, h: 0.012 },
      { text: '57', x0: 0.85, x1: 0.88, y: 0.05, h: 0.012 },
    ]);

    expect(line.text).toBe('第3章 運動の法則 57');
  });
});

describe('readMargin', () => {
  it('上下の余白の柱を拾う（番号だけの行と、帯の外の行は拾わない）', () => {
    const { candidates, heads } = readMargin([
      item('第2部 運動の法則', { x: 0.3, y: 0.05, w: 0.3 }),
      item('57', { x: 0.9, y: 0.05 }),
      item('- 12 -', { y: 0.95 }),
      item('本文の行', { y: 0.5, w: 0.3 }),
      item('12 総論', { x: 0.2, y: 0.97, w: 0.2 }),
      item('ア', { x: 0.8, y: 0.9 }), // 1 字だけの行は柱にしない
    ]);

    expect(heads).toEqual(['第2部 運動の法則 57', '12 総論']);
    // 頁番号の候補も同じ行から拾う。
    expect(candidates.map(labelOf)).toEqual([12, 57]);
  });

  it('柱からその頁の頁番号を落とす（飾りの記号で区切られていても。ほかの数字は残す）', () => {
    expect(stripPageNumber('第2部 運動の法則 57', { number: 57 })).toBe('第2部運動の法則');
    expect(stripPageNumber('12 総論', { number: 12 })).toBe('総論');
    expect(stripPageNumber('12｜書名', { number: 12 })).toBe('書名');
    expect(stripPageNumber('書名・13', { number: 13 })).toBe('書名');
    expect(stripPageNumber('Part 2', { number: 13 })).toBe('Part2');
    expect(stripPageNumber('Part 2', null)).toBe('Part2');
    // 枝番の頁は「57-1」をまとめて落とす。
    expect(stripPageNumber('民法解説 57-1', { number: 57, branch: [1] })).toBe('民法解説');
    expect(stripPageNumber('57-1 民法解説', { number: 57, branch: [1] })).toBe('民法解説');
    expect(stripPageNumber('民法解説 57 - 1', { number: 57, branch: [1] })).toBe('民法解説'); // OCR の断片の間の空白
    // 小数の番号は落とさない（「.」を正規表現の何でもよい 1 字にしない）。
    expect(stripPageNumber('森の話 1605', { number: 16.5 })).toBe('森の話1605');
    // 同じ番号をもう一度（作った正規表現を使い回す）。
    expect(stripPageNumber('総論 57', { number: 57 })).toBe('総論');
  });

  it('「Page 16 of 200」「16 / 200 頁」のような頁番号だけの行は、柱として拾わない', () => {
    const { heads } = readMargin([
      item('— Page 16 of 200 —', { y: 0.03, w: 0.3 }),
      item('16 / 200 頁', { y: 0.97, w: 0.2 }),
      item('Prologue', { x: 0.2, y: 0.05, w: 0.2 }),
      item('1.2', { x: 0.8, y: 0.09 }), // 節の番号だけの柱は残す
    ]);

    expect(heads).toEqual(['Prologue', '1.2']);
    const more = ['p. 16 of 200', 'Page16 of 200', '16 of 200', '16 / 200 pages', 'p16/200', 'Page16', '2024/05/01', '12/25'];
    expect(more.map((text) => readMargin([item(text, { y: 0.03, w: 0.3 })]).heads)).toEqual([
      [],
      [],
      [],
      [],
      [],
      [],
      ['2024/05/01'],
      ['12/25'],
    ]);
  });

  it('同じ文字の行は 1 つにする', () => {
    expect(readMargin([item('総論', { y: 0.03 }), item('総論', { y: 0.97 })]).heads).toEqual(['総論']);
  });
});

describe('pageNumberCandidates', () => {
  it('下の余白に番号だけが置かれた行は、強い候補', () => {
    const [candidate] = pageNumberCandidates([item('- 12 -')]);

    expect(candidate).toMatchObject({ path: [12], source: 'text', zone: 'bottom' });
    expect(candidate.score).toBeGreaterThanOrEqual(3);
  });

  it.each(['12', '(12)', 'p.12', '12頁', '－１２－', '— 12 —'])('飾りの付いた番号 %s', (text) => {
    expect(pageNumberCandidates([item(text)]).map(labelOf)).toEqual([12]);
  });

  it('柱の末尾・先頭に付いた番号は、弱い候補', () => {
    const trailing = pageNumberCandidates([item('第3章 運動の法則 57', { y: 0.04, w: 0.6 })]);
    const leading = pageNumberCandidates([item('58 第3章 運動の法則', { y: 0.04, w: 0.6 })]);

    expect(trailing.map(labelOf)).toEqual([57]);
    expect(trailing[0].score).toBeLessThan(3);
    expect(leading.map(labelOf)).toEqual([58]);
  });

  it('本文の中の数字・章番号・年号は拾わない', () => {
    expect(
      pageNumberCandidates([
        item('12', { y: 0.5 }), // 本文の真ん中
        item('第3章', { y: 0.04 }), // 柱の章番号（数字だけの行ではない）
        item('2024', { y: 0.96 }), // 年号
        item('0', { y: 0.96 }),
      ])
    ).toEqual([]);
  });

  it('上下の帯の両方に候補があれば、両方を挙げる（どちらが合うかは並びで決める）', () => {
    const values = pageNumberCandidates([item('3', { y: 0.04 }), item('15', { y: 0.96 })]).map(labelOf);

    expect(values.sort((a, b) => a - b)).toEqual([3, 15]);
  });

  it('OCR の結果も同じ読み方で扱い、出どころを残す', () => {
    expect(pageNumberCandidates([item('7')], 'ocr')[0].source).toBe('ocr');
  });
});

describe('detectStep', () => {
  // detectStep は階層に合わせて読んだ候補（interpret）を受け取る。
  const stepOf = (pages, depth = 0) =>
    detectStep(pages.map((list) => list.map((c) => ({ ...c, ...interpret(c.path, depth) })))).step;
  const labeled = (text) => [{ path: text.split('-').map(Number), score: 3.5, source: 'text', zone: 'bottom' }];

  it('奇数頁の束は 2 つずつ', () => {
    expect(stepOf([read(1), read(3), none(), read(7)])).toBe(2);
  });

  it('裏返した偶数頁の束は 2 つずつ逆順', () => {
    expect(stepOf([read(20), read(18), read(16)])).toBe(-2);
  });

  it('両面の束は 1 つずつ', () => {
    expect(stepOf([read(5), read(6), read(7)])).toBe(1);
  });

  it('番号が 1 つしか読めなければ決めない', () => {
    expect(stepOf([none(), read(5), none()])).toBeNull();
  });

  it('前の段（部・編などの番号）の違う頁どうしの差は数えない（前の段の分からない頁とは数える）', () => {
    // 1-3 → 2-1 は -2 に見えるが、部が変わっただけ。
    expect(stepOf([labeled('1-1'), labeled('1-3'), labeled('2-1'), labeled('2-3')], 1)).toBe(2);
    expect(stepOf([labeled('1-5'), labeled('2-3')], 1)).toBeNull();
    expect(stepOf([read(5), labeled('2-7')], 1)).toBe(2);
  });
});

describe('inferFileNumbers', () => {
  it('番号の刷られていない頁を、前後から補う', () => {
    const { step, pages } = inferFileNumbers([read(1), read(3), none(), read(7), none()]);

    expect(step).toBe(2);
    expect(pages.map((p) => p.number)).toEqual([1, 3, 5, 7, 9]);
    expect(pages.map((p) => p.status)).toEqual([
      'detected',
      'detected',
      'inferred',
      'detected',
      'inferred',
    ]);
  });

  it('読み違えた 1 頁は、前後と合わないので外れ値として扱う', () => {
    const { pages } = inferFileNumbers([read(2), read(4), read(8), read(8), read(10)]);

    expect(pages.map((p) => p.number)).toEqual([2, 4, 6, 8, 10]);
    expect(pages[2]).toMatchObject({ status: 'conflict', read: { value: 8 } });
  });

  it('柱の章番号よりも、並びに合う頁番号を選ぶ', () => {
    const header = (chapter, page) => [
      { path: [chapter], score: 2.5, source: 'text', zone: 'top' },
      { path: [page], score: 3.5, source: 'text', zone: 'bottom' },
    ];
    const { pages } = inferFileNumbers([header(3, 41), header(3, 43), header(3, 45)]);

    expect(pages.map((p) => p.number)).toEqual([41, 43, 45]);
  });

  it('番号の無い前付けは、歩幅を延ばして 0 以下になる（1 頁より前に並ぶ）', () => {
    const { pages } = inferFileNumbers([none(), none(), read(1), read(3), read(5)]);

    expect(pages.map((p) => p.number)).toEqual([-3, -1, 1, 3, 5]);
  });

  it('裏返した束（逆順）も同じように補う', () => {
    const { step, pages } = inferFileNumbers([read(10), none(), read(6), read(4), none()]);

    expect(step).toBe(-2);
    expect(pages.map((p) => p.number)).toEqual([10, 8, 6, 4, 2]);
  });

  it('番号が本当に飛んでいるところでは並びを切り替え、境目の頁は要確認にする', () => {
    // 15 と 17 の間に、番号に数えない図版が 1 枚挟まっている。
    const { pages } = inferFileNumbers([read(11), read(13), read(15), none(), read(17), read(19)]);

    expect(pages.map((p) => p.number).filter((_, i) => i !== 3)).toEqual([11, 13, 15, 17, 19]);
    expect(pages[3].status).toBe('uncertain');
  });

  it('分かっている歩幅を借りて、番号が 1 つだけのファイルも並べる', () => {
    const { pages } = inferFileNumbers([none(), read(23), none()], { step: 2 });

    expect(pages.map((p) => p.number)).toEqual([21, 23, 25]);
  });

  it('歩幅が決まらなければ、読めた頁にだけ番号を付ける', () => {
    const { step, pages } = inferFileNumbers([none(), read(23), none()]);

    expect(step).toBeNull();
    expect(pages.map((p) => p.number)).toEqual([null, 23, null]);
    expect(pages.map((p) => p.status)).toEqual(['unknown', 'detected', 'unknown']);
  });

  it('手掛かりが何も無ければ、すべて不明', () => {
    const { pages } = inferFileNumbers([none(), none()], { step: 2 });

    expect(pages).toEqual([
      { number: null, status: 'unknown', read: null },
      { number: null, status: 'unknown', read: null },
    ]);
  });
});

describe('inferFileNumbers（頁ごとに手で入れた番号）', () => {
  it('手で入れた番号は確かなものとし、読めなかった頁はそこから補う', () => {
    // 番号が 1 つも読めなかった束。2 頁に番号を入れれば、歩幅も残りの頁も決まる。
    const { step, pages } = inferFileNumbers([none(), none(), none(), none()], {
      fixed: [null, { path: [13] }, null, { path: [17] }],
    });

    expect(step).toBe(2);
    expect(pages.map((p) => p.number)).toEqual([11, 13, 15, 17]);
    expect(pages.map((p) => p.status)).toEqual(['inferred', 'manual', 'inferred', 'manual']);
  });

  it('読み違えた番号より手で入れた番号を信じ、前後の頁も合わせて決め直す', () => {
    // 読み違いの多い束（43 → 48、47 → 17）。1 頁目に番号を入れれば、残りも並ぶ
    // （歩幅は、ほかの束から借りたもの）。
    const { pages } = inferFileNumbers([read(31), read(48), none(), read(17)], {
      step: 2,
      fixed: [{ path: [41] }, null, null, null],
    });

    expect(pages.map((p) => p.number)).toEqual([41, 43, 45, 47]);
    expect(pages.map((p) => p.status)).toEqual(['manual', 'conflict', 'inferred', 'conflict']);
    expect(pages[1].read).toMatchObject({ value: 48 });
  });

  it('入れた番号と違う並びで 2 頁以上続けて読めていれば、そこで並びを切り替える', () => {
    // 番号に数えない図版の頁に、図版の前の頁の番号を入れた。後ろの頁は読めたとおり。
    const { pages } = inferFileNumbers([read(11), none(), read(13), read(15)], {
      step: 2,
      fixed: [null, { path: [12.5] }, null, null],
    });
    expect(pages.map((p) => p.number)).toEqual([11, 12.5, 13, 15]);

    const jumped = inferFileNumbers([none(), read(31), read(33)], { step: 2, fixed: [{ path: [11] }, null, null] });
    expect(jumped.pages.map((p) => p.number)).toEqual([11, 31, 33]);
  });

  it('入れた番号は、読めた候補の点数によらず並びが必ず通る', () => {
    const { pages } = inferFileNumbers([read(1, 9), read(3, 9), read(5, 9)], {
      fixed: [null, { path: [4] }, null],
    });

    expect(pages[1]).toEqual({ number: 4, status: 'manual', read: null });
  });

  it('読めたとおりの番号を入れた頁は、読めた候補を残す（読み取りの内訳に数える）', () => {
    const { pages } = inferFileNumbers([read(1), read(3), branch(3, 1)], {
      fixed: [null, { path: [3] }, { path: [3, 1] }],
    });

    expect(pages[1]).toMatchObject({ status: 'manual', read: { value: 3 } });
    expect(pages[2]).toMatchObject({ status: 'manual', read: { value: 3, branch: [1] } });
  });

  it('枝番の頁は並びから外し、そこで番号が飛んでもよい', () => {
    const { pages } = inferFileNumbers([read(53), read(55), none(), read(59)], {
      fixed: [null, null, { path: [57, 1] }, null],
    });

    expect(pages.map((p) => p.number)).toEqual([53, 55, 57, 59]);
    expect(pages[2]).toEqual({ number: 57, branch: [1], status: 'manual', read: null });
    expect(pages[3].status).toBe('detected');
  });

  it('読めた枝番より、手で入れた枝番の無い番号を使い、並びに入れる', () => {
    const branched = [{ path: [57, 1], score: 3.5, source: 'text', zone: 'bottom' }];
    const { pages } = inferFileNumbers([read(53), read(55), branched, none()], {
      fixed: [null, null, { path: [57] }, null],
    });

    expect(pages.map((p) => p.number)).toEqual([53, 55, 57, 59]);
    expect(pages[2]).toEqual({ number: 57, status: 'manual', read: null });
  });

  it('間に挟む頁（12.5）は並びから外し、前後は飛ばさない', () => {
    const { pages } = inferFileNumbers([read(11), read(12), none(), none(), read(14)], {
      fixed: [null, null, { path: [12.5] }, null, null],
    });

    expect(pages.map((p) => p.number)).toEqual([11, 12, 12.5, 13, 14]);
    expect(pages.map((p) => p.status)).toEqual(['detected', 'detected', 'manual', 'inferred', 'detected']);
  });

  it('歩幅が決まらなければ、入れた頁にだけ番号を付ける', () => {
    const { step, pages } = inferFileNumbers([none(), none(), none()], { fixed: [null, { path: [8] }] });

    expect(step).toBeNull();
    expect(pages.map((p) => p.number)).toEqual([null, 8, null]);
    expect(pages[1].status).toBe('manual');
  });
});

describe('manualFileNumbers / numberingSequence / formatNumber', () => {
  it('手で決めた先頭の番号と歩幅で並べる', () => {
    expect(manualFileNumbers(3, 20, -2).pages.map((p) => [p.number, p.status])).toEqual([
      [20, 'manual'],
      [18, 'manual'],
      [16, 'manual'],
    ]);
  });

  it('番号の付き方を、番号を並べて言い表す（長い並びは間を詰める）', () => {
    expect(numberingSequence(inferFileNumbers([read(1), read(3), read(5)]))).toBe('1, 3, 5');
    expect(numberingSequence(inferFileNumbers([read(6), read(4), read(2)]))).toBe('6, 4, 2');
    expect(numberingSequence(manualFileNumbers(5, 1, 1))).toBe('1, 2, 3, 4, 5');
    // 前付け（0 以下の番号）から始まる束。
    expect(numberingSequence(manualFileNumbers(14, -11, 2))).toBe('-11, -9, -7...13, 15');
    expect(numberingSequence(manualFileNumbers(6, 12, -2))).toBe('12, 10, 8...4, 2');
    expect(numberingSequence(inferFileNumbers([none()]))).toBe('?');
    // 歩幅をほかの束から借りても、番号の候補が無ければ決まらない。
    expect(numberingSequence(inferFileNumbers([none(), none(), none()], { step: 2 }))).toBe('?');
  });

  it('番号が飛んでいるところは詰めずに、飛んだ先から並べ直す', () => {
    const numbers = (...list) => ({ step: 2, pages: list.map((number) => ({ number })) });
    expect(numberingSequence(numbers(1, 3, 9, 11))).toBe('1, 3, 9, 11');
    expect(numberingSequence(numbers(1, 3, 5, 7, 9, 11, 21, 23, 25, 27, 29, 31))).toBe(
      '1, 3, 5...9, 11, 21, 23, 25...29, 31'
    );
  });

  it('前付けと、間に入れた頁の番号の見せ方', () => {
    expect(formatNumber(12)).toBe('12');
    expect(formatNumber(-1)).toBe('前付(-1)');
    expect(formatNumber(16.5)).toBe('16と17の間');
    expect(formatNumber(null)).toBe('?');
  });
});

describe('枝番の頁（加除式の差し替え）', () => {
  it.each(['57-1', '57 - 1', '５７－１', '- 57-1 -', '57ー1頁'])('枝番の付いた番号 %s', (text) => {
    const [candidate] = pageNumberCandidates([item(text)]);

    expect(candidate).toMatchObject({ path: [57, 1] });
    expect(candidate.score).toBeGreaterThanOrEqual(3);
  });

  it('枝番の無い番号には branch を付けない', () => {
    expect(pageNumberCandidates([item('57')])[0]).not.toHaveProperty('branch');
    expect(pageNumberCandidates([item('57-0')])).toEqual([]);
  });

  it('同じ番号でも、枝番が違えば別の候補', () => {
    const values = pageNumberCandidates([item('57', { y: 0.04 }), item('57-1')]).map((c) => c.path);
    expect(values).toEqual(
      expect.arrayContaining([
        [57],
        [57, 1],
      ])
    );
    expect(values).toHaveLength(2);
  });

  it('同じ番号が上下に 2 度あれば、候補は 1 つ', () => {
    expect(pageNumberCandidates([item('12', { y: 0.04 }), item('12', { y: 0.96 })])).toHaveLength(1);
  });

  it('奇数頁の束: 枝番の頁は読めたまま置き、その前後で番号が飛んでもよい', () => {
    // 57・58 頁の紙が 57-1〜57-4 に差し替えられている。59 頁は束の最後の 1 頁だけ。
    const { step, pages } = inferFileNumbers([read(51), read(53), read(55), branch(57, 1), branch(57, 3), read(59)]);

    expect(step).toBe(2);
    expect(pages.map((p) => [p.number, p.branch ?? null, p.status])).toEqual([
      [51, null, 'detected'],
      [53, null, 'detected'],
      [55, null, 'detected'],
      [57, [1], 'detected'],
      [57, [3], 'detected'],
      [59, null, 'detected'],
    ]);
  });

  it('裏返した偶数頁の束も同じ', () => {
    const { step, pages } = inferFileNumbers([read(62), read(60), branch(57, 4), branch(57, 2), read(56), none()]);

    expect(step).toBe(-2);
    expect(pages.map((p) => (p.branch ? `${p.number}-${p.branch}` : p.number))).toEqual([62, 60, '57-4', '57-2', 56, 54]);
  });

  it('枝番の頁をまたぐ頁どうしの差は、歩幅の票に数えない', () => {
    // 55 → 59（間に枝番の頁）を数えると、歩幅 4 にも 2 にもならない並びが混ざる。
    const seen = (value) => [{ value, score: 3.5 }];
    expect(detectStep([seen(55), seen(59)], new Set([1])).step).toBeNull();
    expect(detectStep([seen(55), seen(57)]).step).toBe(2);
  });

  it('枝番の頁だけのファイル', () => {
    const { step, pages } = inferFileNumbers([branch(57, 1), branch(57, 3)]);

    expect(step).toBeNull();
    expect(pages.map((p) => p.status)).toEqual(['detected', 'detected']);
  });

  it('番号の付き方の要約では、枝番の頁を前後と続けない', () => {
    const numbering = inferFileNumbers([
      read(49), read(51), read(53), read(55), branch(57, 1), branch(57, 3), read(59), read(61),
    ]);

    expect(numberingSequence(numbering)).toBe('49, 51, 53, 55, 57-1, 57-3, 59, 61');
  });

  it('見せ方と、手で入れる番号の読み方', () => {
    expect(formatNumber(57, [1])).toBe('57-1');
    expect(formatNumber(57, [1, 2], [2])).toBe('2-57-1-2');
    expect(parsePageNumber('57-1')).toEqual({ path: [57, 1] });
    expect(parsePageNumber(' ５７－２ ')).toEqual({ path: [57, 2] });
    expect(parsePageNumber('2-2-21-3')).toEqual({ path: [2, 2, 21, 3] });
    expect(parsePageNumber('12')).toEqual({ path: [12] });
    expect(parsePageNumber('12.5')).toEqual({ path: [12.5] });
    expect(parsePageNumber('-3')).toEqual({ path: [-3] });
    expect(parsePageNumber('abc')).toBeNull();
    expect(parsePageNumber('')).toBeNull();
    expect(pageNumberText({ number: 57, branch: [1] })).toBe('57-1');
    expect(pageNumberText({ prefix: [2], number: 21 })).toBe('2-21');
    expect(pageNumberText({ number: 12.5 })).toBe('12.5');
  });
});

describe('本文の脇の行番号（5 行おき）', () => {
  /** 左の余白に右端を揃えて刷った行番号と、それに続く本文の行。 */
  const left = (number, y, text = '') =>
    text
      ? { text: `${number} ${text}`, x0: 0.08, x1: 0.89, y, h: 0.011 }
      : { text: String(number), x0: 0.1 - 0.006 * String(number).length, x1: 0.1, y, h: 0.011 };
  const pageNumber = (value, x = 0.88) => item(String(value), { x, y: 0.95 });

  it('下の帯に来た行番号を、頁番号と取り違えない', () => {
    const items = [
      left(5, 0.2),
      left(10, 0.31, '本文の行'),
      left(35, 0.79, '本文の行'),
      left(40, 0.9, 'されており,当該調査を的確に実施するためには'), // 行の先頭に付いた行番号
      left(45, 0.93), // 番号だけの行
      pageNumber(91),
    ];

    expect(pageNumberCandidates(items).map(labelOf)).toEqual([91]);
  });

  it('図で間が空いても、すぐ上の行番号から 5 増えていれば行番号', () => {
    const items = [left(15, 0.4, '本文の行'), left(20, 0.51, '本文の行'), left(25, 0.89), pageNumber(79)];

    expect(pageNumberCandidates(items).map(labelOf)).toEqual([79]);
  });

  it('すぐ下に 5 大きい番号がある行番号も外す（右の余白の、行の末尾に付いた行番号）', () => {
    const right = (number, y) => ({ text: `本文の行 ${number}`, x0: 0.1, x1: 0.92, y, h: 0.011 });
    const items = [right(35, 0.87), right(40, 0.9), pageNumber(64, 0.1)];

    expect(pageNumberCandidates(items).map(labelOf)).toEqual([64]);
  });

  it('行番号の列にあっても、5 ずつ続かない番号は頁番号として残す', () => {
    // 偶数頁の頁番号が、左の行番号の列の真下に来ることがある。
    const items = [left(35, 0.79, '本文の行'), left(40, 0.86, '本文の行'), left(80, 0.95)];

    expect(pageNumberCandidates(items).map(labelOf)).toEqual([80]);
  });

  it('5 の倍数でない番号、別の列の番号、上下の向きが逆のものは行番号とみなさない', () => {
    expect(pageNumberCandidates([left(40, 0.86, '本文の行'), left(41, 0.95)]).map(labelOf)).toEqual([41]);
    // 枝番の付いた番号は、行番号の列の真下にあっても頁番号。
    const branchPage = { ...left(45, 0.95), text: '45-1' };
    expect(pageNumberCandidates([left(40, 0.86, '本文の行'), branchPage])).toMatchObject([{ path: [45, 1] }]);
    expect(pageNumberCandidates([left(40, 0.86, '本文の行'), pageNumber(45)]).map(labelOf)).toEqual([45]);
    // 5 大きい番号が上にある（行番号は上から増える）。
    expect(pageNumberCandidates([left(50, 0.5, '本文の行'), left(45, 0.95)]).map(labelOf)).toEqual([45]);
  });
});

describe('文字情報だけでは番号の決まらない頁（余白を OCR する頁）', () => {
  /** 柱や表の中の数字だけが拾えた頁（弱い候補）。 */
  const weak = (value) => [{ path: [value], score: 2, source: 'text', zone: 'top' }];
  const ocr = (value, branchNumber) => [
    { path: branchNumber ? [value, branchNumber] : [value], score: 4, source: 'ocr', zone: 'bottom' },
  ];

  it('候補が無い頁・並びに合わない頁（弱い候補だけ・読み違え）を挙げ、並びに合う頁は挙げない', () => {
    // 実際のスキャン（加除式の本の奇数頁の束）: 181-1 は文字情報が読み落とし、
    // 柱の 3 だけが拾える。182 は読めている。184-1 は「184ソ」で読めない。
    // 175 は 171 と読み違えている。
    const text = [read(173), read(171), read(177), read(179), weak(3), read(182), weak(12), none()];

    expect([...unsettledPages(text)]).toEqual([1, 4, 5, 6, 7]);
  });

  it('OCR で読めた番号を足すと、枝番の頁を挟んで並びが変わっても、読めた頁を食い違いにしない', () => {
    const text = [read(173), read(171), read(177), read(179), weak(3), read(182), weak(12)];
    // 文字情報だけでは、182 が前後と食い違う（183 とされる）。
    expect(inferFileNumbers(text).pages[5]).toMatchObject({ number: 183, status: 'conflict' });

    const merged = text.slice();
    merged[1] = mergeCandidates(text[1], ocr(175));
    merged[4] = mergeCandidates(text[4], ocr(181, 1));
    merged[5] = mergeCandidates(text[5], ocr(182));
    merged[6] = mergeCandidates(text[6], ocr(184, 1));
    const { pages } = inferFileNumbers(merged);
    expect(pages.map((p) => [p.branch ? `${p.number}-${p.branch}` : p.number, p.status])).toEqual([
      [173, 'detected'],
      [175, 'detected'],
      [177, 'detected'],
      [179, 'detected'],
      ['181-1', 'detected'],
      [182, 'detected'],
      ['184-1', 'detected'],
    ]);
    expect(unsettledPages(merged).size).toBe(0);
  });

  it('同じ番号の候補は 1 つにして点数の高いほうを残し、点数の順に並べる', () => {
    const text = [
      { path: [182], score: 4, source: 'text', zone: 'bottom' },
      { path: [3], score: 2, source: 'text', zone: 'top' },
    ];
    const fromImage = [
      { path: [182], score: 3.5, source: 'ocr', zone: 'bottom' },
      { path: [182, 1], score: 3.5, source: 'ocr', zone: 'bottom' },
      { path: [3], score: 4, source: 'ocr', zone: 'bottom' },
    ];
    // 同点なら後の読み（OCR）を残す。
    expect(mergeCandidates(text, [{ path: [182], score: 4, source: 'ocr', zone: 'bottom' }])[0].source).toBe('ocr');

    expect(mergeCandidates(text, fromImage)).toEqual([
      { path: [3], score: 4, source: 'ocr', zone: 'bottom' },
      { path: [182], score: 4, source: 'text', zone: 'bottom' },
      { path: [182, 1], score: 3.5, source: 'ocr', zone: 'bottom' },
    ]);
  });
});

describe('ハイフンで区切った頁番号の階層（枝番か、部・編などの番号か）', () => {
  /** ハイフンで区切った番号（'2-21'。null は読めなかった頁）を、頁ごとの候補にする。 */
  const pages = (...labels) =>
    labels.map((label) =>
      label === null ? [] : [{ path: String(label).split('-').map(Number), score: 3.5, source: 'text', zone: 'bottom' }]
    );
  const depthOf = (...files) => chooseDepth(files.map((candidates) => ({ candidates }))).depth;
  const texts = (numbering) => numbering.pages.map((page) => (page.number === null ? null : pageNumberText(page)));

  it('ハイフンで区切った番号を、段の列として拾う（2 段目からは 0 で始まらず、上限を超えない）', () => {
    expect(pageNumberCandidates([item('2-21')]).map((c) => c.path)).toEqual([[2, 21]]);
    expect(pageNumberCandidates([item('- 2-2-21-3 -')]).map((c) => c.path)).toEqual([[2, 2, 21, 3]]);
    expect(pageNumberCandidates([item('２－１２０')]).map((c) => c.path)).toEqual([[2, 120]]);
    // 日付・段の多すぎるもの・上限を超える段は拾わない。
    expect(pageNumberCandidates([item('2024-05-01')])).toEqual([]);
    expect(pageNumberCandidates([item('1-2-3-4-5')])).toEqual([]);
    expect(pageNumberCandidates([item('2-2024')])).toEqual([]);
    // 0 で始まる段のある番号（電話番号など）も拾わない。番号だけなら、これまでどおり。
    expect(pageNumberCandidates([item('03-1234')])).toEqual([]);
    expect(pageNumberCandidates([item('012')]).map((c) => c.path)).toEqual([[12]]);
  });

  it('階層に合わせて読む（段の足りない番号は、前の段の分からない頁番号）', () => {
    expect(interpret([2, 21], 0)).toEqual({ prefix: null, value: 2, branch: [21] });
    expect(interpret([2, 21], 1)).toEqual({ prefix: [2], value: 21, branch: null });
    expect(interpret([2, 2, 21, 3], 1)).toEqual({ prefix: [2], value: 2, branch: [21, 3] });
    expect(interpret([2, 2, 21, 3], 2)).toEqual({ prefix: [2, 2], value: 21, branch: [3] });
    expect(interpret([21], 1)).toEqual({ prefix: null, value: 21, branch: null });
  });

  it('数字の列を頭から比べる（短いほうが先）', () => {
    const paths = [[58], [57, 2], [57], [57, 1, 1], [57, 1]];
    expect(paths.sort(comparePaths)).toEqual([[57], [57, 1], [57, 1, 1], [57, 2], [58]]);
  });

  it('3 部構成の本の 2-21 は、前後とつながる「2-」の 21 頁と読む', () => {
    const files = [
      pages('1-75', '1-77', '1-79', '2-1', '2-3', null, '2-7'),
      pages('2-19', '2-21', '2-23', '2-25'),
      pages('3-1', '3-3', '3-5'),
    ];
    const { depth, scores } = chooseDepth(files.map((candidates) => ({ candidates })));

    expect(depth).toBe(1);
    expect(scores[1]).toBeGreaterThan(scores[0]);
    const first = inferFileNumbers(files[0], { depth });
    expect(first.step).toBe(2);
    // 部が変わっても歩幅は 2 のまま。番号の読めない頁は、前後の頁の部を引き継ぐ。
    expect(texts(first)).toEqual(['1-75', '1-77', '1-79', '2-1', '2-3', '2-5', '2-7']);
    expect(first.pages[5]).toMatchObject({ prefix: [2], number: 5, status: 'inferred' });
    expect(numberingSequence(first)).toBe('1-75, 1-77, 1-79, 2-1, 2-3, 2-5, 2-7');
    expect(texts(inferFileNumbers(files[1], { depth }))).toEqual(['2-19', '2-21', '2-23', '2-25']);
  });

  it('加除式の本の 57-1 は、前後に枝番の無い頁があるので枝番と読む', () => {
    expect(depthOf(pages(51, 53, 55, '57-1', '57-3', 59, 61), pages(52, 54, 56, '57-2', '57-4', 60))).toBe(0);
    // 枝番の頁が 10 頁続いても、前後の枝番の無い頁から枝番と分かる。
    expect(depthOf(pages(55, 56, '57-1', '57-2', '57-3', '57-4', '57-5', '57-6', '57-7', '57-8', '57-9', '57-10', 58, 59))).toBe(0);
  });

  it('部・章・頁と入れ子の枝番（2-2-21-3）も段ごとに読む', () => {
    const files = [pages('2-2-17', '2-2-19', '2-2-21', '2-2-21-1', '2-2-23'), pages('2-3-1', '2-3-3')];
    const depth = depthOf(...files);

    expect(depth).toBe(2);
    const { pages: read } = inferFileNumbers(files[0], { depth });
    expect(read[3]).toMatchObject({ prefix: [2, 2], number: 21, branch: [1], status: 'detected' });
    expect(read.map((page) => page.number)).toEqual([17, 19, 21, 21, 23]);
  });

  it('部・編の番号の付いた本の枝番（2-57-1）は、部の番号と枝番に分ける', () => {
    const file = pages('2-51', '2-53', '2-55', '2-57-1', '2-57-3', '2-59');

    expect(depthOf(file)).toBe(1);
    expect(texts(inferFileNumbers(file, { depth: 1 }))).toEqual(['2-51', '2-53', '2-55', '2-57-1', '2-57-3', '2-59']);
  });

  it('ハイフンの無い本・点が同じなら、枝番と読む（階層 0）', () => {
    // ハイフンで区切った番号が無ければ、点を数えずに 0。
    expect(chooseDepth([{ candidates: pages(1, 3, 5) }])).toEqual({ depth: 0, scores: [] });
    expect(chooseDepth([])).toEqual({ depth: 0, scores: [] });
    // 1 頁だけの 2-1 は、どちらとも決められない。
    expect(depthOf(pages('2-1'))).toBe(0);
  });

  it('手で入れた番号も、階層を選ぶ手掛かりにする', () => {
    const fixed = [{ path: [2, 1] }, { path: [2, 3] }, null];
    const { depth } = chooseDepth([{ candidates: pages(null, null, null), fixed }]);

    expect(depth).toBe(1);
    const numbering = inferFileNumbers(pages(null, null, null), { depth, fixed });
    expect(texts(numbering)).toEqual(['2-1', '2-3', '2-5']);
    expect(numbering.pages.map((page) => page.status)).toEqual(['manual', 'manual', 'inferred']);
  });

  it('前の段を入れずに直した番号・間に挟む番号は、前後の頁の前の段にする', () => {
    const file = pages('2-1', '2-3', null, '2-7', null);
    const fixed = [null, null, { path: [5] }, null, { path: [7.5] }];
    const numbering = inferFileNumbers(file, { depth: 1, fixed });

    expect(texts(numbering)).toEqual(['2-1', '2-3', '2-5', '2-7', '2-7.5']);
    // 間に挟む頁がファイルの先頭なら、後ろの頁の前の段にする。
    const head = inferFileNumbers(pages(null, '3-1', '3-3'), { depth: 1, fixed: [{ path: [0.5] }] });
    expect(head.pages[0]).toMatchObject({ number: 0.5, prefix: [3] });
    // 前の段の分かる頁が無ければ、付けない。
    const alone = inferFileNumbers(pages(null, 5, 7), { depth: 1, fixed: [{ path: [4.5] }] });
    expect(alone.pages[0]).not.toHaveProperty('prefix');
  });

  it('前の段の違う頁に番号を手で入れたら、読めた候補と前の段まで同じときだけ読めた頁に数える', () => {
    const file = pages('2-1', '2-3');
    expect(inferFileNumbers(file, { depth: 1, fixed: [{ path: [2, 1] }] }).pages[0].read).toMatchObject({ path: [2, 1] });
    expect(inferFileNumbers(file, { depth: 1, fixed: [{ path: [1] }] }).pages[0].read).toMatchObject({ path: [2, 1] });
    expect(inferFileNumbers(file, { depth: 1, fixed: [{ path: [3, 1] }] }).pages[0].read).toBeNull();
  });

  it('歩幅の決まらないファイルでも、読めた前の段を付ける', () => {
    const { step, pages: read } = inferFileNumbers(pages(null, '2-21', null), { depth: 1 });

    expect(step).toBeNull();
    expect(read[1]).toMatchObject({ prefix: [2], number: 21, status: 'detected' });
  });

  it('柱からは、前の段まで書いた番号を落とす（前の段を刷っていなければ、頁番号から後ろを）', () => {
    expect(stripPageNumber('第2部 総則 2-21', { prefix: [2], number: 21 })).toBe('第2部総則');
    expect(stripPageNumber('総則 2 - 57 - 1', { prefix: [2], number: 57, branch: [1] })).toBe('総則');
    expect(stripPageNumber('総則 21', { prefix: [2], number: 21 })).toBe('総則');
    expect(stripPageNumber('総則 3-21', { prefix: [2], number: 21 })).toBe('総則3');
    expect(stripPageNumber('総則', { prefix: [2], number: 21 })).toBe('総則');
  });

  it('本の階層を、ファイルだけから選んで OCR する頁を決める', () => {
    // 階層 0 なら枝番の頁だけが並び、2-5 の読めない頁は番号が決まらない。
    expect([...unsettledPages(pages('2-1', '2-3', null, '2-7'))]).toEqual([2]);
  });

  it('入れ子の枝番の頁の表裏は、いちばん後ろの段で見る', () => {
    expect([sideOf(57, [1, 1]), sideOf(57, [1, 2]), sideOf(null), sideOf(2.5)]).toEqual(['odd', 'even', null, null]);
  });

  it('手で決めたファイルの番号にも、前の段を付ける', () => {
    expect(manualFileNumbers(2, 1, 2, [3]).pages.map(pageNumberText)).toEqual(['3-1', '3-3']);
  });
});
