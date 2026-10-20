// @vitest-environment jsdom
//
// 書籍スキャン PDF 結合ツールの画面（main.js）。
//
// pdf.js・OCR・Drive・結合（pdf-lib）は偽物に差し替え、実際のページの
// マークアップ（page.html / overlay.html）の上で、利用者の操作の流れを通す。
//
//   ファイルを足す → 番号を読んで並べる → 役割・番号を直す → 確かめる
//   → 結合して検証する → ダウンロード / Drive に保存
//
// 偽物の PDF は「%PDF-」に続けて頁の仕様（JSON）を書いたバイト列で、
// openPdf / readPage の偽物がそれを読む。番号の推定・並び・検査は本物の
// 部品（page-numbers.js / ordering.js / image-checks.js / review.js）が動く。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// vitest は frontend/ で動く（jsdom では import.meta.url が file: にならない）。
const SRC = resolve('src/pdf-book-merger');

// --- 偽物 ----------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 偽物の PDF。pages は頁ごとの仕様（number: 余白の文字情報に載せる番号）。 */
function pdf(pages, extra = {}) {
  return encoder.encode(`%PDF-${JSON.stringify({ pages, ...extra })}`);
}
const specOf = (bytes) => JSON.parse(decoder.decode(bytes).slice('%PDF-'.length));

/** 本文の頁。ocr: 文字情報には無く、画像からだけ読める番号。 */
const page = (id, number, extra = {}) => ({ id, number, ...extra });

const mocks = vi.hoisted(() => ({
  // 真っすぐな文字の行が並んだ白黒画像（白紙・傾きの指摘を出さないため）。
  image() {
    const width = 200;
    const height = 280;
    const gray = new Uint8Array(width * height).fill(245);
    for (let y = 30; y < 250; y += 14) {
      for (let x = 30; x < 170; x++) {
        if (x % 9 === 0) continue;
        for (let k = 0; k < 4; k++) gray[(y + k) * width + x] = 20;
      }
    }
    return { width, height, gray };
  },
  findScanImages: vi.fn(),
  renderPageImage: vi.fn(),
  renderMargins: vi.fn(),
  prepare: null,
  pickFiles: vi.fn(),
  downloadDriveFile: vi.fn(),
  prepareOcr: vi.fn(),
  readStrip: vi.fn(),
  renderPreview: vi.fn(),
  closePdf: vi.fn(),
  mergePdf: vi.fn(),
}));

vi.mock('../src/page-start.js', () => ({
  startPage: ({ prepare }) => {
    mocks.prepare = prepare;
  },
}));
vi.mock('../src/drive-picker.js', () => ({
  pickFiles: (...args) => mocks.pickFiles(...args),
}));
vi.mock('../src/pdf-book-merger/drive-download.js', () => ({
  downloadDriveFile: (...args) => mocks.downloadDriveFile(...args),
}));
vi.mock('../src/pdf-book-merger/scan-images.js', () => ({
  findScanImages: (...args) => mocks.findScanImages(...args),
}));
vi.mock('../src/pdf-book-merger/ocr.js', () => ({
  prepareOcr: (...args) => mocks.prepareOcr(...args),
  readStrip: (...args) => mocks.readStrip(...args),
}));
vi.mock('../src/pdf-book-merger/merge.js', () => ({
  mergePdf: (...args) => mocks.mergePdf(...args),
  // 結合した PDF の頁の「描くもの」の指紋。壊れた頁（corrupt）だけ違う指紋になる。
  pageDigests: async (bytes) =>
    JSON.parse(new TextDecoder().decode(bytes).slice('%PDF-'.length)).pages.map((p) =>
      p.corrupt ? 'broken' : `d-${p.id}`
    ),
}));

