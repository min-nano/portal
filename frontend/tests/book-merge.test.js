// 書籍スキャン PDF 結合ツール: 結合（pdf-lib）と、結合した PDF の検証。
//
// 結合は「頁の中身をそのまま写す」ことで、サーチャブル PDF の文字情報を
// 残す。ここでは pdf-lib で文字の入った PDF を作って結合し、画面と同じ
// pdf.js（Node 向けの legacy ビルド）で読み直して、
//
//   - 頁が指定の順に並ぶ
//   - 文字情報が頁ごとにそのまま残る（textSignature が一致する）
//   - 文書の情報（タイトル・作成者・言語）と頁ラベルが書き込まれる
//
// ことを縛る。あわせて、文字の位置の読み方（text-layer.js）と、突き合わせ
// （verify.js）も確かめる。

import { PDFDocument, PDFHexString, PDFName, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { loadSource, mergePdf, pageDigest, pageDigests } from '../src/pdf-book-merger/merge.js';
import { pageLabelRanges, pageLabelTexts } from '../src/pdf-book-merger/ordering.js';
import { pageNumberCandidates } from '../src/pdf-book-merger/page-numbers.js';
import { multiply, textItems, textSignature } from '../src/pdf-book-merger/text-layer.js';
import { compareOutput } from '../src/pdf-book-merger/verify.js';

const SIZE = [364, 515]; // B6 くらい

/** 頁ごとに「本文の文字」と「下の余白の頁番号」を持つ PDF を作る。 */
async function makeSource(numbers, { author, lang } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const number of numbers) {
    const page = doc.addPage(SIZE);
    page.drawText(`Body text of page ${number}`, { x: 40, y: 300, size: 11, font });
    page.drawText(String(number), { x: 175, y: 20, size: 9, font });
  }
  if (author) doc.setAuthor(author);
  if (lang) doc.catalog.set(PDFName.of('Lang'), PDFHexString.fromText(lang));
  return doc.save();
}

async function readBack(bytes) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    pages.push({
      size: { width: viewport.width, height: viewport.height },
      text: content.items.map((item) => item.str).join(' '),
      items: textItems(content, viewport),
      signature: textSignature(content.items),
    });
  }
  const labels = await doc.getPageLabels();
  const { info } = await doc.getMetadata();
  await doc.loadingTask.destroy();
  return { pages, labels, info };
}

describe('textItems / textSignature', () => {
  it('pdf.js の行列の積', () => {
    expect(multiply([1, 0, 0, -1, 0, 100], [10, 0, 0, 10, 5, 20])).toEqual([10, 0, 0, -10, 5, 80]);
  });

  it('文字の位置を、頁の上を 0 とする割合に直す', () => {
    const [part] = textItems(
      { items: [{ str: '12', transform: [10, 0, 0, 10, 50, 20], width: 12 }, { str: ' ', transform: [10, 0, 0, 10, 0, 0], width: 1 }] },
      { width: 200, height: 400, transform: [1, 0, 0, -1, 0, 400] }
    );

    expect(part.text).toBe('12');
    expect(part.x0).toBeCloseTo(0.25);
    expect(part.x1).toBeCloseTo(0.31);
    expect(part.y).toBeCloseTo(0.95);
    expect(part.h).toBeCloseTo(0.025);
  });

  it('文字の指紋は、空白や区切り方によらない', () => {
    const a = textSignature([{ str: 'Body text' }, { str: ' 12' }]);
    const b = textSignature([{ str: 'Bodytext12' }]);
    const c = textSignature([{ str: 'Bodytext13' }]);

    expect(a).toEqual(b);
    expect(a.length).toBe(10);
    expect(c.hash).not.toBe(a.hash);
    expect(textSignature([])).toEqual({ length: 0, hash: '811c9dc5' });
  });
});

