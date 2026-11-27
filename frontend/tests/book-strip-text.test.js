// PDF 結合ツール: 頁の文字情報（透明な文字）を消す（strip-text.js）。
//
// pdf-lib で「画像と透明な文字」の頁（スキャナの形と、文字をフォームに入れた
// OCRmyPDF の形）を作り、消したあとに画面と同じ pdf.js（Node 向けの legacy
// ビルド）で読み直して、文字情報が無くなること・画像と見える文字は残ること・
// ほかの頁と共有しているものを書き換えないことを縛る。

import { PDFDict, PDFDocument, PDFName, PDFRawStream, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { contentBytes } from '../src/pdf-book-merger/content-stream.js';
import { pageDigest, writeMergedPdf } from '../src/pdf-book-merger/merge.js';
import { applyEdits, planContent, stripInvisibleText } from '../src/pdf-book-merger/strip-text.js';

const encode = (text) => new TextEncoder().encode(text);
const decode = (bytes) => new TextDecoder('latin1').decode(bytes);
const plan = (text, mode) => planContent(encode(text), mode);
/** 置き換えを当てた中身（空白をまとめる）。 */
const stripped = (text, mode) => decode(applyEdits(encode(text), plan(text, mode).edits)).replace(/\s+/g, ' ').trim();

describe('planContent', () => {
  it('透明な文字だけの BT … ET から、文字を描く命令をオペランドごと消す（状態の命令は残す）', () => {
    const text = 'q /Im0 Do Q BT /F1 9 Tf 3 Tr 1 0 0 1 10 20 Tm (abc) Tj [(d) -20 (e)] TJ ET';
    const result = plan(text);
    expect(result).toMatchObject({ removed: 2, kept: 0, forms: [{ name: 'Im0', mode: 0 }] });
    expect(result.edits.map(({ start, end }) => text.slice(start, end))).toEqual(['(abc) Tj', '[(d) -20 (e)] TJ']);
    expect(stripped(text)).toBe('q /Im0 Do Q BT /F1 9 Tf 3 Tr 1 0 0 1 10 20 Tm ET');
  });

  it("' は行送りに、\" は語間・字間と行送りに置き換える", () => {
    expect(stripped("BT 3 Tr (a) ' 2 0.5 (b) \" ET")).toBe('BT 3 Tr T* 2 Tw 0.5 Tc T* ET');
  });

  it('空白を挟まずに書いた中身でも、前後の命令をつなげない', () => {
    expect(stripped("BT 3 Tr 10 10 Td(a)'(b)'(c)Tj/F1 9 Tf ET")).toBe('BT 3 Tr 10 10 Td T* T* /F1 9 Tf ET');
  });

  it('見える文字の混ざる BT … ET は、透明な文字も残す（後ろの見える文字の位置を変えない）', () => {
    const result = plan('BT 3 Tr (a) Tj 0 Tr (b) Tj ET BT 3 Tr (c) Tj ET');
    expect(result.removed).toBe(1);
    expect(result.kept).toBe(2);
    expect(result.edits).toHaveLength(1);
  });

  it('描き方は q … Q で戻し、BT をまたいで受け継ぐ（フォームは呼んだところの描き方から始める）', () => {
    expect(plan('q 3 Tr Q BT (a) Tj ET').removed).toBe(0);
    expect(plan('3 Tr BT (a) Tj ET').removed).toBe(1);
    expect(plan('BT (a) Tj ET', 3).removed).toBe(1);
    // 対応の無い Q・読めない Tr は、描き方を変えない。
    expect(plan('Q BT (a) Tj ET', 3).removed).toBe(1);
    expect(plan('/x Tr BT (a) Tj ET', 3).removed).toBe(1);
    expect(plan('3 Tr q 0 Tr /Fm0 Do Q /Fm1 Do').forms).toEqual([
      { name: 'Fm0', mode: 0 },
      { name: 'Fm1', mode: 3 },
    ]);
  });

  it('壊れた中身（BT の外の文字・閉じない BT・読めない "）には手を付けない', () => {
    expect(plan('3 Tr (a) Tj ET')).toMatchObject({ removed: 0, kept: 1, edits: [] });
    expect(plan('3 Tr BT (a) Tj')).toMatchObject({ removed: 0, kept: 1, edits: [] });
    // 閉じずに次の BT が来たら、前の BT … ET はそこで閉じたものとして数える。
    expect(plan('BT 0 Tr (vis) Tj BT 3 Tr (x) Tj ET')).toMatchObject({ removed: 1, kept: 1 });
    expect(plan('3 Tr BT /x 0 (a) " ET')).toMatchObject({ removed: 0, kept: 1, edits: [] });
    // 名前の無い Do は、フォームとして数えない。
    expect(plan('(x) Do').forms).toEqual([]);
  });

  it('インライン画像があれば、命令を最後まで読めないので null', () => {
    expect(plan('BT 3 Tr (a) Tj ET BI /W 1 /H 1 ID \x00 EI')).toBeNull();
  });
});

// --- 頁 --------------------------------------------------------------------------

const SIZE = [200, 300];

/** 1×1 の灰色の画像（文字の無い XObject）。 */
function image(doc) {
  return doc.context.register(
    doc.context.stream(new Uint8Array([128]), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 1,
      Height: 1,
      ColorSpace: 'DeviceGray',
      BitsPerComponent: 8,
    })
  );
}