// pdf.js の偽物。頁の仕様から、文字情報・測定用の画像・縮小画像を作る。
vi.mock('../src/pdf-book-merger/pdf-source.js', () => {
  const bottomNumber = (value) => [{ text: String(value), x0: 0.48, x1: 0.52, y: 0.95, h: 0.012 }];
  return {
    openPdf: async (bytes) => {
      const text = new TextDecoder().decode(bytes);
      const spec = JSON.parse(text.slice('%PDF-'.length));
      return {
        spec,
        numPages: spec.pages.length,
        getPageLabels: async () => spec.labels ?? null,
        getMetadata: async () => ({ info: { Title: spec.title ?? '' } }),
      };
    },
    readPageText: async (doc, index) => {
      const p = doc.spec.pages[index];
      if (p.broken) throw new Error(p.broken);
      return {
        size: p.size ?? { width: 364, height: 515 },
        items: p.number && !p.ocr ? bottomNumber(p.number) : [],
        signature: { length: p.noText ? 0 : 12, hash: `h-${p.id}` },
      };
    },
    renderPageImage: (...args) => mocks.renderPageImage(...args),
    renderMargins: (...args) => mocks.renderMargins(...args),
    renderPreview: (...args) => mocks.renderPreview(...args),
    closePdf: (...args) => mocks.closePdf(...args),
    releaseCanvas: () => {},
  };
});

// --- ページ ----------------------------------------------------------------------

function installPage() {
  const pageHtml = readFileSync(resolve(SRC, 'page.html'), 'utf8');
  const overlay = readFileSync(resolve(SRC, 'overlay.html'), 'utf8');
  document.body.innerHTML = `<div id="app">${pageHtml}</div>${overlay}`;
}

const $ = (id) => document.getElementById(id);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** ファイルの読み込みが終わり、一覧に役割の選択が並ぶまで待つ。 */
async function settled(count) {
  await vi.waitFor(
    () => {
      const items = [...document.querySelectorAll('#fileList .bm-file')];
      expect(items).toHaveLength(count);
      for (const item of items) {
        expect(item.querySelector('select') || item.classList.contains('error')).toBeTruthy();
      }
      expect($('progress').hidden).toBe(true);
    },
    { timeout: 4000, interval: 10 }
  );
}

function drop(files) {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files } });
  $('filesSection').dispatchEvent(event);
}

function file(name, bytes) {
  return new File([bytes], name, { type: 'application/pdf' });
}

function fileItem(name) {
  return [...document.querySelectorAll('#fileList .bm-file')].find(
    (item) => item.querySelector('.name').textContent === name
  );
}

