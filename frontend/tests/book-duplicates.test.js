// PDF 結合ツール: 同じ頁が 2 度入っていないかの見比べ。
//
// 文字情報の指紋（MinHash）と画像の指紋（image-checks.js の imagePrint）から、
// 同じ頁らしい組を探し、頁ごとの指摘と本全体の指摘にすること。

import { describe, expect, it } from 'vitest';
import { PRINT_COLUMNS, PRINT_ROWS } from '../src/pdf-book-merger/image-checks.js';
import {
  createDuplicateFinder,
  duplicateIssues,
  samePage,
  textPrint,
  textSimilarity,
} from '../src/pdf-book-merger/duplicates.js';

const PAGES = [
  '吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。',
  '吾輩はここで始めて人間というものを見た。しかもあとで聞くとそれは書生という人間中で一番獰悪な種族であったそうだ。この書生というのは時々我々を捕えて煮て食うという話である。',
  'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness, it was the epoch of belief, it was the epoch of incredulity.',
  'It was the season of Light, it was the season of Darkness, it was the spring of hope, it was the winter of despair, we had everything before us, we had nothing before us.',
];

/** 決まった乱数（seed ごとに同じ並び）。 */
function randomOf(seed) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return (state >>> 8) / 2 ** 24;
  };
}

/** 画像の指紋の代わり（-64〜64 の乱数）。noise を足すと、スキャンし直したものになる。 */
function imageOf(seed, { from = null, noise = 0 } = {}) {
  const random = randomOf(seed);
  return Int8Array.from({ length: PRINT_COLUMNS * PRINT_ROWS }, (_, i) =>
    Math.round((from ? from[i] : (random() - 0.5) * 128) + (random() - 0.5) * 2 * noise)
  );
}

/** 4 × 4 のます目の中だけで並びを逆にしたもの（粗い指紋は同じで、細かく見ると違う）。 */
function shuffledInBlocks(print) {
  const out = new Int8Array(print.length);
  for (let y = 0; y < PRINT_ROWS; y++) {
    for (let x = 0; x < PRINT_COLUMNS; x++) {
      const by = y - (y % 4);
      const bx = x - (x % 4);
      out[(by + 3 - (y % 4)) * PRINT_COLUMNS + bx + 3 - (x % 4)] = print[y * PRINT_COLUMNS + x];
    }
  }
  return out;
}

const A = imageOf(1);
const A2 = imageOf(2, { from: A, noise: 12 }); // A をスキャンし直したもの（相関 0.98 ほど）
const B = imageOf(3); // A とは違う頁（相関 0 ほど）

describe('textPrint / textSimilarity', () => {
  it('同じ文字情報は重なり 1、違う頁はほとんど重ならない', () => {
    const prints = PAGES.map(textPrint);
    expect(textSimilarity(prints[0], textPrint(PAGES[0]))).toBe(1);
    expect(textSimilarity(prints[0], prints[1])).toBeLessThan(0.2);
    // 英文は語を 1 つと数えるので、「the」「was」のような語が共通でも重ならない。
    expect(textSimilarity(prints[2], prints[3])).toBeLessThan(0.2);
  });

  it('全角・半角、大文字・小文字、空白の違いは同じとみなし、少しの読み違いなら大きく重なる', () => {
    expect(textSimilarity(textPrint('ＡＢＣ　ｄｅｆ　ＧＨＩ　jkl'), textPrint('abc def ghi JKL'))).toBe(1);
    const misread = PAGES[2].replace('wisdom', 'wisd0m').replace('belief', 'be1ief');
    expect(textSimilarity(textPrint(PAGES[2]), textPrint(misread))).toBeGreaterThan(0.5);
  });

  it('語を空白で区切る文字は、アクセントも含めて語の中の字として数える', () => {
    expect(textPrint('café crème brûlée').size).toBe(1);
    expect(textPrint('Über naïve façade').size).toBe(1);
    // 合成済みの形の無い、アクセントを重ねた字。
    expect(textPrint('n\u0308oo bar baz').size).toBe(1);
    expect(textPrint('Καλημέρα κόσμε σήμερα').size).toBe(1);
    expect(textPrint('Привет мир сегодня').size).toBe(1);
    expect(textPrint('안녕하세요 오늘 날씨').size).toBe(1);
    expect(textPrint('مرحبا بالعالم اليوم').size).toBe(1);
    expect(textPrint('नमस्ते दुनिया आज').size).toBe(1);
    expect(textPrint('42 ＡＢＣ 7').size).toBe(1);
    // 漢字・かな・タイ文字（語を空白で区切らない）は 1 字ずつ。長音符は英字とつなげない。
    expect(textPrint('吾輩は猫').size).toBe(2);
    expect(textPrint('สวัสดีครับ').size).toBe([...'สวัสดีครับ'].length - 2);
    expect(textPrint('ーabc def').size).toBe(1);
    // 異体字セレクタは、付いていてもいなくても同じ。
    expect(textPrint('葛\uFE00飾区の\u{E0100}本\u180B')).toEqual(textPrint('葛飾区の本'));
  });

  it('3 つ並びが作れなければ、指紋は無い', () => {
    expect(textPrint('')).toBeNull();
    expect(textPrint(null)).toBeNull();
    expect(textPrint('第 1')).toBeNull();
    expect(textPrint('第 1 章')).not.toBeNull();
    expect(textSimilarity(null, textPrint(PAGES[0]))).toBeNull();
    expect(textSimilarity(textPrint(PAGES[0]), null)).toBeNull();
  });
});