function form(doc, content, resources) {
  return doc.context.register(
    doc.context.flateStream(content, {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, ...SIZE],
      ...(resources ? { Resources: resources } : {}),
    })
  );
}

/** 頁を足す（中身と資源を直に指定する）。 */
function addPage(doc, content, resources) {
  const page = doc.addPage(SIZE);
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content)));
  page.node.set(PDFName.of('Resources'), doc.context.obj(resources));
  return page;
}

const TEXT = (words, mode = 3) => `BT /F1 12 Tf ${mode} Tr 20 150 Td (${words}) Tj ET`;
const IMAGE = 'q 200 0 0 300 0 0 cm /Im0 Do Q';

/** 作った PDF を保存して読み直す（中身は、スキャナの PDF と同じく読んだストリームになる）。 */
async function reload(doc) {
  return PDFDocument.load(await doc.save());
}

async function texts(bytes) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(content.items.map((item) => item.str).join(''));
  }
  await doc.loadingTask.destroy();
  return pages;
}

describe('stripInvisibleText', () => {
  it('スキャナの形（画像と透明な文字）の頁から文字情報を消し、画像と見える文字は残す', async () => {
    const doc = await PDFDocument.create();
    const font = (await doc.embedFont(StandardFonts.Helvetica)).ref;
    const im = image(doc);
    addPage(doc, `${IMAGE} ${TEXT('hidden')} ${TEXT('shown', 0)}`, { Font: { F1: font }, XObject: { Im0: im } });
    addPage(doc, `${IMAGE} ${TEXT('other')}`, { Font: { F1: font }, XObject: { Im0: im } });
    const loaded = await reload(doc);
    const [first, second] = loaded.getPages();
    const contents = first.node.Contents();
    const before = await pageDigest(second);

    // 数えるだけなら、何も変えない。
    expect(stripInvisibleText(first)).toEqual({ removed: 1, kept: 1 });
    expect(first.node.Contents()).toBe(contents);

    expect(stripInvisibleText(first, { write: true })).toEqual({ removed: 1, kept: 1 });
    expect(first.node.Contents()).not.toBe(contents);
    expect(decode(contentBytes(first.node))).toContain('/Im0 Do');
    expect(await texts(await loaded.save())).toEqual(['shown', 'other']);
    expect(await pageDigest(second)).toBe(before);
  });

  it('消すものが無ければ書き換えない', async () => {
    const doc = await PDFDocument.create();
    const font = (await doc.embedFont(StandardFonts.Helvetica)).ref;
    addPage(doc, TEXT('shown', 0), { Font: { F1: font } });
    const loaded = await reload(doc);
    const page = loaded.getPage(0);
    const contents = page.node.Contents();
    expect(stripInvisibleText(page, { write: true })).toEqual({ removed: 0, kept: 1 });
    expect(page.node.Contents()).toBe(contents);
  });

  it('フォームに入れた透明な文字（OCRmyPDF の形）は、写しを作って消し、共有するほかの頁は変えない', async () => {
    const doc = await PDFDocument.create();
    const font = (await doc.embedFont(StandardFonts.Helvetica)).ref;
    const im = image(doc);
    // 文字の層のフォーム（資源を自分で持つ）と、その中で呼ぶ、資源を持たない入れ子のフォーム。
    const inner = form(doc, TEXT('inner'));
    const layer = form(doc, `${TEXT('layer')} /Fm9 Do /Im0 Do /Nope Do`, doc.context.obj({
      Font: { F1: font },
      XObject: { Fm9: inner, Im0: im },
    }));
    const resources = doc.context.register(doc.context.obj({ Font: { F1: font }, XObject: { Im0: im, Fm0: layer } }));
    // 同じフォームを 2 度呼ぶ頁と、同じ資源・フォームを共有する頁。
    addPage(doc, `${IMAGE} q /Fm0 Do Q q /Fm0 Do Q`, resources);
    addPage(doc, `${IMAGE} q /Fm0 Do Q`, resources);
    const loaded = await reload(doc);
    const [first, second] = loaded.getPages();
    const sharedResources = first.node.get(PDFName.of('Resources'));
    const before = await pageDigest(second);

    expect(stripInvisibleText(first)).toEqual({ removed: 4, kept: 0 });
    const cache = new Map();
    expect(stripInvisibleText(first, { write: true, cache })).toEqual({ removed: 4, kept: 0 });
    // 頁の中身は変わらず、資源の写しから、書き換えたフォームを指す。
    expect(first.node.get(PDFName.of('Resources'))).not.toBe(sharedResources);
    expect(second.node.get(PDFName.of('Resources'))).toBe(sharedResources);
    const xobjects = first.node.Resources().lookup(PDFName.of('XObject'));
    const copy = xobjects.lookup(PDFName.of('Fm0'));
    expect(copy).toBeInstanceOf(PDFRawStream);
    expect(xobjects.get(PDFName.of('Im0'))).toBe(second.node.Resources().lookup(PDFName.of('XObject')).get(PDFName.of('Im0')));
    // 2 度呼んだフォームも、写しは 1 つ（資源を持つ文字の層だけを使い回す）。
    expect(cache.size).toBe(1);

    const saved = await loaded.save();
    expect(await texts(saved)).toEqual(['', 'layerinner']);
    expect(await pageDigest(second)).toBe(before);
  });

  it('資源を持たないフォームは呼んだところの資源で読み、描き方を受け継ぐフォームは、呼んだ描き方ごとに数える', async () => {
    const doc = await PDFDocument.create();
    const font = (await doc.embedFont(StandardFonts.Helvetica)).ref;
    const layer = form(doc, TEXT('layer'));
    // 自分の文字は無く、呼んだところの資源にある文字の層を呼ぶだけのフォーム（写しには資源を持たせる）。
    const wrapper = form(doc, '/Fm9 Do');
    // 描き方を指定しない文字のフォーム（呼んだところの描き方で描く）。
    const plain = form(doc, 'BT /F1 12 Tf 20 100 Td (plain) Tj ET', doc.context.obj({ Font: { F1: font } }));
    const resources = { Font: { F1: font }, XObject: { Fm9: layer, W: wrapper, P: plain, P2: plain } };
    addPage(doc, '/W Do /P Do 3 Tr /P2 Do', resources);
    addPage(doc, '/P Do 3 Tr /P Do', resources); // 同じ名前を、違う描き方で呼ぶ
    addPage(doc, '/P Do /P Do', resources);
    addPage(doc, '3 Tr /P Do 0 Tr /P Do', resources); // 消す描き方が先
    const loaded = await reload(doc);
    const [first, second, third, fourth] = loaded.getPages();

    // 数えるだけなら、写しを作らない。
    expect(stripInvisibleText(first)).toEqual({ removed: 2, kept: 1 });
    expect(first.node.Resources().lookup(PDFName.of('XObject')).get(PDFName.of('W'))).toBe(
      second.node.Resources().lookup(PDFName.of('XObject')).get(PDFName.of('W'))
    );
    expect(stripInvisibleText(first, { write: true })).toEqual({ removed: 2, kept: 1 });
    const copy = first.node.Resources().lookup(PDFName.of('XObject')).lookup(PDFName.of('W'));
    expect(copy.dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('XObject'))).toBeInstanceOf(PDFDict);
    // 1 つの名前で、消す描き方と消さない描き方の両方を指すことになる頁は、消さない。
    expect(stripInvisibleText(second)).toBeNull();
    expect(stripInvisibleText(fourth, { write: true })).toBeNull();
    expect(stripInvisibleText(third)).toEqual({ removed: 0, kept: 2 });

    expect(await texts(await loaded.save())).toEqual(['plain', 'plainplain', 'plainplain', 'plainplain']);
  });

  it('資源を持たないフォームの写しは、資源の違う頁どうしで使い回さない', async () => {
    const doc = await PDFDocument.create();
    const font = (await doc.embedFont(StandardFonts.Helvetica)).ref;
    const wrapper = form(doc, '/Fm9 Do');
    const layerA = form(doc, `${TEXT('a')} ${TEXT('A', 0)}`, doc.context.obj({ Font: { F1: font } }));
    const layerB = form(doc, `${TEXT('b')} ${TEXT('B', 0)}`, doc.context.obj({ Font: { F1: font } }));
    addPage(doc, '/W Do', { XObject: { W: wrapper, Fm9: layerA } });
    addPage(doc, '/W Do', { XObject: { W: wrapper, Fm9: layerB } });
    const loaded = await reload(doc);
    const cache = new Map();
    for (const page of loaded.getPages()) {
      expect(stripInvisibleText(page, { write: true, cache })).toEqual({ removed: 1, kept: 1 });
    }
    expect(await texts(await loaded.save())).toEqual(['A', 'B']);
  });

  it('読めない頁（インライン画像・展開できない中身・入れ子の深すぎるフォーム・自分を呼ぶフォーム）は null', async () => {
    const doc = await PDFDocument.create();
    const font = (await doc.embedFont(StandardFonts.Helvetica)).ref;
    // 自分を呼ぶフォーム。
    const loop = doc.context.nextRef();
    doc.context.assign(loop, doc.context.flateStream('/Fm0 Do', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1] }));
    addPage(doc, `${TEXT('a')} /Fm0 Do`, { Font: { F1: font }, XObject: { Fm0: loop } });
    // 6 段の入れ子。
    let nested = form(doc, TEXT('deep'));
    for (let i = 0; i < 5; i++) nested = form(doc, '/Fm0 Do', doc.context.obj({ XObject: { Fm0: nested } }));
    addPage(doc, '/Fm0 Do', { Font: { F1: font }, XObject: { Fm0: nested } });
    addPage(doc, `${TEXT('a')} BI /W 1 /H 1 ID \x00 EI`, { Font: { F1: font } });
    const broken = addPage(doc, TEXT('a'), { Font: { F1: font } });
    broken.node.set(
      PDFName.of('Contents'),
      doc.context.register(doc.context.stream(new Uint8Array([1, 2, 3]), { Filter: 'JBIG2Decode' }))
    );
    // 展開できないフォーム（数えるときに投げず、消せないものとする）。
    const opaque = doc.context.register(
      doc.context.stream(new Uint8Array([1, 2, 3]), { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], Filter: 'JBIG2Decode' })
    );
    addPage(doc, '/Fm0 Do', { XObject: { Fm0: opaque } });
    const loaded = await reload(doc);
    for (const page of loaded.getPages()) expect(stripInvisibleText(page, { write: true })).toBeNull();

    // 保存する前の、pdf-lib が組み立てている中身も読めない。
    const fresh = await PDFDocument.create();
    fresh.addPage().drawText('x');
    expect(stripInvisibleText(fresh.getPage(0))).toBeNull();
  });
});