function change(element, value) {
  element.value = value;
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

/** 一覧の札の見出し（抜けの札は「-n」）。 */
function gridLabels() {
  return [...document.querySelectorAll('#pageGrid > li')].map((card) =>
    card.classList.contains('missing')
      ? `-${card.querySelector('.bm-missing-label').textContent}`
      : card.querySelector('.bm-page-label strong').textContent
  );
}

const ODD = [page('o1', 1), page('o3', 3), page('o5', 5, { ocr: true }), page('o7', 7)];
const EVEN = [page('e8', 8), page('e6', 6), page('e4', 4), page('e2', 2)];
const COVER = [page('c1', null), page('c2', null)];

// --- 準備 ----------------------------------------------------------------------

let created;

beforeAll(async () => {
  // jsdom に無いもの。
  HTMLDialogElement.prototype.showModal ??= function showModal() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function close() {
    if (!this.open) return;
    this.open = false;
    // ブラウザと同じく、close は後から届く。
    setTimeout(() => this.dispatchEvent(new Event('close')), 0);
  };
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
});

beforeEach(async () => {
  vi.resetModules();
  Object.values(mocks).forEach((mock) => typeof mock === 'function' && mock.mockReset?.());
  mocks.prepareOcr.mockResolvedValue({});
  mocks.readStrip.mockImplementation(async (strip) =>
    strip.zone === 'bottom' && strip.page.ocr ? [{ text: String(strip.page.number), x0: 0.48, x1: 0.52, y: 0.95, h: 0.012 }] : []
  );
  mocks.renderPreview.mockResolvedValue('blob:preview');
  // 頁の仕様に jpeg: false と書いた頁のほかは、JPEG 1 枚の頁として見つかる。
  mocks.findScanImages.mockImplementation(async (bytes) =>
    specOf(bytes).pages.map((p) => (p.jpeg === false ? null : { jpeg: p.id }))
  );
  // 縮小画像の URL に、どちらで描いたか（JPEG を展開 / pdf.js）を残す。
  const strips = (doc, index) => [
    { zone: 'top', canvas: {}, top: 0, height: 0.14, page: doc.spec.pages[index] },
    { zone: 'bottom', canvas: {}, top: 0.86, height: 0.14, page: doc.spec.pages[index] },
  ];
  // OCR する頁は、同じ展開から余白の帯も描く（margins）。
  mocks.renderPageImage.mockImplementation(async (doc, index, scan, { margins = false } = {}) => ({
    image: mocks.image(),
    thumbUrl: `blob:${scan ? 'scan' : 'pdfjs'}-${doc.spec.pages[index].id}`,
    strips: margins ? strips(doc, index) : [],
  }));
  mocks.renderMargins.mockImplementation(async (doc, index) => strips(doc, index));
  mocks.closePdf.mockResolvedValue(undefined);
  mocks.mergePdf.mockImplementation(async ({ sources, order, title, labels, onProgress }) => {
    const { pageLabelTexts } = await import('../src/pdf-book-merger/ordering.js');
    const pages = order.map((entry) => specOf(sources.get(entry.fileKey).bytes).pages[entry.pageIndex]);
    onProgress?.(order.length, order.length);
    return {
      bytes: pdf(pages, { title, labels: pageLabelTexts(labels, order.length) }),
      digests: pages.map((p) => `d-${p.id}`),
    };
  });

  created = [];
  URL.createObjectURL = vi.fn(() => {
    created.push(`blob:${created.length}`);
    return created.at(-1);
  });
  URL.revokeObjectURL = vi.fn();
  window.confirm = vi.fn(() => true);

  installPage();
  await import('../src/pdf-book-merger/main.js');
  await mocks.prepare();
});

afterEach(() => {
  document.body.innerHTML = '';
});

async function addBook() {
  drop([file('猫_奇数.pdf', pdf(ODD)), file('猫_偶数.pdf', pdf(EVEN)), file('猫_表紙.pdf', pdf(COVER))]);
  await settled(3);
}

// --- 操作の流れ -----------------------------------------------------------------

describe('ファイルを足して並べる', () => {
  it('束を頁番号で 1 冊に並べ、画像から読んだ番号も使う', async () => {
    await addBook();

    // 名前に「表紙」とあるファイルは先頭へ。
    expect(gridLabels()).toEqual(['表紙', '表紙', '1 頁', '2 頁', '3 頁', '4 頁', '5 頁', '6 頁', '7 頁', '8 頁']);
    expect(fileItem('猫_奇数.pdf').querySelector('.hint').textContent).toContain(
      '奇数頁 1〜7・番号を読めた頁 4（うち画像から 1）'
    );
    expect(fileItem('猫_偶数.pdf').querySelector('.hint').textContent).toContain('偶数頁（逆順） 8〜2');
    expect($('summary').textContent).toContain('1〜8（8 頁）');
    expect($('checkSection').hidden).toBe(false);
    expect($('outputName').value).toBe('猫.pdf');
    expect($('problems').textContent).toContain('見つかりませんでした');
    // 画像から読むのは、文字情報に番号が無かった頁だけ（表紙は名前で分かるので読まない）。
    expect(mocks.readStrip).toHaveBeenCalledTimes(2);
  });

  it('役割を変えると並びが変わる（表紙と裏表紙を 1 回で取ったファイル）', async () => {
    await addBook();

    change(fileItem('猫_表紙.pdf').querySelector('select'), 'split');

    const labels = gridLabels();
    expect(labels[0]).toBe('表紙');
    expect(labels.at(-1)).toBe('裏表紙');
    expect(labels).toHaveLength(10);
  });

  it('逆順のファイルは、頁を並べ直してから置く（給紙の都合で最後の頁から並んだ表紙）', async () => {
    await addBook();
    change(fileItem('猫_表紙.pdf').querySelector('select'), 'split');
    const firstAndLast = () => {
      const cards = [...document.querySelectorAll('#pageGrid > li')];
      return [cards[0].dataset.pageKey, cards.at(-1).dataset.pageKey];
    };
    expect(firstAndLast()).toEqual(['f3:0', 'f3:1']);

    const reverse = fileItem('猫_表紙.pdf').querySelector('input[type="checkbox"]');
    reverse.checked = true;
    reverse.dispatchEvent(new Event('change'));

    expect(firstAndLast()).toEqual(['f3:1', 'f3:0']);
    expect(fileItem('猫_表紙.pdf').querySelector('input[type="checkbox"]').checked).toBe(true);
    // 本文は頁番号から並ぶので、逆順にしても並びは変わらない。
    const odd = fileItem('猫_奇数.pdf').querySelector('input[type="checkbox"]');
    odd.checked = true;
    odd.dispatchEvent(new Event('change'));
    expect(gridLabels().slice(1, 9)).toEqual(['1 頁', '2 頁', '3 頁', '4 頁', '5 頁', '6 頁', '7 頁', '8 頁']);
  });

  it('束を外すと、抜けた頁をあるべき位置に札で出し、指摘する', async () => {
    await addBook();

    fileItem('猫_偶数.pdf').querySelector('button[aria-label="このファイルを外す"]').click();

    expect(gridLabels()).toEqual(['表紙', '表紙', '1 頁', '-2 頁', '3 頁', '-4 頁', '5 頁', '-6 頁', '7 頁']);
    expect($('problems').textContent).toContain('2・4・6 頁が見つかりません');
    expect(mocks.closePdf).toHaveBeenCalled();
  });

  it('ファイルの並びを入れ替えられる（先頭に置くファイルの順番）', async () => {
    await addBook();
    const names = () => [...document.querySelectorAll('#fileList .name')].map((n) => n.textContent);

    fileItem('猫_表紙.pdf').querySelector('button[aria-label^="ひとつ上へ"]').click();
    expect(names()).toEqual(['猫_奇数.pdf', '猫_表紙.pdf', '猫_偶数.pdf']);
    fileItem('猫_表紙.pdf').querySelector('button[aria-label="ひとつ下へ"]').click();
    expect(names()).toEqual(['猫_奇数.pdf', '猫_偶数.pdf', '猫_表紙.pdf']);
  });

  it('頁ごと・ファイルごとに番号を直せる', async () => {
    await addBook();

    // 1 頁を 4.5 に動かす（4 頁と 5 頁の間へ）。
    const first = document.querySelector('#pageGrid [data-page-key$=":0"] .bm-page-number');
    change(first, '4.5');
    expect(gridLabels().slice(2, 8)).toEqual(['2 頁', '3 頁', '4 頁', '4と5の間 頁', '5 頁', '6 頁']);
    // 1 頁が動いたので、最初の頁が偶数（2 頁）になった。
    expect($('problems').textContent).toContain('最初の頁が偶数（2 頁）です。');

    // 数字でなければ断る。
    change(document.querySelector('#pageGrid [data-page-key$=":1"] .bm-page-number'), 'abc');
    expect($('message').textContent).toBe('番号は数字で入れてください。');

    // ファイルの先頭の番号を手で決める（奇数頁の束を 11 から）。
    const startField = fileItem('猫_奇数.pdf').querySelector('.bm-file-controls input[type="text"]');
    change(startField, '11');
    expect(gridLabels()).toContain('17 頁');
    change(fileItem('猫_奇数.pdf').querySelector('.bm-file-controls input[type="text"]'), '1.5');
    expect($('message').textContent).toBe('先頭の頁の番号は整数で入れてください。');
    change(fileItem('猫_奇数.pdf').querySelector('.bm-file-controls input[type="text"]'), '');
    expect(gridLabels()).toContain('7 頁');
  });

  it('頁を読めなければ、何頁目のどこで止まったかを添えて一覧に残す', async () => {
    drop([file('壊れた.pdf', pdf([page('ok', 1), { id: 'bad', number: 3, broken: 'The object is in an invalid state.' }]))]);
    await settled(1);

    expect(fileItem('壊れた.pdf').textContent).toContain(
      '2 頁目を読めませんでした（The object is in an invalid state.）'
    );
  });

  it('PDF でないファイルは、理由を添えて一覧に残す', async () => {
    drop([file('memo.pdf', encoder.encode('hello')), new File(['x'], 'note.txt', { type: 'text/plain' })]);
    await settled(1);

    expect($('message').textContent).toBe('PDF 以外のファイルは外しました。');
    expect(fileItem('memo.pdf').classList.contains('error')).toBe(true);
    expect(fileItem('memo.pdf').textContent).toContain('PDF ファイルではありません。');
  });

  it('Drive から選んだファイルを、進み具合を出しながら読む', async () => {
    mocks.pickFiles.mockResolvedValue([
      { id: 'd-even', name: 'book-b-even.pdf' },
      { id: 'd-odd', name: 'book-a-odd.pdf' },
    ]);
    mocks.downloadDriveFile.mockImplementation(async (picked, { onProgress }) => {
      onProgress(5, 10);
      onProgress(10, 0);
      return pdf(picked.id === 'd-odd' ? ODD : EVEN);
    });

    $('driveBtn').click();
    await settled(2);

    expect(mocks.pickFiles).toHaveBeenCalledWith(expect.objectContaining({ mimeTypes: 'application/pdf' }));
    // 頁の画像は、ブラウザの中で、頁の JPEG を展開して描く（サーバーは使わない）。
    expect(mocks.findScanImages).toHaveBeenCalledTimes(2);
    expect(document.querySelector('#pageGrid img').src).toMatch(/^blob:scan-/);
    // 画像から番号を読む頁（5 頁）の余白も、その頁の JPEG から、同じ展開で描く。
    expect(mocks.renderMargins).not.toHaveBeenCalled();
    const marginCalls = mocks.renderPageImage.mock.calls.filter(([, , , options]) => options?.margins);
    expect(marginCalls.map(([doc, index, scan]) => [doc.spec.pages[index].id, scan])).toEqual([['o5', { jpeg: 'o5' }]]);
    expect(gridLabels()).toContain('5 頁');

    // 拡大表示は pdf.js で描く。
    document.querySelector('#pageGrid .bm-thumb').click();
    await vi.waitFor(() => expect($('previewImage').src).toBe('blob:preview'));
    expect(mocks.renderPreview.mock.calls[0][1]).toBe(0);
    $('previewCloseBtn').click();

    // 名前の順に足す。
    expect([...document.querySelectorAll('#fileList .name')].map((n) => n.textContent)).toEqual([
      'book-a-odd.pdf',
      'book-b-even.pdf',
    ]);
    expect(gridLabels()).toHaveLength(8);

    // 同じファイルは 2 度足さない。
    mocks.pickFiles.mockResolvedValue([{ id: 'd-odd', name: 'book-a-odd.pdf' }]);
    $('driveBtn').click();
    await vi.waitFor(() => expect($('message').textContent).toContain('すでに追加してあります'));
  });

  it('JPEG 1 枚の形でない頁は、pdf.js で描いて読む', async () => {
    const pages = [page('o1', 1), page('o3', 3, { ocr: true, jpeg: false }), page('o5', 5)];
    drop([file('odd.pdf', pdf(pages))]);
    await settled(1);

    // 何頁かを並べて描くので、頼んだ順は前後する。
    const calls = mocks.renderPageImage.mock.calls.map(([, index, scan, options]) => [index, scan, options]);
    expect(calls.sort((a, b) => a[0] - b[0])).toEqual([
      [0, { jpeg: 'o1' }, { margins: false }],
      [1, null, { margins: true }],
      [2, { jpeg: 'o5' }, { margins: false }],
    ]);
    expect(document.querySelector('#pageGrid [data-page-key="f1:1"] img').src).toBe('blob:pdfjs-o3');
    expect(gridLabels()).toEqual(['1 頁', '-2 頁', '3 頁', '-4 頁', '5 頁']);
  });

  it('PDF の中を調べられなければ、すべての頁を pdf.js で描く', async () => {
    mocks.findScanImages.mockResolvedValue([]);
    drop([file('odd.pdf', pdf(ODD))]);
    await settled(1);

    expect(mocks.renderPageImage.mock.calls.every(([, , scan]) => scan === null)).toBe(true);
    expect(gridLabels()).toContain('5 頁');
  });

  it('Drive の選択画面で何も選ばずに閉じたら、何も足さない', async () => {
    mocks.pickFiles.mockResolvedValue([]);

    $('driveBtn').click();
    await flush();

    expect(mocks.pickFiles).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('#fileList .bm-file')).toHaveLength(0);
    expect(mocks.downloadDriveFile).not.toHaveBeenCalled();
  });

  it('OCR を使えなければ、文字情報だけで並べる', async () => {
    mocks.prepareOcr.mockRejectedValue(new Error('network'));

    drop([file('猫_奇数.pdf', pdf(ODD)), file('猫_偶数.pdf', pdf(EVEN))]);
    await settled(2);

    expect($('message').textContent).toContain('画像からの読み取りを使えませんでした（network）');
    // 5 頁は前後から補う。
    expect(gridLabels()).toContain('5 頁');
    expect(document.querySelector('#pageGrid [data-page-key="f1:2"] .bm-status').textContent).toBe('推定');
  });

  it('OCR を後から有効にすると、残りの頁を読む', async () => {
    $('ocrToggle').checked = false;
    drop([file('猫_奇数.pdf', pdf(ODD)), file('猫_偶数.pdf', pdf(EVEN))]);
    await settled(2);
    expect(mocks.readStrip).not.toHaveBeenCalled();

    $('ocrToggle').checked = true;
    $('ocrToggle').dispatchEvent(new Event('change'));

    await vi.waitFor(() =>
      expect(document.querySelector('#pageGrid [data-page-key="f1:2"] .bm-status').textContent).toBe('読取')
    );
  });

  it('ドラッグ中の枠と、手元のファイルの選択', async () => {
    $('filesSection').dispatchEvent(new Event('dragover', { cancelable: true }));
    expect($('filesSection').classList.contains('dragging')).toBe(true);
    $('filesSection').dispatchEvent(new Event('dragleave'));
    expect($('filesSection').classList.contains('dragging')).toBe(false);

    const click = vi.spyOn($('localInput'), 'click').mockImplementation(() => {});
    $('localBtn').click();
    expect(click).toHaveBeenCalled();

    Object.defineProperty($('localInput'), 'files', { value: [file('猫_奇数.pdf', pdf(ODD))], configurable: true });
    $('localInput').dispatchEvent(new Event('change'));
    await settled(1);
  });
});