describe('samePage', () => {
  const text = PAGES.map(textPrint);
  const short = textPrint('第 1 章 はじめに');

  it('文字情報が十分にあれば、文字情報で決め、画像が大きく違えば別の頁とする', () => {
    expect(samePage({ text: text[0], image: A }, { text: text[0], image: A2 })).toEqual({ exact: false });
    expect(samePage({ text: text[0], image: null }, { text: text[0], image: null })).toEqual({ exact: true });
    // 片方にだけ画像の指紋があれば、中身まで同じとは言わない。
    expect(samePage({ text: text[0], image: A }, { text: text[0], image: null })).toEqual({ exact: false });
    // 中身まで同じかは、MinHash ではなく文字情報そのもので決める（3 つ並びの集まりは同じでも、文は違う）。
    const twice = textPrint(PAGES[0] + PAGES[0]);
    const thrice = textPrint(PAGES[0] + PAGES[0] + PAGES[0]);
    expect(textSimilarity(twice, thrice)).toBe(1);
    expect(samePage({ text: twice, image: null }, { text: thrice, image: null })).toEqual({ exact: false });
    expect(samePage({ text: text[0], image: A }, { text: text[0], image: A })).toEqual({ exact: true });
    expect(samePage({ text: text[0], image: A }, { text: text[1], image: A })).toBeNull();
    expect(samePage({ text: text[0], image: A }, { text: text[0], image: B })).toBeNull();
  });

  it('文字情報が少ない・無ければ、画像で決め、少ない文字情報が大きく違えば別の頁とする', () => {
    expect(samePage({ text: null, image: A }, { text: null, image: A })).toEqual({ exact: true });
    expect(samePage({ text: null, image: A }, { text: null, image: A2 })).toEqual({ exact: false });
    expect(samePage({ text: short, image: A }, { text: short, image: A2 })).toEqual({ exact: false });
    // 片方だけ OCR してあるもの（中身まで同じではない）。
    expect(samePage({ text: text[0], image: A }, { text: null, image: A })).toEqual({ exact: false });
    expect(samePage({ text: null, image: A }, { text: null, image: B })).toBeNull();
    expect(samePage({ text: null, image: A }, { text: null, image: null })).toBeNull();
    expect(samePage({ text: null, image: null }, { text: null, image: A })).toBeNull();
    // 粗く見ると同じでも、細かく見て違えば別の頁とする。
    expect(samePage({ text: null, image: A }, { text: null, image: shuffledInBlocks(A) })).toBeNull();
    expect(samePage({ text: short, image: A }, { text: textPrint('第 2 章 構造の概要'), image: A })).toBeNull();
    // 片方の OCR がほとんど読めなかった（文字情報の量が大きく違う）ときは、文字情報では決めない。
    expect(samePage({ text: text[0], image: A }, { text: textPrint('吾輩は猫'), image: A2 })).toEqual({ exact: false });
  });
});