describe('writeMergedPdf の removeText', () => {
  it('選んだ頁だけ文字情報を消して結合し、消したあとの指紋と、消した数を返す', async () => {
    const doc = await PDFDocument.create();
    const font = (await doc.embedFont(StandardFonts.Helvetica)).ref;
    const im = image(doc);
    const resources = { Font: { F1: font }, XObject: { Im0: im } };
    addPage(doc, `${IMAGE} ${TEXT('one')}`, resources);
    addPage(doc, `${IMAGE} ${TEXT('two')}`, resources);
    const bytes = await doc.save();
    const sources = new Map([['a', { name: 'a.pdf', load: async () => bytes }]]);
    const order = [
      { fileKey: 'a', pageIndex: 1 },
      { fileKey: 'a', pageIndex: 0 },
    ];
    const chunks = [];
    const { digests, removed } = await writeMergedPdf({
      sources,
      order,
      title: 't',
      removeText: new Set(['a:0']),
      write: (chunk) => chunks.push(chunk),
    });
    const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let at = 0;
    for (const chunk of chunks) {
      merged.set(chunk, at);
      at += chunk.length;
    }

    expect(removed).toEqual([null, { removed: 1, kept: 0 }]);
    expect(await texts(merged)).toEqual(['two', '']);
    const reread = await PDFDocument.load(merged);
    expect(await Promise.all(reread.getPages().map((page) => pageDigest(page)))).toEqual(digests);
    const original = await PDFDocument.load(bytes);
    expect(digests[0]).toBe(await pageDigest(original.getPage(1)));
    expect(digests[1]).not.toBe(await pageDigest(original.getPage(0)));
  });

  it('消せない頁を選ばれたら、ファイル名と頁を添えて止める', async () => {
    const doc = await PDFDocument.create();
    const font = (await doc.embedFont(StandardFonts.Helvetica)).ref;
    addPage(doc, `${TEXT('a')} BI /W 1 /H 1 ID \x00 EI`, { Font: { F1: font } });
    const bytes = await doc.save();
    await expect(
      writeMergedPdf({
        sources: new Map([['a', { name: 'a.pdf', load: async () => bytes }]]),
        order: [{ fileKey: 'a', pageIndex: 0 }],
        title: 't',
        removeText: new Set(['a:0']),
        write: () => {},
      })
    ).rejects.toThrow('「a.pdf」の 1 頁目の文字情報を消せませんでした（頁の中身が、読めないか、消せない形です）。');
  });
});