describe('確かめる', () => {
  it('確認が要る頁だけに絞り、指摘から該当の頁へ飛ぶ', async () => {
    const tilted = { ...ODD[1], size: { width: 515, height: 364 } };
    drop([file('猫_奇数.pdf', pdf([ODD[0], tilted, ODD[2], ODD[3]])), file('猫_偶数.pdf', pdf(EVEN))]);
    await settled(2);

    expect($('problems').textContent).toContain('向きが他と違う頁が 1 頁あります。');

    const radio = document.querySelector('input[name="pageFilter"][value="issues"]');
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
    expect(gridLabels()).toEqual(['3 頁']);

    // 絞った一覧に無い頁へ飛ぶときは、すべての頁に戻す。
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    const jump = [...document.querySelectorAll('#problems li')].find((li) => li.textContent.includes('向き'));
    jump.querySelector('button').click();
    expect(scroll).toHaveBeenCalled();
    expect(document.querySelector('[data-page-key="f1:1"]').classList.contains('focus')).toBe(true);
  });

  it('頁を押すと拡大し、前後の頁へ送れる', async () => {
    await addBook();

    document.querySelector('#pageGrid [data-page-key="f1:0"] .bm-thumb').click();
    await flush();
    expect($('previewDialog').open).toBe(true);
    expect($('previewTitle').textContent).toBe('1 頁（猫_奇数.pdf の 1 頁目）');
    await vi.waitFor(() => expect($('previewImage').src).toBe('blob:preview'));

    $('previewNextBtn').click();
    await vi.waitFor(() => expect($('previewTitle').textContent).toBe('2 頁（猫_偶数.pdf の 4 頁目）'));
    $('previewPrevBtn').click();
    await vi.waitFor(() => expect($('previewTitle').textContent).toBe('1 頁（猫_奇数.pdf の 1 頁目）'));

    $('previewCloseBtn').click();
    expect($('previewDialog').open).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  });
});