describe('createDuplicateFinder', () => {
  const text = PAGES.map(textPrint);
  const page = (key, i, img = null) => ({ key, text: text[i], image: img });

  it('同じ頁らしい組を探し、前に見比べた頁どうしは見比べ直さない', () => {
    const find = createDuplicateFinder();
    expect(find([page('a:0', 0), page('a:1', 1)])).toEqual([]);
    // 加わった頁を、前からある頁とも、一緒に加わった頁とも見比べる。
    const a2 = page('b:0', 0);
    const a3 = page('c:0', 0);
    expect(find([page('a:0', 0), page('a:1', 1), a2, a3])).toEqual([
      { a: 'a:0', b: 'b:0', exact: true },
      { a: 'c:0', b: 'b:0', exact: true },
      { a: 'a:0', b: 'c:0', exact: true },
    ]);
    // 何も加わらなければ、前の結果をそのまま返す（指紋の同じ頁は見比べ直さない）。
    const again = find([page('a:0', 0), page('a:1', 1), a2, a3]);
    expect(again).toHaveLength(3);
    // 外した頁の組は落とす。
    expect(find([page('a:0', 0), page('a:1', 1), a2])).toEqual([{ a: 'a:0', b: 'b:0', exact: true }]);
    // 指紋が変わった頁（調べ直した）は、見比べ直す。
    expect(find([page('a:0', 0), page('a:1', 1), page('b:0', 1)])).toEqual([{ a: 'a:1', b: 'b:0', exact: true }]);
  });
});