describe('mergePdf', () => {
  it('奇数・偶数の束を指定の順に並べ、文字情報・文書の情報・頁ラベルを残す', async () => {
    const odd = await makeSource([1, 3, 5], { author: '夏目漱石', lang: 'ja' });
    const even = await makeSource([6, 4, 2]);
    const cover = await makeSource(['Cover']);
    const sources = new Map([
      ['odd', { bytes: odd, name: '奇数.pdf' }],
      ['even', { bytes: even, name: '偶数.pdf' }],
      ['cover', { bytes: cover, name: '表紙.pdf' }],
    ]);
    const order = [
      { fileKey: 'cover', pageIndex: 0, role: 'front', number: null },
      { fileKey: 'odd', pageIndex: 0, role: 'body', number: 1 },
      { fileKey: 'even', pageIndex: 2, role: 'body', number: 2 },
      { fileKey: 'odd', pageIndex: 1, role: 'body', number: 3 },
      { fileKey: 'even', pageIndex: 1, role: 'body', number: 4 },
      { fileKey: 'odd', pageIndex: 2, role: 'body', number: 5 },
      { fileKey: 'even', pageIndex: 0, role: 'body', number: 6 },
    ];
    const ranges = pageLabelRanges(order);
    const progress = [];

    const { bytes, digests } = await mergePdf({
      sources,
      order,
      title: '吾輩は猫である',
      labels: ranges,
      infoFrom: 'odd',
      onProgress: (done, total) => progress.push([done, total]),
    });
    const merged = await readBack(bytes);

    // 頁の順と、頁ごとの文字情報（元の頁の文字がそのまま残っている）。
    expect(merged.pages.map((page) => page.text.match(/page (\w+)/)[1])).toEqual([
      'Cover', '1', '2', '3', '4', '5', '6',
    ]);
    const originals = new Map();
    for (const [key, { bytes: source }] of sources) originals.set(key, (await readBack(source)).pages);
    order.forEach((entry, i) => {
      expect(merged.pages[i].signature).toEqual(originals.get(entry.fileKey)[entry.pageIndex].signature);
      expect(merged.pages[i].size).toEqual({ width: SIZE[0], height: SIZE[1] });
    });

    // 結合したあとも、余白の頁番号はそのまま読める。
    expect(pageNumberCandidates(merged.pages[3].items)[0].value).toBe(3);

    // 文書の情報（タイトルは保存名、作成者と言語は本文の最初のファイルから）。
    expect(merged.info.Title).toBe('吾輩は猫である');
    expect(merged.info.Author).toBe('夏目漱石');
    expect(merged.info.Creator).toBe('書籍スキャン PDF 結合ツール');
    const lang = (await PDFDocument.load(bytes)).catalog.lookup(PDFName.of('Lang'));
    expect(lang.decodeText()).toBe('ja');

    // 頁ラベル（ビューアーに出る頁番号）は本の頁番号と揃う。
    expect(merged.labels).toEqual(pageLabelTexts(ranges, order.length));
    expect(merged.labels).toEqual(['表紙', '1', '2', '3', '4', '5', '6']);

    expect(progress.at(-1)).toEqual([7, 7]);

    // 写した頁の「描くもの」の指紋は、元の頁と同じ。
    expect(await pageDigests(bytes)).toEqual(digests);
    expect(new Set(digests).size).toBe(7);
  });

  it('元に言語が無ければ、言語は書かない', async () => {
    const sources = new Map([['a', { bytes: await makeSource([1]), name: 'a.pdf' }]]);
    const { bytes } = await mergePdf({ sources, order: [{ fileKey: 'a', pageIndex: 0 }], title: 't' });

    expect((await PDFDocument.load(bytes)).catalog.lookup(PDFName.of('Lang'))).toBeUndefined();
  });

  it('無い頁を指定されたら止める', async () => {
    const sources = new Map([['a', { bytes: await makeSource([1]), name: 'a.pdf' }]]);

    await expect(
      mergePdf({ sources, order: [{ fileKey: 'a', pageIndex: 3 }], title: 't' })
    ).rejects.toThrow('「a.pdf」に 4 頁目がありません。');
    await expect(
      mergePdf({ sources, order: [{ fileKey: 'b', pageIndex: 0 }], title: 't' })
    ).rejects.toThrow('結合するファイルの中身がありません。');
  });

  it('PDF でないものは、ファイル名を添えて止める', async () => {
    await expect(loadSource(new TextEncoder().encode('not a pdf'), 'x.pdf')).rejects.toThrow(
      '「x.pdf」を PDF として読み込めませんでした'
    );
  });
});