describe('結合と検証', () => {
  it('結合した PDF を読み直して検証し、ダウンロードできるようにする', async () => {
    await addBook();
    change(fileItem('猫_表紙.pdf').querySelector('select'), 'split');

    $('mergeBtn').click();
    await vi.waitFor(() => expect($('verifyResult').hidden).toBe(false));

    expect(window.confirm).not.toHaveBeenCalled();
    const { order, title, infoFrom } = mocks.mergePdf.mock.calls[0][0];
    expect(order).toHaveLength(10);
    expect(title).toBe('猫');
    expect(infoFrom).toBe('f1');
    expect($('verifyResult').className).toBe('bm-verify ok');
    expect($('verifyResult').textContent).toContain('10 頁すべてが、元の頁と大きさ・文字情報・画像まで一致しています');
    expect($('verifyResult').textContent).toContain('本の頁番号と一致');
    expect($('verifyResult').textContent).toContain('タイトル: 猫');
    expect($('downloadBtn').disabled).toBe(false);

    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    $('downloadBtn').click();
    expect(click).toHaveBeenCalled();
    expect(URL.createObjectURL).toHaveBeenCalled();

    // 並びが変わったら、結合した PDF は捨てる。
    change(fileItem('猫_表紙.pdf').querySelector('select'), 'front');
    expect($('downloadBtn').disabled).toBe(true);
    expect($('verifyResult').hidden).toBe(true);
  });

  it('問題が残っていれば確かめてから結合し、食い違いは頁ごとに挙げる', async () => {
    drop([file('猫_奇数.pdf', pdf(ODD))]);
    await settled(1);
    // 結合の途中で頁が化けた、という偽物。
    mocks.mergePdf.mockImplementation(async ({ sources, order, title }) => {
      const source = order.map((entry) => specOf(sources.get(entry.fileKey).bytes).pages[entry.pageIndex]);
      const pages = source.map((p, i) => ({ ...p, noText: true, corrupt: i === 0 }));
      return { bytes: pdf(pages, { title, labels: null }), digests: source.map((p) => `d-${p.id}`) };
    });

    window.confirm.mockReturnValueOnce(false);
    $('mergeBtn').click();
    await flush();
    expect(window.confirm.mock.calls[0][0]).toContain('頁が見つかりません');
    expect(mocks.mergePdf).not.toHaveBeenCalled();

    $('mergeBtn').click();
    await vi.waitFor(() => expect($('verifyResult').hidden).toBe(false));
    expect($('verifyResult').className).toBe('bm-verify ng');
    expect($('verifyResult').textContent).toContain('検証で食い違いが見つかりました（4 頁）');
    expect($('verifyResult').textContent).toContain('文字情報（検索できる文字）が失われています');
    expect($('verifyResult').textContent).toContain('1 枚目（1 頁）: 文字情報（検索できる文字）が失われています・画像・描く中身が元の頁と違います');
    expect($('verifyResult').textContent).toContain('書き込みを確かめられませんでした');
  });

  it('結合に失敗したら理由を出す', async () => {
    await addBook();
    mocks.mergePdf.mockRejectedValue(new Error('「猫_奇数.pdf」は暗号化（パスワード保護）されているため結合できません。'));

    $('mergeBtn').click();

    await vi.waitFor(() => expect($('message').textContent).toContain('暗号化'));
    expect($('mergeBtn').disabled).toBe(false);
  });

  it('結合した PDF はダウンロードするだけで、Drive へ保存するボタンは無い', () => {
    expect($('saveDriveBtn')).toBeNull();
    expect(document.querySelector('portal-save-dialogs')).toBeNull();
  });
});