describe('duplicateIssues', () => {
  const entry = (pageKey, extra = {}) => ({
    pageKey,
    fileKey: pageKey.split(':')[0],
    pageIndex: Number(pageKey.split(':')[1]),
    role: 'body',
    number: null,
    status: 'unknown',
    ...extra,
  });
  const describe_ = (e) => `「${e.fileKey}.pdf」の ${e.pageIndex + 1} 頁目`;

  it('同じ頁らしい組が無ければ、何も指摘しない', () => {
    expect(duplicateIssues([entry('a:0')], [], describe_)).toEqual({ issues: new Map(), problem: null });
  });

  it('部が違えば、同じ番号の頁でも別の頁とする（部ごとに同じ番号の扉など）', () => {
    const order = [
      entry('a:0', { number: 1, status: 'detected', part: 0 }),
      entry('b:0', { number: 1, status: 'detected', part: 1 }),
      entry('c:0', { number: 1, status: 'detected', part: 1 }),
    ];
    const { issues } = duplicateIssues(
      order,
      [
        { a: 'a:0', b: 'b:0', exact: false },
        { a: 'b:0', b: 'c:0', exact: false },
      ],
      describe_
    );
    expect([...issues.keys()]).toEqual(['b:0', 'c:0']);
    // 中身まで同じ頁は、部が違っても同じ頁（同じ束を 2 度入れて、部の始まりと見られたとき）。
    const exact = duplicateIssues(order, [{ a: 'a:0', b: 'b:0', exact: true }], describe_);
    expect([...exact.issues.keys()]).toEqual(['a:0', 'b:0']);
  });

  it('中身まで同じ頁は誤り、似た頁は注意として、互いを挙げる', () => {
    const order = [entry('a:0'), entry('a:1'), entry('b:0'), entry('b:1')];
    const { issues, problem } = duplicateIssues(
      order,
      [
        { a: 'a:0', b: 'b:0', exact: true },
        { a: 'b:1', b: 'a:1', exact: false },
      ],
      describe_
    );
    expect(issues.get('a:0')).toEqual([
      { kind: 'same-page', level: 'error', message: '「b.pdf」の 1 頁目と同じ頁です' },
    ]);
    expect(issues.get('b:0')[0].message).toBe('「a.pdf」の 1 頁目と同じ頁です');
    expect(issues.get('a:1')).toEqual([
      {
        kind: 'same-page',
        level: 'warn',
        message: '「b.pdf」の 2 頁目と同じ内容のようです（同じ頁を 2 度スキャンした？）',
      },
    ]);
    expect(problem).toEqual({
      level: 'error',
      kind: 'same-page',
      message:
        '同じ内容の頁が 2 組あります（「a.pdf」の 1 頁目と「b.pdf」の 1 頁目、「a.pdf」の 2 頁目と「b.pdf」の 2 頁目）。' +
        '同じ頁を 2 度スキャンしていないか、同じ頁を含むファイルを 2 度足していないか確かめてください。',
      pageKeys: ['b:0', 'b:1'],
    });
  });

  it('似ているだけの組しか無ければ、本全体の指摘も注意にする', () => {
    const { problem } = duplicateIssues([entry('a:0'), entry('b:0')], [{ a: 'a:0', b: 'b:0', exact: false }], describe_);
    expect(problem.level).toBe('warn');
  });

  it('3 頁以上が同じなら 1 組にまとめ、挙げるのは 3 つまで（ほかは数だけ）', () => {
    const keys = ['a:0', 'b:0', 'c:0', 'd:0', 'e:0'];
    const order = keys.map((key) => entry(key));
    const pairs = keys.slice(1).map((key) => ({ a: 'a:0', b: key, exact: true }));
    const { issues, problem } = duplicateIssues(order, pairs, describe_);
    expect(issues.get('a:0')[0].message).toBe(
      '「b.pdf」の 1 頁目・「c.pdf」の 1 頁目・「d.pdf」の 1 頁目ほか 1と同じ頁です'
    );
    expect(problem.message).toContain(
      '同じ内容の頁が 1 組あります（「a.pdf」の 1 頁目と「b.pdf」の 1 頁目と「c.pdf」の 1 頁目ほか 2）'
    );
    expect(problem.pageKeys).toEqual(['e:0']);
  });

  it('5 組以上でも、挙げるのは 3 組まで', () => {
    const order = [];
    const pairs = [];
    for (const file of ['a', 'b', 'c', 'd']) {
      order.push(entry(`${file}:0`), entry(`${file}:1`));
      pairs.push({ a: `${file}:0`, b: `${file}:1`, exact: false });
    }
    const { problem } = duplicateIssues(order, pairs, describe_);
    expect(problem.message).toContain('同じ内容の頁が 4 組あります（');
    expect(problem.message).toContain('「c.pdf」の 1 頁目と「c.pdf」の 2 頁目ほか 1）');
  });

  it('読み取った頁番号が違う本文の頁どうしは、別の頁とする（罫線だけのメモの頁など）', () => {
    const order = [
      entry('a:0', { number: 101, status: 'detected' }),
      entry('a:1', { number: 102, status: 'detected' }),
      entry('a:2', { number: 103, status: 'inferred' }),
      entry('b:0', { role: 'front', number: null, status: 'cover' }),
    ];
    const pairs = [
      { a: 'a:0', b: 'a:1', exact: false },
      { a: 'a:1', b: 'a:2', exact: false },
      { a: 'a:0', b: 'b:0', exact: false },
    ];
    const { issues } = duplicateIssues(order, pairs, describe_);
    expect([...issues.keys()].sort()).toEqual(['a:0', 'a:1', 'a:2', 'b:0']);
    expect(issues.get('a:0')[0].message).toBe('「b.pdf」の 1 頁目と同じ内容のようです（同じ頁を 2 度スキャンした？）');
    // 手で入れた番号は当てにしない（ファイルごとに入れた先頭の番号は、同じ束を 2 度
    // スキャンしたファイルにも別の番号を振る。頁ごとの番号も、指摘を消すために入れたのかもしれない）。
    const manual = duplicateIssues(
      [entry('a:0', { number: 3, status: 'manual' }), entry('b:0', { number: 4, status: 'detected' })],
      [{ a: 'a:0', b: 'b:0', exact: true }],
      describe_
    );
    expect(manual.problem).not.toBeNull();
    // 同じ番号を読み取った頁（同じ頁を 2 度スキャンした）は、同じ頁とする。
    const same = duplicateIssues(
      [entry('a:0', { number: 5, status: 'detected' }), entry('b:0', { number: 5, status: 'detected' })],
      [{ a: 'a:0', b: 'b:0', exact: false }],
      describe_
    );
    expect(same.problem).not.toBeNull();
  });

  it('結合しない頁（並びに無い頁）との組は数えない', () => {
    const { issues, problem } = duplicateIssues([entry('a:0')], [{ a: 'a:0', b: 'x:0', exact: true }], describe_);
    expect(issues.size).toBe(0);
    expect(problem).toBeNull();
    expect(duplicateIssues([entry('a:0')], [{ a: 'x:0', b: 'a:0', exact: true }], describe_).problem).toBeNull();
  });
});