describe('pdf-lib にバイト列を写させない（pdf-lib-views.js）', () => {
  it('読んだストリームも、別の文書へ写したストリームも、元のバイト列を指す', async () => {
    const bytes = await makeSource([1, 3]);
    const source = await loadSource(bytes, 'odd.pdf');
    const contents = source.getPage(0).node.Contents();
    const stream = source.context.lookup(contents.get?.(0) ?? contents) ?? contents;
    // 写さずに、元のバイト列の一部を指している。
    expect(stream.contents.buffer).toBe(bytes.buffer);

    const target = await PDFDocument.create();
    const [copied] = await target.copyPages(source, [0]);
    const copiedContents = copied.node.Contents();
    const copiedStream = target.context.lookup(copiedContents.get?.(0) ?? copiedContents) ?? copiedContents;
    expect(copiedStream.contents.buffer).toBe(bytes.buffer);
  });

  it('写さなくても、結合した PDF は元の頁と同じ指紋になり、元のバイト列は変わらない', async () => {
    const odd = await makeSource([1, 3]);
    const before = odd.slice();
    const sources = new Map([['f1', { bytes: odd, name: 'odd.pdf' }]]);
    const order = [{ fileKey: 'f1', pageIndex: 1 }, { fileKey: 'f1', pageIndex: 0 }];

    const { bytes, digests } = await mergePdf({ sources, order, title: 't' });

    expect(await pageDigests(bytes)).toEqual(digests);
    expect(odd).toEqual(before);
  });
});

describe('compareOutput', () => {

  const page = (overrides = {}) => ({
    pageKey: 'k',
    label: '1 頁',
    size: { width: 100, height: 200 },
    signature: { length: 5, hash: 'abc' },
    digest: 'd1',
    ...overrides,
  });

  it('すべて元と同じなら ok', () => {
    const result = compareOutput([page(), page()], [page(), page({ size: { width: 100.2, height: 200 } })]);

    expect(result).toEqual({
      ok: true,
      pageCount: { expected: 2, actual: 2 },
      textPages: 2,
      mismatches: [],
    });
  });

  it('大きさ・文字情報・描く中身の違いを頁ごとに挙げる', () => {
    const result = compareOutput(
      [page(), page(), page()],
      [
        page({ size: { width: 200, height: 100 } }),
        page({ signature: { length: 0, hash: '811c9dc5' } }),
        page({ digest: 'd2', signature: { length: 5, hash: 'zzz' } }),
      ]
    );

    expect(result.ok).toBe(false);
    expect(result.mismatches.map((m) => m.reasons)).toEqual([
      ['大きさ・向きが元の頁と違います'],
      ['文字情報（検索できる文字）が失われています'],
      ['文字情報が元の頁と違います', '画像・描く中身が元の頁と違います'],
    ]);
    expect(result.textPages).toBe(2);
  });

  it('頁の数が違えば ok にしない', () => {
    expect(compareOutput([page(), page()], [page()]).ok).toBe(false);
  });
});

describe('pageDigest', () => {
  // 1×1 の PNG（赤と青）。
  const RED = Uint8Array.from(
    atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'),
    (c) => c.charCodeAt(0)
  );
  const BLUE = Uint8Array.from(
    atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC'),
    (c) => c.charCodeAt(0)
  );

  async function scanPage(png) {
    const doc = await PDFDocument.create();
    const image = await doc.embedPng(png);
    const page = doc.addPage(SIZE);
    page.drawImage(image, { x: 0, y: 0, width: SIZE[0], height: SIZE[1] });
    // 画像は保存するときに書き込まれるので、保存したものを読み直す（結合でも、
    // 元のファイル・結合した PDF とも、保存されたものを読む）。
    return (await PDFDocument.load(await doc.save())).getPage(0);
  }

  it('同じ描き方でも、画像が違えば別の指紋になる（スキャンの画像まで見る）', async () => {
    const red = await pageDigest(await scanPage(RED));
    const blue = await pageDigest(await scanPage(BLUE));

    expect(red).toMatch(/^[0-9a-f]{64}$/);
    expect(red).toBe(await pageDigest(await scanPage(RED)));
    expect(blue).not.toBe(red);
  });

  it('描くものの無い頁にも指紋がある', async () => {
    const doc = await PDFDocument.create();
    doc.addPage(SIZE);

    expect(await pageDigest(doc.getPage(0))).toMatch(/^[0-9a-f]{64}$/);
  });
});
