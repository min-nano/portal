// @vitest-environment jsdom
//
// PDF 結合ツールの画面（main.js）。
//
// pdf.js・OCR・Drive・結合（pdf-lib）は偽物に差し替え、実際のページの
// マークアップ（page.html / overlay.html）の上で、利用者の操作の流れを通す。
//
//   ファイルを足す → 番号を読んで並べる → 配置・番号を直す → 確かめる
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
  releaseOcr: vi.fn(),
  renderPreview: vi.fn(),
  closePdf: vi.fn(),
  // pdf-lib に写させない書き換えが効いているか（pdf-lib-views.js）。
  views: true,
  mergePdf: vi.fn(),
  writeMergedPdf: vi.fn(),
  openStash: vi.fn(),
  openOptions: [],
  cleanups: 0,
  releasePdfWorker: vi.fn(),
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
vi.mock('../src/pdf-book-merger/pdf-lib-views.js', () => ({
  get pdfLibViews() {
    return mocks.views;
  },
}));
vi.mock('../src/pdf-book-merger/ocr.js', () => ({
  boxesReadSoFar: () => 0,
  prepareOcr: (...args) => mocks.prepareOcr(...args),
  readStrip: (...args) => mocks.readStrip(...args),
  releaseOcr: (...args) => mocks.releaseOcr(...args),
}));
vi.mock('../src/pdf-book-merger/stash.js', async (importOriginal) => ({
  // 保存領域を使えないときの置き場所（Blob）は本物を使う。
  ...(await importOriginal()),
  openStash: (...args) => mocks.openStash(...args),
}));
vi.mock('../src/pdf-book-merger/merge.js', () => ({
  mergePdf: (...args) => mocks.mergePdf(...args),
  writeMergedPdf: (...args) => mocks.writeMergedPdf(...args),
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
    openPdf: async (bytes, options) => {
      mocks.openOptions.push(options);
      const text = new TextDecoder().decode(bytes);
      const spec = JSON.parse(text.slice('%PDF-'.length));
      return {
        spec,
        numPages: spec.pages.length,
        getPageLabels: async () => spec.labels ?? null,
        cleanup: async () => {
          mocks.cleanups++;
        },
        getMetadata: async () => {
          if (spec.metadataBroken) throw new Error('metadata');
          return { info: { Title: spec.title ?? '', ...spec.info } };
        },
      };
    },
    redrawnSafely: (doc) => doc.spec.redrawn === true,
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
    manySoftMasks: (softMasks = 0) => softMasks > 8,
    closePdf: (...args) => mocks.closePdf(...args),
    releaseCanvas: () => {},
    releasePdfWorker: () => mocks.releasePdfWorker(),
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

/** ファイルの読み込みが終わり、一覧に配置の選択が並ぶまで待つ。 */
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

/**
 * 保存領域（stash.js）の偽物を使うように、画面を開き直す。中身はメモリに持ち、
 * 読み書きを数える。failPut に名前を入れると、そのファイルは置けない。
 */
async function fakeStash() {
  const files = new Map();
  const stash = {
    kind: 'opfs',
    files,
    reads: [],
    removed: [],
    failPut: new Set(),
    failWrite: false,
    failOpen: false,
    put: vi.fn(async (name, bytes) => {
      if (stash.failPut.has(name)) throw new Error('quota');
      files.set(name, bytes.slice());
    }),
    // 読む途中で待たせる（readGate）。待ったあとに、置いたものが消えていたら失敗する。
    readGate: null,
    read: async (name) => {
      stash.reads.push(name);
      const before = files.get(name)?.slice();
      if (stash.readGate) {
        await stash.readGate;
        if (!files.has(name)) {
          if (stash.readStale) return before;
          throw new Error(`${name} not found`);
        }
      }
      if (!files.has(name)) throw new Error(`${name} not found`);
      return files.get(name).slice();
    },
    remove: async (name) => {
      stash.removed.push(name);
      files.delete(name);
    },
    writer: async (name) => {
      if (stash.failOpen) throw new Error('NoModificationAllowedError');
      const chunks = [];
      return {
        write: async (chunk) => {
          if (stash.failWrite) throw new Error('quota');
          chunks.push(chunk);
        },
        close: async () => {
          if (stash.failWrite) throw new Error('not open');
          const blob = new Blob(chunks);
          files.set(name, new Uint8Array(await blob.arrayBuffer()));
          return new File(chunks, name);
        },
      };
    },
  };
  mocks.openStash.mockResolvedValue(stash);
  // 保存領域はツールを開いたときに用意するので、開き直す。
  vi.resetModules();
  installPage();
  await import('../src/pdf-book-merger/main.js');
  await mocks.prepare();
  return stash;
}

/** 結合に渡されたファイルの中身を読み、並べる順の頁の仕様にする。 */
async function sourcePages(sources, order) {
  // 本物と同じく、ファイルごとに 1 度だけ読む。
  const specs = new Map();
  const pages = [];
  for (const entry of order) {
    if (!specs.has(entry.fileKey)) specs.set(entry.fileKey, specOf(await sources.get(entry.fileKey).load()));
    pages.push(specs.get(entry.fileKey).pages[entry.pageIndex]);
  }
  return pages;
}

function file(name, bytes) {
  return new File([bytes], name, { type: 'application/pdf' });
}

function fileItem(name) {
  return [...document.querySelectorAll('#fileList .bm-file')].find(
    (item) => item.querySelector('.name').textContent === name
  );
}

/** ファイルの「進み方」のセレクトボックス（配置の次）。 */
function stepSelect(name) {
  return fileItem(name).querySelectorAll('.bm-file-controls select')[1];
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
  // 前のテストの記録（ページが落ちたときのために残すもの）を持ち越さない。
  localStorage.clear();
  Object.values(mocks).forEach((mock) => typeof mock === 'function' && mock.mockReset?.());
  mocks.prepareOcr.mockResolvedValue({});
  mocks.releaseOcr.mockResolvedValue(undefined);
  // 保存領域は、はじめは使えない（メモリに持つ）。使うテストは fakeStash に替える。
  mocks.openStash.mockResolvedValue(null);
  mocks.openOptions.length = 0;
  mocks.cleanups = 0;
  mocks.releasePdfWorker.mockReset();
  mocks.releasePdfWorker.mockReturnValue(true);
  mocks.readStrip.mockImplementation(async (strip) =>
    strip.zone === 'bottom' && strip.page.ocr ? [{ text: String(strip.page.number), x0: 0.48, x1: 0.52, y: 0.95, h: 0.012 }] : []
  );
  mocks.renderPreview.mockResolvedValue('blob:preview');
  // 頁の仕様に jpeg: false と書いた頁のほかは、JPEG 1 枚の頁として見つかる。
  mocks.findScanImages.mockImplementation(async (bytes) => {
    const pages = specOf(bytes).pages;
    const fallback = pages.filter((p) => p.jpeg === false).length;
    return {
      scans: pages.map((p) => (p.jpeg === false ? null : { jpeg: p.id })),
      softMasks: pages.map((p) => p.softMasks ?? 0),
      reasons: new Map(fallback ? [['画像の上に図形を描いている', fallback]] : []),
      example: fallback ? '2 頁目: 画像 1 枚（DCTDecode 100×140 DeviceGray 8bit）' : '',
    };
  });
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
  mocks.views = true;
  mocks.mergePdf.mockImplementation(async ({ sources, order, title, labels, onProgress }) => {
    const { pageLabelTexts } = await import('../src/pdf-book-merger/ordering.js');
    const pages = await sourcePages(sources, order);
    onProgress?.(order.length, order.length);
    return {
      bytes: pdf(pages, { title, labels: pageLabelTexts(labels, order.length) }),
      digests: pages.map((p) => `d-${p.id}`),
    };
  });

  // 少しずつ書き出す結合の偽物（2 つに分けて書く）。
  mocks.writeMergedPdf.mockImplementation(async ({ sources, order, title, labels, write, onProgress }) => {
    const { pageLabelTexts } = await import('../src/pdf-book-merger/ordering.js');
    const pages = await sourcePages(sources, order);
    onProgress?.(order.length, order.length);
    const bytes = pdf(pages, { title, labels: pageLabelTexts(labels, order.length) });
    await write(bytes.slice(0, 10));
    await write(bytes.slice(10));
    return { size: bytes.length, digests: pages.map((p) => `d-${p.id}`) };
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
    expect(fileItem('猫_奇数.pdf').querySelector('.hint').textContent).toBe('本文(頁番号: 1, 3, 5, 7)');
    expect(fileItem('猫_奇数.pdf').querySelector('.bm-file-details').textContent).toBe(
      '4 頁のうち番号を読めた頁 4（うち画像から 1）'
    );
    expect(fileItem('猫_偶数.pdf').querySelector('.hint').textContent).toBe('本文(頁番号: 8, 6, 4, 2)');
    expect($('summary').textContent).toContain('1〜8（8 頁）');
    expect($('checkSection').hidden).toBe(false);
    expect($('outputName').value).toBe('猫.pdf');
    expect($('problems').textContent).toContain('見つかりませんでした');
    // 画像から読むのは、文字情報に番号が無かった頁だけ（表紙は名前で分かるので読まない）。
    expect(mocks.readStrip).toHaveBeenCalledTimes(2);
  });

  it('一度に何十・何百ファイル足しても、一覧は 1 度だけ描き、行やカードは中身が変わったものだけ作り直す', async () => {
    // 1 つ足すたびに・1 つ調べ終えるたびに一覧をまるごと描き直すと、作っては捨てる
    // 要素がファイルの数の 2 乗になり（400 ファイルで約 400 万個）、iPhone では
    // 足している途中・調べている途中でページごと落ちた。
    const list = $('fileList');
    const created = { files: 0, cards: 0 };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const kind = record.target === list ? 'files' : 'cards';
        // 作り直した行も、動かしただけの行も数える（どちらも描き直しの手間になる）。
        created[kind] += record.addedNodes.length;
      }
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const count = 40;
    const names = Array.from({ length: count }, (_, i) => `${String(i + 1).padStart(4, '0')}.pdf`);
    drop(names.map((name, i) => file(name, pdf([page(`p${i}`, i + 1)]))));

    // 足した直後（読み込みが始まる前）。一覧は 1 度だけ描き、記録も 1 度だけ残す。
    expect(list.children).toHaveLength(count);
    const kept = setItem.mock.calls.filter(([key]) => key.startsWith('pdf-book-merger:log'));
    expect(kept).toHaveLength(1);
    expect(JSON.parse(kept[0][1]).lines.at(-1)).toContain(`「${names.at(-1)}」を追加しました（この端末）`);
    setItem.mockRestore();

    observer.observe(list, { childList: true });
    observer.observe($('pageGrid'), { childList: true });
    await vi.waitFor(() => expect(list.querySelectorAll('.bm-file.ready')).toHaveLength(count), { timeout: 20000 });
    await flush();
    observer.disconnect();
    // ファイルの行は、ファイルごとに読み込み中・読み込み済み・調べ終えたときの 3 回
    // （まるごと描き直すと、調べ終えるたびに全部の行で、約 40 × 40 回）。
    // 頁のカードは、頁ごとに 1 回（まるごとなら、約 40 × 40 / 2 回）。
    expect(created).toEqual({ files: count * 3, cards: count });
  }, 30000);

  it('ファイルは名前と設定の要約の 2 行に畳んでおき、開け閉めは描き直しても保つ', async () => {
    await addBook();
    const meta = (name) => fileItem(name).querySelector('.bm-file-head .hint').textContent;

    expect(fileItem('猫_奇数.pdf').hasAttribute('collapsed')).toBe(true);
    expect(meta('猫_奇数.pdf')).toBe('本文(頁番号: 1, 3, 5, 7)');
    expect(meta('猫_表紙.pdf')).toBe('先頭に置く(2 頁)');

    fileItem('猫_表紙.pdf').toggle();
    change(fileItem('猫_表紙.pdf').querySelector('select'), 'split');
    change(stepSelect('猫_表紙.pdf'), '-1');

    // 一覧は描き直されるが、開いたものは開いたまま、閉じたものは閉じたまま。
    expect(fileItem('猫_表紙.pdf').hasAttribute('collapsed')).toBe(false);
    expect(fileItem('猫_奇数.pdf').hasAttribute('collapsed')).toBe(true);
    expect(meta('猫_表紙.pdf')).toBe('前半を先頭・後半を末尾(2 頁, 最後の頁から)');

    change(fileItem('猫_表紙.pdf').querySelector('.bm-file-controls input[type="text"]'), '3');
    expect(meta('猫_表紙.pdf')).toBe('前半を先頭・後半を末尾(2 頁, 先頭の頁の番号 3, 最後の頁から)');
    change(fileItem('猫_奇数.pdf').querySelector('.bm-file-controls input[type="text"]'), '-11');
    expect(meta('猫_奇数.pdf')).toBe('本文(頁番号: -11, -9, -7, -5, 手入力)');
  });

  it('配置を変えると並びが変わる（表紙と裏表紙を 1 回で取ったファイル）', async () => {
    await addBook();

    change(fileItem('猫_表紙.pdf').querySelector('select'), 'split');

    const labels = gridLabels();
    expect(labels[0]).toBe('表紙');
    expect(labels.at(-1)).toBe('裏表紙');
    expect(labels).toHaveLength(10);
  });

  it('進み方を逆順にした表紙は、最後の頁から置く（給紙の都合で最後の頁から並んだ表紙）', async () => {
    await addBook();
    change(fileItem('猫_表紙.pdf').querySelector('select'), 'split');
    const firstAndLast = () => {
      const cards = [...document.querySelectorAll('#pageGrid > li')];
      return [cards[0].dataset.pageKey, cards.at(-1).dataset.pageKey];
    };
    expect(firstAndLast()).toEqual(['f3:0', 'f3:1']);

    change(stepSelect('猫_表紙.pdf'), '-1');

    expect(firstAndLast()).toEqual(['f3:1', 'f3:0']);
    expect(stepSelect('猫_表紙.pdf').value).toBe('-1');
    // 逆順のチェックは無く、本文と同じ「先頭の頁の番号」と「進み方」の欄だけ。
    expect(fileItem('猫_表紙.pdf').querySelector('input[type="checkbox"]')).toBeNull();
    expect(fileItem('猫_奇数.pdf').querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('束を外すと、抜けた頁をあるべき位置に札で出し、指摘する', async () => {
    await addBook();

    fileItem('猫_偶数.pdf').querySelector('button[aria-label="このファイルを削除"]').click();

    expect(gridLabels()).toEqual(['表紙', '表紙', '1 頁', '-2 頁', '3 頁', '-4 頁', '5 頁', '-6 頁', '7 頁']);
    expect($('problems').textContent).toContain('2・4・6 頁が見つかりません');
    expect(mocks.closePdf).toHaveBeenCalled();
  });

  it('長く抜けているところは 1 枚の札にまとめ、ファイルを外しても残る頁のカードは作り直さない', async () => {
    drop([
      file('前.pdf', pdf([page('a1', 1), page('a2', 2), page('a3', 3)])),
      file('後.pdf', pdf([page('b20', 20), page('b21', 21), page('b22', 22)])),
    ]);
    await settled(2);
    expect(gridLabels()).toEqual(['1 頁', '2 頁', '3 頁', '-4〜19 頁', '20 頁', '21 頁', '22 頁']);
    const kept = [...document.querySelectorAll('#pageGrid > li')].slice(0, 3);

    fileItem('後.pdf').querySelector('button[aria-label="このファイルを削除"]').click();

    expect(gridLabels()).toEqual(['1 頁', '2 頁', '3 頁']);
    expect([...document.querySelectorAll('#pageGrid > li')]).toEqual(kept);
  });

  it('先頭に置くファイルは、先頭の頁の番号で順番を決められる', async () => {
    await addBook();
    const keys = () => [...document.querySelectorAll('#pageGrid > li')].map((card) => card.dataset.pageKey);
    // 奇数頁の束を先頭に置くファイルにすると、名前の順（奇数 → 表紙）に並ぶ。
    change(fileItem('猫_奇数.pdf').querySelector('select'), 'front');
    expect(keys().slice(0, 6)).toEqual(['f1:0', 'f1:1', 'f1:2', 'f1:3', 'f3:0', 'f3:1']);

    // 表紙に番号を入れると、番号を入れていない奇数頁の束より前に並ぶ。
    const start = () => fileItem('猫_表紙.pdf').querySelector('input[type="text"]');
    change(start(), '1');
    expect(keys().slice(0, 6)).toEqual(['f3:0', 'f3:1', 'f1:0', 'f1:1', 'f1:2', 'f1:3']);
    expect(start().value).toBe('1');

    // 番号は頁ごとに 1 つずつ進むので、重なれば頁が互い違いに並ぶ（0, 1, 1, 2, 2, 3）。
    const odd = () => fileItem('猫_奇数.pdf').querySelector('input[type="text"]');
    change(odd(), '0');
    expect(keys().slice(0, 6)).toEqual(['f1:0', 'f1:1', 'f3:0', 'f1:2', 'f3:1', 'f1:3']);
    // 奇数頁の束を表紙より小さい番号で始めれば、まとめてそちらが前。
    change(odd(), '-10');
    expect(keys().slice(0, 6)).toEqual(['f1:0', 'f1:1', 'f1:2', 'f1:3', 'f3:0', 'f3:1']);

    // 番号を消すと、番号を入れた奇数頁の束の後ろへ戻る。
    change(start(), '');
    expect(start().value).toBe('');
    expect(keys().slice(0, 6)).toEqual(['f1:0', 'f1:1', 'f1:2', 'f1:3', 'f3:0', 'f3:1']);

    // 結合しないファイルには番号の欄を出さない。
    change(fileItem('猫_表紙.pdf').querySelector('select'), 'exclude');
    expect(start()).toBeNull();

    change(odd(), 'x');
    expect($('message').textContent).toContain('整数で');
    expect(fileItem('猫_奇数.pdf').querySelector('button[aria-label^="ひとつ"]')).toBeNull();
  });

  it('ファイルの並び順を、追加順・名前順・更新日時順（それぞれ昇順・降順）で切り替えられる', async () => {
    const at = (name, bytes, lastModified) =>
      new File([bytes], name, { type: 'application/pdf', lastModified });
    expect($('fileSortField').hidden).toBe(true);
    drop([at('猫_奇数.pdf', pdf(ODD), 3000), at('猫_表紙.pdf', pdf(COVER), 1000)]);
    await settled(2);
    drop([at('猫_偶数.pdf', pdf(EVEN), 2000)]);
    await settled(3);
    const names = () => [...document.querySelectorAll('#fileList .bm-file .name')].map((n) => n.textContent);
    const keys = () => [...document.querySelectorAll('#pageGrid > li')].map((card) => card.dataset.pageKey);
    const sortBy = (value) => change($('fileSort'), value);

    // 既定は追加した順（一度に選んだファイルは名前の順）。
    expect($('fileSortField').hidden).toBe(false);
    expect(names()).toEqual(['猫_奇数.pdf', '猫_表紙.pdf', '猫_偶数.pdf']);

    sortBy('time');
    expect(names()).toEqual(['猫_表紙.pdf', '猫_偶数.pdf', '猫_奇数.pdf']);
    // 番号を入れていない先頭のファイルは、一覧の順に並ぶ。
    change(fileItem('猫_奇数.pdf').querySelector('select'), 'front');
    expect(keys().slice(0, 6)).toEqual(['f2:0', 'f2:1', 'f1:0', 'f1:1', 'f1:2', 'f1:3']);

    sortBy('name');
    expect(names()).toEqual(['猫_奇数.pdf', '猫_偶数.pdf', '猫_表紙.pdf']);
    expect(keys().slice(0, 6)).toEqual(['f1:0', 'f1:1', 'f1:2', 'f1:3', 'f2:0', 'f2:1']);

    // あとから足したファイルも、選んでいる並び順の位置に入る。
    drop([at('猫_あとがき.pdf', pdf(COVER), 500)]);
    await settled(4);
    expect(names()).toEqual(['猫_あとがき.pdf', '猫_奇数.pdf', '猫_偶数.pdf', '猫_表紙.pdf']);

    sortBy('added');
    expect(names()).toEqual(['猫_奇数.pdf', '猫_表紙.pdf', '猫_偶数.pdf', '猫_あとがき.pdf']);

    // Drive のファイルは modifiedTime で並べ、更新日時の分からないファイルは後ろへ。
    mocks.pickFiles.mockResolvedValue([
      { id: 'd-old', name: '猫_帯.pdf', modifiedTime: '1970-01-01T00:00:00.100Z' },
      { id: 'd-none', name: '猫_栞.pdf' },
    ]);
    mocks.downloadDriveFile.mockImplementation(async () => pdf(COVER));
    $('driveBtn').click();
    await settled(6);
    sortBy('time');
    expect(names()).toEqual(['猫_帯.pdf', '猫_あとがき.pdf', '猫_表紙.pdf', '猫_偶数.pdf', '猫_奇数.pdf', '猫_栞.pdf']);

    // 降順（新しい順）。更新日時の分からないファイルは、新しい順でも後ろのまま。
    sortBy('time-desc');
    expect(names()).toEqual(['猫_奇数.pdf', '猫_偶数.pdf', '猫_表紙.pdf', '猫_あとがき.pdf', '猫_帯.pdf', '猫_栞.pdf']);
    sortBy('name-desc');
    expect(names()).toEqual(['猫_栞.pdf', '猫_表紙.pdf', '猫_帯.pdf', '猫_偶数.pdf', '猫_奇数.pdf', '猫_あとがき.pdf']);
    sortBy('added-desc');
    expect(names()).toEqual(['猫_栞.pdf', '猫_帯.pdf', '猫_あとがき.pdf', '猫_偶数.pdf', '猫_表紙.pdf', '猫_奇数.pdf']);
    $('logBox').open = true;
    $('logBox').dispatchEvent(new Event('toggle'));
    expect($('logText').textContent).toContain('ファイルを「追加順（新しい順）」に並べました');
  });

  it('配置を一括で変え、自動に戻せる（すべて先頭に置いて、名前順に単純につなぐ）', async () => {
    expect($('bulkRoleField').hidden).toBe(true);
    await addBook();
    const keys = () => [...document.querySelectorAll('#pageGrid > li')].map((card) => card.dataset.pageKey);
    const roles = () => ['猫_奇数.pdf', '猫_偶数.pdf', '猫_表紙.pdf'].map((name) => fileItem(name).querySelector('select').value);
    expect($('bulkRoleField').hidden).toBe(false);
    // 「まとめて変える…」を選び直しても、何も変えない。
    change($('bulkRole'), '');
    expect(roles()).toEqual(['body', 'body', 'front']);

    change($('fileSort'), 'name');
    change(stepSelect('猫_表紙.pdf'), '-1');
    change($('bulkRole'), 'front');
    expect(roles()).toEqual(['front', 'front', 'front']);
    // 選んだら「まとめて変える…」に戻る（同じ配置をもう一度選べるように）。
    expect($('bulkRole').value).toBe('');
    // 名前順（奇数・偶数・表紙）に、ファイルの中の頁の順でつなぐ。表紙の進み方は残す。
    expect(keys()).toEqual(['f1:0', 'f1:1', 'f1:2', 'f1:3', 'f2:0', 'f2:1', 'f2:2', 'f2:3', 'f3:1', 'f3:0']);

    // 自動に戻すと、読み込んだときの推測に戻り、手で変えた進み方も消える。
    change($('bulkRole'), 'auto');
    expect(roles()).toEqual(['body', 'body', 'front']);
    expect(gridLabels()).toEqual(['表紙', '表紙', '1 頁', '2 頁', '3 頁', '4 頁', '5 頁', '6 頁', '7 頁', '8 頁']);
    expect(keys().slice(0, 2)).toEqual(['f3:0', 'f3:1']);
    $('logBox').open = true;
    $('logBox').dispatchEvent(new Event('toggle'));
    expect($('logText').textContent).toContain('3 ファイルの配置を「自動」にしました');
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

  it('進み具合はバーの横に短く出し、細かい経過は畳んだ記録に残す（開いてコピーできる）', async () => {
    let release;
    mocks.pickFiles.mockResolvedValue([{ id: 'd-odd', name: '猫_奇数.pdf' }]);
    mocks.downloadDriveFile.mockImplementation(async (picked, { onProgress }) => {
      await new Promise((done) => (release = done));
      onProgress(10, 10);
      return pdf(ODD);
    });
    expect($('logBox').hidden).toBe(true);

    $('driveBtn').click();
    await vi.waitFor(() => expect($('progress').hidden).toBe(false));
    // バーの横は、何をしているかだけ。ファイルの下は状態だけ（経過の数字は出さない）。
    expect($('progressText').textContent).toBe('ファイルを調べています（1 / 1）');
    expect(fileItem('猫_奇数.pdf').querySelector('.hint').textContent).toBe('読み込み中');

    // 記録はふだん畳んである。開くと、実行中の段まで読める。
    expect($('logBox').hidden).toBe(false);
    expect($('logBox').open).toBe(false);
    $('logBox').open = true;
    $('logBox').dispatchEvent(new Event('toggle'));
    expect($('logText').textContent).toContain('「猫_奇数.pdf」を追加しました（Drive）');
    expect($('logText').textContent).toContain('（実行中）「猫_奇数.pdf」を読み込んでいます');

    release();
    await settled(1);
    const text = $('logText').textContent;
    expect(text).toContain('「猫_奇数.pdf」を読み込みました（');
    expect(text).toContain('「猫_奇数.pdf」の文字情報を読みました（4 頁、文字情報のある頁 4、番号が見つかった頁 3）');
    expect(text).toContain('余白を OCR 1 頁・うち番号が読めた頁 1');
    expect(text).toContain('「猫_奇数.pdf」を調べ終えました（本文');
    expect(text).not.toContain('（実行中）');

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    $('logCopyBtn').click();
    await vi.waitFor(() => expect($('logCopyBtn').textContent).toBe('コピーしました'));
    expect(writeText).toHaveBeenCalledWith(text);

    // 書き込めないブラウザでは、選んだ状態にして手でコピーしてもらう。
    writeText.mockRejectedValue(new Error('denied'));
    $('logCopyBtn').click();
    await vi.waitFor(() => expect($('logCopyBtn').textContent).toBe('選びました。コピーしてください'));
    expect(window.getSelection().toString()).toContain('を読み込みました');
  });

  /**
   * バーに出した値（済んだところ）と、そのときの見出しを記録する。返す関数で記録をやめる。
   * withEnd なら、いま進めている区間の終わり（ストライプの右端）も記録する。
   */
  function watchBar({ withEnd = false } = {}) {
    const seen = [];
    const bar = $('progressBar');
    const setAttribute = bar.setAttribute.bind(bar);
    bar.setAttribute = (name, value) => {
      if (name === 'aria-valuenow') {
        const entry = { value: Number(value), label: $('progressText').textContent };
        if (withEnd) entry.end = Number(bar.dataset.busyEnd);
        seen.push(entry);
      }
      setAttribute(name, value);
    };
    seen.stop = () => delete bar.setAttribute;
    return seen;
  }

  /** 記録したバーの値が、一度も戻っていないこと。 */
  function expectNeverBack(seen) {
    const values = seen.map((s) => s.value);
    expect(values.length).toBeGreaterThan(4);
    values.forEach((value, i) => expect(value).toBeGreaterThanOrEqual(values[i - 1] ?? 0));
  }

  /** name の頁 id の画像を描くのを、返す関数を呼ぶまで止める。 */
  function holdImage(id) {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const render = mocks.renderPageImage.getMockImplementation();
    mocks.renderPageImage.mockImplementation(async (doc, index, ...rest) => {
      if (doc.spec.pages[index].id === id) await gate;
      return render(doc, index, ...rest);
    });
    return release;
  }

  it('バーは段ごとに空へ戻さず、すべてのファイルを通した進み具合を出す', async () => {
    const seen = watchBar();
    drop([file('猫_奇数.pdf', pdf(ODD)), file('猫_偶数.pdf', pdf(EVEN))]);
    await settled(2);
    seen.stop();

    expectNeverBack(seen);
    // 1 つめのファイルは前半、2 つめは後半に写す。
    const at = (label) => seen.filter((s) => s.label === label).map((s) => s.value);
    const first = at('ファイルを調べています（1 / 2）');
    const second = at('ファイルを調べています（2 / 2）');
    expect(first.length).toBeGreaterThan(2);
    expect(second.length).toBeGreaterThan(2);
    expect(Math.max(...first)).toBeLessThanOrEqual(0.5);
    expect(Math.min(...second)).toBeGreaterThanOrEqual(0.5);
    expect(Math.max(...first)).toBeGreaterThan(0.4);
    expect(Math.max(...second)).toBeGreaterThan(0.9);
  });

  it('ファイルの替わり目ではバーを隠さず、すべて調べ終えてから隠す（画面がちらつかないように）', async () => {
    const hidden = [];
    const observer = new MutationObserver(() => hidden.push($('progress').hidden));
    observer.observe($('progress'), { attributes: true, attributeFilter: ['hidden'] });
    const seen = watchBar({ withEnd: true });
    drop([file('猫_奇数.pdf', pdf(ODD)), file('猫_偶数.pdf', pdf(EVEN))]);
    await settled(2);
    await flush();
    seen.stop();
    observer.disconnect();

    // 出したら、隠すのは最後の 1 度だけ。
    expect(hidden).toEqual([false, true]);
    // 替わり目では、1 つめを済ませた位置（半分）で止め、2 つめの見出しに替える。
    // ストライプは 2 つめの仕事の終わりまで。
    expect(seen).toContainEqual({ value: 0.5, end: 1, label: 'ファイルを調べています（2 / 2）' });
    expectNeverBack(seen);
  });

  it('調べている途中でファイルを足しても、バーは戻らない', async () => {
    const release = holdImage('o3');
    const seen = watchBar();
    drop([file('猫_奇数.pdf', pdf(ODD))]);
    await vi.waitFor(() => expect(mocks.renderPageImage).toHaveBeenCalled());
    const before = seen.at(-1).value;
    expect(before).toBeGreaterThan(0.1);

    drop([file('猫_偶数.pdf', pdf(EVEN)), file('猫_表紙.pdf', pdf(COVER))]);
    await flush();
    release();
    await settled(3);
    seen.stop();

    expectNeverBack(seen);
    expect(seen.map((s) => s.label)).toContain('ファイルを調べています（1 / 3）');
    expect(seen.map((s) => s.label)).toContain('ファイルを調べています（3 / 3）');
  });

  it('進み具合が分からないあいだも、済んだところは出したまま、進めている区間をストライプで出す', async () => {
    let release;
    mocks.pickFiles.mockResolvedValue([{ id: 'd-odd', name: '猫_奇数.pdf' }]);
    mocks.downloadDriveFile.mockImplementation(async (picked, { onProgress }) => {
      onProgress(5, 0); // 大きさの分からない読み込み
      await new Promise((done) => (release = done));
      return pdf(ODD);
    });
    $('driveBtn').click();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect($('progress').hidden).toBe(false);
    // 読み込みの段（仕事の 3 割）は、済んだところ 0 から、段の終わりまでのストライプ。
    const bar = $('progressBar');
    expect(bar.getAttribute('aria-valuenow')).toBe('0');
    expect(Number(bar.dataset.busyEnd)).toBeCloseTo(0.3);
    expect($('progressDone').style.width).toBe('0%');
    expect($('progressBusy').style.left).toBe('0%');
    expect(parseFloat($('progressBusy').style.width)).toBeCloseTo(30);
    release();
    await settled(1);
  });

  it('調べている途中に結合しても、済んだら調べている方の見出しとバーに戻す', async () => {
    drop([file('猫_奇数.pdf', pdf(ODD)), file('猫_偶数.pdf', pdf(EVEN))]);
    await settled(2);
    const release = holdImage('c2');
    drop([file('猫_表紙.pdf', pdf(COVER))]);
    // 調べる流れが止まるところまで待つ。c1 と c2 は並べて描くので、c2 を止めても
    // c1 は描き終えてバーを進める。c2 を描き始める前に、バーは画像の段の始まりで
    // 止まる（頁の画像を調べています。割合は分からない）ので、c2 を描き始めたあとに
    // そこより進んでいれば、それは c1 を測り終えたときの値で、c2 を放すまで変わらない。
    await vi.waitFor(() => {
      expect($('progressText').textContent).toBe('ファイルを調べています（3 / 3）');
      expect(mocks.renderPageImage.mock.calls.some(([doc, index]) => doc.spec.pages[index].id === 'c2')).toBe(true);
      // 画像の段（手元のファイルなので 0.1 から）に入ってから、c1 の分だけ進んでいる。
      expect(Number($('progressBar').getAttribute('aria-valuenow'))).toBeGreaterThan(0.1 + 1e-9);
    });
    const reading = $('progressBar').getAttribute('aria-valuenow');

    $('mergeBtn').click();
    await vi.waitFor(() => expect($('downloadBtn').disabled).toBe(false));
    expect($('progress').hidden).toBe(false);
    expect($('progressText').textContent).toBe('ファイルを調べています（3 / 3）');
    expect($('progressBar').getAttribute('aria-valuenow')).toBe(reading);

    release();
    await settled(3);
  });

  it('あとからの OCR は、ファイルの数に数えない', async () => {
    drop([file('猫_表紙.pdf', pdf(ODD))]);
    await settled(1);
    const release = holdImage('e4');
    drop([file('猫_偶数.pdf', pdf(EVEN))]);
    await vi.waitFor(() => expect(mocks.renderPageImage.mock.calls.some(([doc]) => doc.spec.pages[0].id === 'e8')).toBe(true));
    change(fileItem('猫_表紙.pdf').querySelector('select'), 'body');
    await flush();
    expect($('progressText').textContent).toBe('ファイルを調べています（2 / 2）');

    release();
    await vi.waitFor(() =>
      expect(document.querySelector('#pageGrid [data-page-key="f1:2"] .bm-status').textContent).toBe('読取')
    );
    await settled(2);
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
    // 頁のソフトマスクの数も渡す（iPhone・iPad で帯に分けて描くか）。
    expect(mocks.renderPreview.mock.calls[0][2]).toEqual({ softMasks: 0 });
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

  it('調べ終えたファイルは pdf.js で開いたままにせず、拡大表示のときだけ開き直す', async () => {
    drop([file('猫_奇数.pdf', pdf(ODD)), file('猫_偶数.pdf', pdf(EVEN))]);
    await settled(2);
    await flush();

    // 調べ終えたファイルは、2 つとも閉じてある（worker に写しを残さない）。
    const closedFiles = () => mocks.closePdf.mock.calls.map(([doc]) => doc?.spec?.pages?.[0]?.id).filter(Boolean);
    expect(closedFiles().sort()).toEqual(['e8', 'o1']);

    document.querySelector('#pageGrid .bm-thumb').click();
    await vi.waitFor(() => expect($('previewImage').src).toBe('blob:preview'));
    // 拡大表示のときに開き直したものを渡す。
    const [shown] = mocks.renderPreview.mock.calls[0];
    expect(shown.spec.pages[0].id).toBe('o1');

    // 拡大表示の間は、同じファイルの頁へ移っても開き直さない。
    document.querySelector('#pageGrid [data-page-key="f1:1"] .bm-thumb').click();
    await vi.waitFor(() => expect(mocks.renderPreview).toHaveBeenCalledTimes(2));
    expect(mocks.renderPreview.mock.calls[1][0]).toBe(shown);
    expect(mocks.closePdf.mock.calls.some(([doc]) => doc === shown)).toBe(false);

    // 拡大表示を閉じたら手放す。
    $('previewCloseBtn').click();
    await flush();
    expect(mocks.closePdf.mock.calls.some(([doc]) => doc === shown)).toBe(true);
  });

  it('調べている途中で外したファイルは、描き終えてから閉じる（描いている文書を壊さない）', async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const answer = mocks.renderPageImage.getMockImplementation();
    mocks.renderPageImage.mockImplementation(async (...args) => {
      await gate;
      return answer(...args);
    });
    drop([file('猫_奇数.pdf', pdf(ODD))]);
    await vi.waitFor(() => expect(mocks.renderPageImage).toHaveBeenCalled());
    const [doc] = mocks.renderPageImage.mock.calls[0];

    fileItem('猫_奇数.pdf').querySelector('button[aria-label="このファイルを削除"]').click();
    await flush();
    expect(mocks.closePdf.mock.calls.some(([closed]) => closed === doc)).toBe(false);

    release();
    await vi.waitFor(() => expect(mocks.closePdf.mock.calls.some(([closed]) => closed === doc)).toBe(true));
  });

  it('pdf-lib の書き換えが効いていなければ、はじめに知らせ、JPEG は残さずにあとで調べ直す', async () => {
    mocks.views = false;
    vi.resetModules();
    installPage();
    await import('../src/pdf-book-merger/main.js');
    await mocks.prepare?.();
    $('logBox').open = true;
    $('logBox').dispatchEvent(new Event('toggle'));
    expect($('logText').textContent).toContain('pdf-lib にバイト列を写させない設定が効いていません');

    drop([file('猫_表紙.pdf', pdf(ODD))]);
    await settled(1);
    expect(mocks.findScanImages).toHaveBeenCalledTimes(1);

    change(fileItem('猫_表紙.pdf').querySelector('select'), 'body');
    await vi.waitFor(() => expect(mocks.renderMargins).toHaveBeenCalled());
    // 写しの JPEG は残していないので、1 度だけ調べ直して、その JPEG で描く。
    expect(mocks.findScanImages).toHaveBeenCalledTimes(2);
    expect(mocks.renderMargins.mock.calls[0][2]).toEqual({ jpeg: 'o5' });
  });

  it('あとからの OCR が終わっても、拡大表示で開いている文書は閉じない', async () => {
    drop([file('猫_表紙.pdf', pdf(ODD))]);
    await settled(1);
    document.querySelector('#pageGrid .bm-thumb').click();
    await vi.waitFor(() => expect(mocks.renderPreview).toHaveBeenCalled());
    const [shown] = mocks.renderPreview.mock.calls[0];

    change(fileItem('猫_表紙.pdf').querySelector('select'), 'body');
    await vi.waitFor(() =>
      expect(document.querySelector('#pageGrid [data-page-key="f1:2"] .bm-status').textContent).toBe('読取')
    );

    // OCR は拡大表示と同じ文書を使い、終わっても閉じない。
    expect(mocks.renderMargins.mock.calls[0][0]).toBe(shown);
    expect(mocks.closePdf.mock.calls.some(([doc]) => doc === shown)).toBe(false);
  });

  it('名前を入力したあとに裏の処理が終わっても、結合した PDF は捨てない', async () => {
    drop([file('猫_表紙.pdf', pdf(ODD)), file('猫_偶数.pdf', pdf(EVEN))]);
    await settled(2);
    // 本文に変えると裏で OCR を読む。読み終える前に結合しておく。
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    mocks.readStrip.mockImplementation(async () => {
      await gate;
      return [];
    });
    change(fileItem('猫_表紙.pdf').querySelector('select'), 'body');
    await vi.waitFor(() => expect(mocks.readStrip).toHaveBeenCalled());
    $('outputName').value = '自分で付けた名前';
    $('outputName').dispatchEvent(new Event('input'));
    $('mergeBtn').click();
    await vi.waitFor(() => expect($('downloadBtn').disabled).toBe(false));

    // 裏で OCR を読み終えても、並び（番号の決まった頁）が変わらなければ捨てない。
    release();
    await vi.waitFor(() => expect(fileItem('猫_表紙.pdf').textContent).not.toContain('余白を読み取り中'));

    expect($('downloadBtn').disabled).toBe(false);
  });

  it('JPEG 1 枚の形でない頁は、pdf.js で描いて読む', async () => {
    const pages = [page('o1', 1), page('o3', 3, { ocr: true, jpeg: false, softMasks: 8 }), page('o5', 5)];
    drop([file('odd.pdf', pdf(pages))]);
    await settled(1);

    // 何頁かを並べて描くので、頼んだ順は前後する。ソフトマスクの数も渡す
    // （多い頁は粗く描く）。
    const calls = mocks.renderPageImage.mock.calls.map(([, index, scan, options]) => [index, scan, options]);
    expect(calls.sort((a, b) => a[0] - b[0])).toEqual([
      [0, { jpeg: 'o1' }, { margins: false, softMasks: 0 }],
      [1, null, { margins: true, softMasks: 8 }],
      [2, { jpeg: 'o5' }, { margins: false, softMasks: 0 }],
    ]);
    expect(document.querySelector('#pageGrid [data-page-key="f1:1"] img').src).toBe('blob:pdfjs-o3');
    $('logBox').open = true;
    $('logBox').dispatchEvent(new Event('toggle'));
    expect($('logText').textContent).toContain(
      '「odd.pdf」の 1 頁は pdf.js で描きます（画像の上に図形を描いている 1 頁）。2 頁目: 画像 1 枚（DCTDecode 100×140 DeviceGray 8bit）'
    );
    expect(gridLabels()).toEqual(['1 頁', '-2 頁', '3 頁', '-4 頁', '5 頁']);
  });

  it('PDF の中を調べられなければ、すべての頁を pdf.js で描く', async () => {
    mocks.findScanImages.mockResolvedValue({ scans: [], softMasks: [], reasons: new Map([['PDF を読めない（暗号化）', 1]]), example: '' });
    drop([file('odd.pdf', pdf(ODD))]);
    await settled(1);

    expect(mocks.renderPageImage.mock.calls.every(([, , scan]) => scan === null)).toBe(true);
    expect(gridLabels()).toContain('5 頁');
    // pdf.js で描いた頁と、その理由は記録に残す。
    $('logBox').open = true;
    $('logBox').dispatchEvent(new Event('toggle'));
    expect($('logText').textContent).toContain('「odd.pdf」の 4 頁は pdf.js で描きます（PDF を読めない（暗号化） 1 頁）。');
  });

  it('pdf.js で描く PDF は、作ったアプリと、開き直して描き直したかを記録に出す', async () => {
    const pages = [page('o1', 1, { jpeg: false })];
    // 1 つ目は、描けない理由の分からない頁として見つかる。
    mocks.findScanImages.mockResolvedValueOnce({ scans: [null], softMasks: [0], reasons: new Map(), example: '' });
    drop([
      file('a.pdf', pdf(pages, { info: { Creator: 'Adobe Illustrator', Producer: 'Adobe PDF library' }, redrawn: true })),
      file('b.pdf', pdf(pages, { info: { Creator: 'Word', Producer: 'Word' } })),
      file('c.pdf', pdf(pages, { info: { Creator: ' ', Producer: 3 } })),
      file('d.pdf', pdf(pages, { metadataBroken: true })),
    ]);
    await settled(4);
    $('logBox').open = true;
    $('logBox').dispatchEvent(new Event('toggle'));
    const lines = $('logText').textContent.split('\n');
    const line = (name, what) => lines.find((text) => text.includes(`「${name}」${what}`));

    expect(line('a.pdf', 'の 1 頁は pdf.js')).toMatch(/（理由不明）。作成: Adobe Illustrator \/ Adobe PDF library$/);
    expect(line('b.pdf', 'の 1 頁は pdf.js')).toMatch(/。作成: Word$/);
    // 名前の分からないものは添えない。
    expect(line('c.pdf', 'の 1 頁は pdf.js')).not.toContain('作成');
    expect(line('d.pdf', 'の 1 頁は pdf.js')).not.toContain('作成');

    expect(line('a.pdf', 'の頁の画像を調べました')).toContain('安全な設定で開き直して描き直しました');
    expect(line('b.pdf', 'の頁の画像を調べました')).not.toContain('描き直し');
  });

  it('Drive を待っている間は、見出しに待っていることを出す', async () => {
    mocks.pickFiles.mockResolvedValue([{ id: 'd-odd', name: 'book-a-odd.pdf' }]);
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    mocks.downloadDriveFile.mockImplementation(async (picked, { onWait }) => {
      onWait(40000, 'Drive の流量制限');
      await gate;
      return pdf(ODD);
    });

    $('driveBtn').click();
    await vi.waitFor(() => expect($('progressText').textContent).toContain('待っています'));
    expect($('progressText').textContent).toContain('Drive の流量制限');
    $('logBox').open = true;
    $('logBox').dispatchEvent(new Event('toggle'));
    expect($('logText').textContent).toContain('「book-a-odd.pdf」の読み込みを 40 秒待ってから読み直します（Drive の流量制限）');

    release();
    await settled(1);
  });

  it('Drive を待っている間は、残りの秒数を数え直し、待ち終えたら読み直していると出す', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      mocks.pickFiles.mockResolvedValue([{ id: 'd-odd', name: 'book-a-odd.pdf' }]);
      let release;
      const gate = new Promise((resolve) => (release = resolve));
      mocks.downloadDriveFile.mockImplementation(async (picked, { onWait }) => {
        onWait(3000, 'Drive の流量制限');
        await gate;
        return pdf(ODD);
      });

      $('driveBtn').click();
      await vi.waitFor(() => expect($('progressText').textContent).toContain('あと 3 秒ほど'));
      await vi.advanceTimersByTimeAsync(1000);
      expect($('progressText').textContent).toContain('あと 2 秒ほど');
      await vi.advanceTimersByTimeAsync(2000);
      expect($('progressText').textContent).not.toContain('待っています');
      $('logBox').open = true;
      $('logBox').dispatchEvent(new Event('toggle'));
      expect($('logText').textContent).toContain('（実行中）「book-a-odd.pdf」を読み直しています');

      release();
      await settled(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Drive の選択画面で何も選ばずに閉じたら、何も足さない', async () => {
    mocks.pickFiles.mockResolvedValue([]);

    $('driveBtn').click();
    await flush();

    expect(mocks.pickFiles).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('#fileList .bm-file')).toHaveLength(0);
    expect(mocks.downloadDriveFile).not.toHaveBeenCalled();
  });

  it('調べ終えたら OCR を手放し（結合の前にメモリを空ける）、あとから読むときに用意し直す', async () => {
    drop([file('猫_奇数.pdf', pdf(ODD)), file('猫_偶数.pdf', pdf(EVEN))]);
    await settled(2);
    // 2 ファイルとも調べ終えて、順番待ちが空になってから 1 度だけ手放す。
    await vi.waitFor(() => expect(mocks.releaseOcr).toHaveBeenCalledTimes(1));
    expect(mocks.prepareOcr).toHaveBeenCalledTimes(1);

    // OCR を使わなかった仕事のあとは、手放すものが無い。
    drop([file('猫_表紙.pdf', pdf(COVER))]);
    await settled(3);
    expect(mocks.releaseOcr).toHaveBeenCalledTimes(1);

    // あとから本文に変えて読むときは、用意し直し、読み終えたらまた手放す。
    change(fileItem('猫_表紙.pdf').querySelector('select'), 'body');
    await vi.waitFor(() => expect(mocks.releaseOcr).toHaveBeenCalledTimes(2));
    expect(mocks.prepareOcr).toHaveBeenCalledTimes(2);
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

  it('表紙と見たファイルを本文に変えると、残りの頁を読む（読んでいる間も頁は並びに残す）', async () => {
    drop([file('猫_表紙.pdf', pdf(ODD)), file('猫_偶数.pdf', pdf(EVEN))]);
    await settled(2);
    // 名前で表紙と分かるファイルは、はじめは余白を読まない。
    expect(mocks.readStrip).not.toHaveBeenCalled();
    expect(mocks.findScanImages).toHaveBeenCalledTimes(2);

    // 読み取りを待たせておく。
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const answer = mocks.readStrip.getMockImplementation();
    mocks.readStrip.mockImplementation(async (strip) => {
      await gate;
      return answer(strip);
    });
    const toggle = (role) => change(fileItem('猫_表紙.pdf').querySelector('select'), role);
    toggle('body');
    await vi.waitFor(() => expect(mocks.readStrip).toHaveBeenCalled());

    // 読んでいる間も、そのファイルの頁は抜けにしない。
    const labels = gridLabels();
    $('outputName').value = '別の名前';
    $('outputName').dispatchEvent(new Event('input'));
    change(fileItem('猫_偶数.pdf').querySelector('select'), 'body');
    expect(gridLabels()).toEqual(labels);
    expect(fileItem('猫_表紙.pdf').textContent).toContain('余白を読み取り中');
    // 切り替えを繰り返しても、同じ頁を 2 度は頼まない。
    toggle('front');
    toggle('body');
    release();

    await vi.waitFor(() =>
      expect(document.querySelector('#pageGrid [data-page-key="f1:2"] .bm-status').textContent).toBe('読取')
    );
    expect(mocks.renderMargins).toHaveBeenCalledTimes(1);
    // 調べたときの JPEG を使う（PDF 全体を読み直さない）。
    expect(mocks.renderMargins.mock.calls[0][2]).toEqual({ jpeg: 'o5' });
    expect(mocks.findScanImages).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(fileItem('猫_表紙.pdf').textContent).not.toContain('余白を読み取り中'));
  });

  it('1 頁が描けなければ、描きかけの頁を待ってから失敗にし、残りの頁は描かない', async () => {
    const many = Array.from({ length: 12 }, (_, i) => page(`o${2 * i + 1}`, 2 * i + 1));
    const answer = mocks.renderPageImage.getMockImplementation();
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    mocks.renderPageImage.mockImplementation(async (doc, index, ...rest) => {
      if (index === 0) throw new Error('The object is in an invalid state.');
      await gate;
      return answer(doc, index, ...rest);
    });
    drop([file('odd.pdf', pdf(many))]);
    await vi.waitFor(() => expect(mocks.renderPageImage).toHaveBeenCalledTimes(3));
    await flush();

    // 描きかけの頁が終わるまでは、失敗にしない（次のファイルへ進まない）。
    expect(fileItem('odd.pdf').classList.contains('error')).toBe(false);
    release();
    await settled(1);

    expect(fileItem('odd.pdf').textContent).toContain('1 頁目の画像を描けませんでした');
    // 並べて描いていた分（同時に 3 頁）のほかは、始めない。
    expect(mocks.renderPageImage).toHaveBeenCalledTimes(3);
    // 調べられなかったファイルの PDF は閉じ、縮小画像も手放す。
    expect(mocks.closePdf.mock.calls.some(([doc]) => doc?.spec?.pages?.length === 12)).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:scan-o3');
  });

  it('番号の無い頁が多くても、あとから本文に変えたときに PDF を調べ直さない', async () => {
    const many = Array.from({ length: 40 }, (_, i) => page(`o${2 * i + 1}`, 2 * i + 1, { ocr: true }));
    drop([file('cover.pdf', pdf(many))]);
    await settled(1);
    expect(mocks.findScanImages).toHaveBeenCalledTimes(1);

    change(fileItem('cover.pdf').querySelector('select'), 'body');

    await vi.waitFor(() => expect(mocks.renderMargins).toHaveBeenCalledTimes(40));
    // 調べたときの JPEG（ファイルの一部を指すだけ）で描く。
    expect(mocks.findScanImages).toHaveBeenCalledTimes(1);
    expect(mocks.renderMargins.mock.calls[0][2]).toEqual({ jpeg: 'o1' });
  });

  it('ソフトマスクの多い頁は、粗く描き、余白を OCR しない（あとから本文に変えても）', async () => {
    const pages = [
      page('o1', 1, { jpeg: false, softMasks: 516 }),
      page('o3', 3, { ocr: true, jpeg: false, softMasks: 516 }),
      page('o5', 5, { ocr: true }),
      // JPEG のまま描く頁は、ソフトマスクがあっても重くないので、ふつうに描いて読む。
      page('o7', 7, { ocr: true, softMasks: 516 }),
    ];
    drop([file('odd.pdf', pdf(pages)), file('表紙.pdf', pdf(pages))]);
    await settled(2);

    const calls = mocks.renderPageImage.mock.calls
      .filter(([doc]) => doc === mocks.renderPageImage.mock.calls[0][0])
      .map(([, index, , options]) => [index, options]);
    expect(calls.sort((a, b) => a[0] - b[0])).toEqual([
      [0, { margins: false, softMasks: 516 }],
      [1, { margins: false, softMasks: 516 }],
      [2, { margins: true, softMasks: 0 }],
      [3, { margins: true, softMasks: 0 }],
    ]);
    $('logBox').open = true;
    $('logBox').dispatchEvent(new Event('toggle'));
    const lines = $('logText').textContent.split('\n');
    const imageLine = (name) => lines.find((text) => text.includes(`「${name}」の頁の画像を調べました`));
    // 粗く描いた頁は 2 つ。そのうち OCR を見送ったのは、番号の見つからない 1 頁だけ。
    expect(imageLine('odd.pdf')).toContain('余白を OCR 2 頁・うち番号が読めた頁 2');
    expect(imageLine('odd.pdf')).toMatch(
      /。ソフトマスクの多い 2 頁は粗く描きました（うち番号の見つからない 1 頁は、余白を OCR しませんでした）$/
    );
    // 名前で表紙と分かるファイルは、もともと OCR しないので、見送ったとは書かない。
    expect(imageLine('表紙.pdf')).toMatch(/。ソフトマスクの多い 2 頁は粗く描きました$/);
    // ソフトマスクの多い頁の番号は、前後の頁から補う。
    expect(gridLabels()).toContain('3 頁');

    // 名前で表紙と見たファイルを本文に変えても、その頁は OCR しない。
    change(fileItem('表紙.pdf').querySelector('select'), 'body');
    await vi.waitFor(() => expect(mocks.renderMargins).toHaveBeenCalled());
    await vi.waitFor(() => expect(fileItem('表紙.pdf').textContent).not.toContain('余白を読み取り中'));
    expect(mocks.renderMargins.mock.calls.map(([, index]) => index).sort()).toEqual([2, 3]);
  });

  it('OCR する頁が無ければ、OCR の準備を始めない（iPhone・iPad でメモリを余計に使わない）', async () => {
    drop([file('odd.pdf', pdf([page('o1', 1), page('o3', 3)]))]);
    await settled(1);
    expect(mocks.prepareOcr).not.toHaveBeenCalled();
  });

  it('見出しの「?」は、押すと説明を開き、もう一度押すか外を押すか Esc で閉じる', () => {
    const [intro, files] = document.querySelectorAll('.bm-help');
    const button = (help) => help.querySelector('.bm-help-btn');
    const isOpen = (help) => help.classList.contains('open') && button(help).getAttribute('aria-expanded') === 'true';

    button(intro).click();
    expect(isOpen(intro)).toBe(true);
    button(intro).click();
    expect(isOpen(intro)).toBe(false);

    // 開けるのは 1 つだけ。説明の文を押しても閉じず、節も畳まない。
    button(intro).click();
    button(files).click();
    expect(isOpen(intro)).toBe(false);
    expect(isOpen(files)).toBe(true);
    files.querySelector('.bm-help-body').click();
    expect(isOpen(files)).toBe(true);
    expect($('filesSection').hasAttribute('collapsed')).toBe(false);

    document.body.click();
    expect(isOpen(files)).toBe(false);
    button(files).click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(isOpen(files)).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(isOpen(files)).toBe(false);
  });

  it('見出しの「?」は、マウスを載せている間だけ開き、開くのはいつも 1 つだけ', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const [intro, files] = document.querySelectorAll('.bm-help');
      const isOpen = (help) =>
        help.classList.contains('open') && help.querySelector('.bm-help-btn').getAttribute('aria-expanded') === 'true';
      const pointer = (help, type, pointerType = 'mouse') =>
        help.dispatchEvent(Object.assign(new Event(type), { pointerType }));

      // タッチの pointerenter では開かない（押したときに開く）。
      pointer(intro, 'pointerenter', 'touch');
      expect(isOpen(intro)).toBe(false);
      intro.querySelector('.bm-help-btn').click();
      pointer(intro, 'pointerleave', 'touch');
      vi.advanceTimersByTime(1000);
      expect(isOpen(intro)).toBe(true);
      intro.querySelector('.bm-help-btn').click();

      pointer(intro, 'pointerenter');
      expect(isOpen(intro)).toBe(true);
      // 載せたまま押しても閉じない。
      intro.querySelector('.bm-help-btn').click();
      expect(isOpen(intro)).toBe(true);
      // 説明の文へ動かす間の隙間では閉じない。
      pointer(intro, 'pointerleave');
      vi.advanceTimersByTime(100);
      pointer(intro, 'pointerenter');
      vi.advanceTimersByTime(1000);
      expect(isOpen(intro)).toBe(true);
      pointer(intro, 'pointerleave');
      vi.advanceTimersByTime(1000);
      expect(isOpen(intro)).toBe(false);

      // 押して開いたものがあっても、別の「?」に載せればそちらだけになる。
      files.querySelector('.bm-help-btn').click();
      pointer(intro, 'pointerenter');
      expect(isOpen(files)).toBe(false);
      expect(isOpen(intro)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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

    // 並びが変わったら、結合した PDF は捨てる（保存し終える前でも、保存は続ける）。
    change(fileItem('猫_表紙.pdf').querySelector('select'), 'front');
    expect($('downloadBtn').disabled).toBe(true);
    expect($('verifyResult').hidden).toBe(true);
    await flush();
    $('logBox').open = true;
    $('logBox').dispatchEvent(new Event('toggle'));
    expect($('logText').textContent).toContain('「猫.pdf」をダウンロードしました');
  });

  it('iPhone では、共有シートに渡せない大きさの PDF は、ダウンロードに保存すると記録に残す。保存できなければ知らせる', async () => {
    const userAgent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
    );
    Object.assign(navigator, { share: vi.fn().mockResolvedValue(undefined), canShare: () => true });
    // 結合した PDF が 300 MB あったことにする（中身は小さな偽物のまま）。
    const merge = mocks.mergePdf.getMockImplementation();
    mocks.mergePdf.mockImplementation(async (options) => ({ ...(await merge(options)), size: 300 * 1024 * 1024 }));
    await addBook();
    $('mergeBtn').click();
    await vi.waitFor(() => expect($('downloadBtn').disabled).toBe(false));

    $('downloadBtn').click();
    await flush();
    $('logBox').open = true;
    $('logBox').dispatchEvent(new Event('toggle'));
    expect($('logText').textContent).toContain('「猫.pdf」を保存します（300.0 MB）');
    expect($('logText').textContent).toContain('大きいので、共有シートではなく、ダウンロード（既定のダウンロードフォルダ）に保存します');
    // jsdom には Service Worker が無いので、保存できなかったと知らせる（共有シートには替えない）。
    expect(navigator.share).not.toHaveBeenCalled();
    expect($('message').textContent).toBe('「猫.pdf」を保存できませんでした（このブラウザは Service Worker を使えません）。');
    userAgent.mockRestore();
    delete navigator.share;
    delete navigator.canShare;
  });

  it('保存領域があれば、読み込んだ中身はそこに置いてメモリから手放し、結合した PDF もそこへ書き出す', async () => {
    const stash = await fakeStash();
    await addBook();
    expect([...stash.files.keys()].sort()).toEqual(['f1.pdf', 'f2.pdf', 'f3.pdf']);
    // 調べるときは、置いたものから読む（元のファイルは読み直さない）。
    expect(stash.reads.sort()).toEqual(['f1.pdf', 'f2.pdf', 'f3.pdf']);
    change(fileItem('猫_表紙.pdf').querySelector('select'), 'split');
    stash.reads.length = 0;

    $('mergeBtn').click();
    await vi.waitFor(() => expect($('verifyResult').hidden).toBe(false));

    expect(mocks.mergePdf).not.toHaveBeenCalled();
    expect(stash.reads.sort()).toEqual(['f1.pdf', 'f2.pdf', 'f3.pdf']);
    expect(stash.files.has('merged-1.pdf')).toBe(true);
    // 検証では、読んだ中身をそのまま pdf.js へ渡す（写しを作らない）。
    expect(mocks.openOptions.at(-1)).toEqual({ transfer: true });
    expect($('verifyResult').className).toBe('bm-verify ok');
    $('logBox').open = true;
    $('logBox').dispatchEvent(new Event('toggle'));
    expect($('logText').textContent).toContain('保存領域に書き出し');

    // 保存するのは、保存領域のファイル。
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    $('downloadBtn').click();
    expect(click).toHaveBeenCalled();
    expect(URL.createObjectURL.mock.calls.at(-1)[0].size).toBe(stash.files.get('merged-1.pdf').length);

    // 結合し直すときは別の名前で書き（保存中のものを書き換えない）、書き終えたら前のものを消す。
    change(fileItem('猫_表紙.pdf').querySelector('select'), 'front');
    $('mergeBtn').click();
    await vi.waitFor(() => expect($('verifyResult').hidden).toBe(false));
    expect(stash.files.has('merged-2.pdf')).toBe(true);
    expect(stash.files.has('merged-1.pdf')).toBe(false);

    // 外したファイルは、置いたものも消す。
    fileItem('猫_偶数.pdf').querySelector('.danger').click();
    expect(stash.removed).toContain('f2.pdf');
  });

  it('保存領域を使えなければ、その理由を記録に出し、Blob にしてページの外に置く', async () => {
    mocks.openStash.mockRejectedValue(new Error('Context not access storage'));
    vi.resetModules();
    installPage();
    await import('../src/pdf-book-merger/main.js');
    await mocks.prepare();
    drop([file('猫_奇数.pdf', pdf(ODD)), file('猫_偶数.pdf', pdf(EVEN))]);
    await settled(2);

    $('mergeBtn').click();
    await vi.waitFor(() => expect($('verifyResult').hidden).toBe(false));
    expect(mocks.writeMergedPdf).toHaveBeenCalled();
    expect(mocks.mergePdf).not.toHaveBeenCalled();
    // 検証では、読んだ中身をそのまま pdf.js へ渡す（写しを作らない）。
    expect(mocks.openOptions.at(-1)).toEqual({ transfer: true });
    $('logBox').open = true;
    $('logBox').dispatchEvent(new Event('toggle'));
    const text = $('logText').textContent;
    // 1 度だけ出す。
    expect(text.split('読み込んだ PDF は').length).toBe(2);
    expect(text).toContain('読み込んだ PDF は Blob にしてページの外に置きます（保存領域を使えない: Context not access storage）');
    expect(text).toContain('結合を始めます（2 ファイル・8 頁、結合した PDF は Blob にしてページの外に置きます（保存領域を使えない: Context not access storage）、');
    expect(text).toContain('Blob に書き出し');
    expect(text).toContain('検証: pdf.js で開きました');
    // 検証では、1 頁読むたびに pdf.js の文書に溜めたもの（書体など）を捨てる。
    expect(mocks.cleanups).toBe(8);
    // 検証を終えたら、pdf.js の worker ごと止めて、結合した PDF の写しを返す。
    expect(mocks.releasePdfWorker).toHaveBeenCalledTimes(1);
    expect(text).toContain('検証: pdf.js の worker を止めて、結合した PDF の写しを手放しました');

    // 保存するのは、その Blob。
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    $('downloadBtn').click();
    expect(click).toHaveBeenCalled();
    expect(URL.createObjectURL.mock.calls.at(-1)[0].size).toBeGreaterThan(0);
  });

  it('保存領域の代わりも使えなければ（テストの偽物だけ）、メモリに持つと記録に出す', async () => {
    // ほかに開いている文書があれば、worker は止めない（記録にも出さない）。
    mocks.releasePdfWorker.mockReturnValue(false);
    drop([file('猫_奇数.pdf', pdf(ODD))]);
    await settled(1);
    $('mergeBtn').click();
    await vi.waitFor(() => expect($('verifyResult').hidden).toBe(false));
    $('logBox').open = true;
    $('logBox').dispatchEvent(new Event('toggle'));
    expect($('logText').textContent).toContain('読み込んだ PDF はメモリに持ちます');
    expect($('logText').textContent).not.toContain('worker を止めて');
    expect($('logText').textContent).toContain('メモリの上で');
  });

  it('処理している間だけ記録を残し、途中でページが落ちたら、次に開いたときに前回の記録を出す', async () => {
    const kept = () =>
      Object.keys(localStorage)
        .filter((key) => key.startsWith('pdf-book-merger:log'))
        .map((key) => JSON.parse(localStorage.getItem(key)).lines);
    // 処理を終えたら、残した記録は消す（裏に回したタブが片付けられても「落ちた」と出さない）。
    drop([file('猫_偶数.pdf', pdf(EVEN))]);
    await settled(1);
    expect(kept()).toEqual([]);

    // 調べている途中で止めておく。
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const render = mocks.renderPageImage.getMockImplementation();
    mocks.renderPageImage.mockImplementation(async (doc, index, ...rest) => {
      if (doc.spec.pages[index].id === 'o3') await gate;
      return render(doc, index, ...rest);
    });
    drop([file('猫_奇数.pdf', pdf(ODD))]);
    await vi.waitFor(() =>
      expect(kept().some((lines) => lines.some((line) => line.includes('「猫_奇数.pdf」の文字情報を読みました')))).toBe(true)
    );

    // 落ちた（pagehide が来ないまま、開き直した）。
    vi.resetModules();
    installPage();
    await import('../src/pdf-book-merger/main.js');
    await mocks.prepare();
    await vi.waitFor(() => expect($('message').textContent).toContain('前回は処理の途中でページが終わったようです'));
    $('logBox').open = true;
    $('logBox').dispatchEvent(new Event('toggle'));
    expect($('logText').textContent).toContain('── 前回、途中でページが終わる前の記録 ──');
    expect($('logText').textContent).toContain('「猫_奇数.pdf」の文字情報を読みました');
    // 落ちる前のページの仕事を終わらせる（終えたら、その記録も消える）。
    release();
    await vi.waitFor(() => {
      expect(mocks.renderPageImage.mock.calls.some(([doc, index]) => doc.spec.pages[index].id === 'o7')).toBe(true);
      expect(kept()).toEqual([]);
    });
    await flush();
  });

  it('保存している間も記録を残し、終えたら消す', async () => {
    drop([file('猫_奇数.pdf', pdf(ODD)), file('猫_偶数.pdf', pdf(EVEN))]);
    await settled(2);
    $('mergeBtn').click();
    await vi.waitFor(() => expect($('downloadBtn').disabled).toBe(false));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      // 保存している最中に残っている。
      expect(Object.keys(localStorage).some((key) => key.startsWith('pdf-book-merger:log'))).toBe(true);
    });
    $('downloadBtn').click();
    await vi.waitFor(() => expect(click).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(Object.keys(localStorage).some((key) => key.startsWith('pdf-book-merger:log'))).toBe(false)
    );
    await vi.waitFor(() => expect($('progress').hidden).toBe(true));
    $('logBox').open = true;
    $('logBox').dispatchEvent(new Event('toggle'));
    expect($('logText').textContent).toContain('「猫.pdf」を保存します（');
    await flush(); // 開いた記録の toggle（あとから届く）を、テストの間に受ける
  });

  it('保存領域に置けなかったファイルはメモリに持ち、結合した PDF を書けなければメモリの上で結合し直す', async () => {
    const stash = await fakeStash();
    stash.failPut.add('f2.pdf');
    await addBook();
    expect([...stash.files.keys()].sort()).toEqual(['f1.pdf', 'f3.pdf']);
    stash.failWrite = true;

    $('mergeBtn').click();
    await vi.waitFor(() => expect($('verifyResult').hidden).toBe(false));

    expect(mocks.writeMergedPdf).toHaveBeenCalled();
    expect(mocks.mergePdf).toHaveBeenCalled();
    expect(mocks.openOptions.at(-1)).toEqual({ transfer: false });
    expect($('verifyResult').className).toBe('bm-verify ok');
    $('logBox').open = true;
    $('logBox').dispatchEvent(new Event('toggle'));
    const text = $('logText').textContent;
    expect(text).toContain('「猫_偶数.pdf」を保存領域に置けなかったので、メモリに持ちます（quota）');
    expect(text).toContain('結合した PDF を保存領域に書けなかったので、メモリの上で結合し直します（quota）');
    expect(text).toContain('メモリの上で');
    // 書きかけは消す。
    expect(stash.removed).toContain('merged-1.pdf');

    // 書き口を開けなかったときも、メモリの上で結合し直す。
    stash.failWrite = false;
    stash.failOpen = true;
    mocks.mergePdf.mockClear();
    change(fileItem('猫_表紙.pdf').querySelector('select'), 'front');
    $('mergeBtn').click();
    await vi.waitFor(() => expect($('verifyResult').hidden).toBe(false));
    expect(mocks.mergePdf).toHaveBeenCalled();
  });

  it('保存領域に書き出す結合が、書く以外のことで失敗したら、その理由を出す（メモリの上でやり直さない）', async () => {
    await fakeStash();
    await addBook();
    mocks.writeMergedPdf.mockRejectedValue(new Error('「猫_奇数.pdf」は暗号化（パスワード保護）されているため結合できません。'));

    const stash = await mocks.openStash();
    $('mergeBtn').click();
    await vi.waitFor(() => expect($('message').textContent).toContain('暗号化'));
    expect(mocks.mergePdf).not.toHaveBeenCalled();
    // 書きかけは閉じて消す（書き口を開いたままにすると、次の結合で開けない）。
    expect(stash.removed).toContain('merged-1.pdf');
  });

  it('保存領域に置いている間に外したファイルや、調べられなかったファイルは、置いたものを消す', async () => {
    const stash = await fakeStash();
    let release;
    stash.put.mockImplementationOnce(async (name, bytes) => {
      await new Promise((done) => (release = done));
      stash.files.set(name, bytes.slice());
    });
    drop([file('猫_奇数.pdf', pdf(ODD))]);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    fileItem('猫_奇数.pdf').querySelector('.danger').click();
    release();
    await vi.waitFor(() => expect(stash.removed).toContain('f1.pdf'));
    expect(stash.files.size).toBe(0);

    drop([file('壊れた.pdf', encoder.encode('not a pdf'))]);
    await settled(1);
    expect(fileItem('壊れた.pdf').classList.contains('error')).toBe(true);
    expect(stash.removed).toContain('f2.pdf');
    expect(stash.files.size).toBe(0);
  });

  it('置いたものを読んでいる間に外したファイルは、読み終えても中身を持たず、読めなくても知らせない', async () => {
    const stash = await fakeStash();
    for (const stale of [true, false]) {
      let release;
      stash.readGate = new Promise((resolve) => (release = resolve));
      stash.readStale = stale;
      const name = stale ? '猫_奇数.pdf' : '猫_偶数.pdf';
      drop([file(name, pdf(stale ? ODD : EVEN))]);
      await vi.waitFor(() => expect(stash.reads).toHaveLength(stale ? 1 : 2));
      fileItem(name).querySelector('.danger').click();
      release();
      await vi.waitFor(() => expect(document.querySelectorAll('#fileList .bm-file')).toHaveLength(0));
      // 順番待ちが空になるまで待つ（テストを終えたあとに画面へ書かないように）。
      await vi.waitFor(() => expect($('progress').hidden).toBe(true));
    }
    stash.readGate = null;
    $('logBox').open = true;
    $('logBox').dispatchEvent(new Event('toggle'));
    expect($('logText').textContent).not.toContain('調べられませんでした');
    expect(mocks.findScanImages).not.toHaveBeenCalled();
    await flush(); // 開いた記録の toggle（あとから届く）を、テストの間に受ける
  });

  it('あとからの OCR で置いたものを読んでいる間に外したファイルは、中身を持たない', async () => {
    const stash = await fakeStash();
    drop([file('猫_表紙.pdf', pdf(ODD))]);
    await settled(1);
    let release;
    stash.readGate = new Promise((resolve) => (release = resolve));
    stash.readStale = true;
    stash.reads.length = 0;
    change(fileItem('猫_表紙.pdf').querySelector('select'), 'body');
    await vi.waitFor(() => expect(stash.reads).toHaveLength(1));
    fileItem('猫_表紙.pdf').querySelector('.danger').click();
    release();
    await vi.waitFor(() => expect($('progress').hidden).toBe(true));
    // 調べ直さない（外したので）。
    expect(mocks.findScanImages).toHaveBeenCalledTimes(1);
    expect(mocks.renderMargins).not.toHaveBeenCalled();
  });

  it('保存領域に置いたファイルも、拡大表示とあとからの OCR では、置いたものから読む', async () => {
    const stash = await fakeStash();
    drop([file('猫_表紙.pdf', pdf(ODD)), file('猫_偶数.pdf', pdf(EVEN))]);
    await settled(2);
    stash.reads.length = 0;

    change(fileItem('猫_表紙.pdf').querySelector('select'), 'body');
    await vi.waitFor(() => expect(mocks.renderMargins).toHaveBeenCalled());
    await vi.waitFor(() => expect(fileItem('猫_表紙.pdf').textContent).not.toContain('余白を読み取り中'));
    // 頁の JPEG は残していないので、置いたものを 1 度だけ読んで調べ直す（PDF を
    // 開くのにも同じものを使う）。（名前の順に足すので、猫_表紙.pdf は 2 つ目の f2）
    expect(stash.reads).toEqual(['f2.pdf']);
    expect(mocks.findScanImages).toHaveBeenCalledTimes(3);

    document.querySelector('#pageGrid [data-page-key="f1:0"] .bm-thumb').click();
    await vi.waitFor(() => expect(stash.reads).toContain('f1.pdf'));
  });

  it('問題が残っていれば確かめてから結合し、食い違いは頁ごとに挙げる', async () => {
    drop([file('猫_奇数.pdf', pdf(ODD))]);
    await settled(1);
    // 結合の途中で頁が化けた、という偽物。
    mocks.mergePdf.mockImplementation(async ({ sources, order, title }) => {
      const source = await sourcePages(sources, order);
      const pages = source.map((p, i) => ({ ...p, noText: true, corrupt: i === 0 }));
      // タイトルも書き込めていない。
      return { bytes: pdf(pages, { title: '', labels: null }), digests: source.map((p) => `d-${p.id}`) };
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
    expect($('verifyResult').textContent).toContain('タイトル: （なし）');
    expect($('verifyResult').textContent).toContain('文字情報（検索できる文字）が失われています');
    expect($('verifyResult').textContent).toContain('1 枚目（1 頁）: 文字情報（検索できる文字）が失われています・画像・描く中身が元の頁と違います');
    expect($('verifyResult').textContent).toContain('書き込みを確かめられませんでした');
  });

  it('結合している間に並びが変わったら、その結果は使わない（ファイルを外しても壊れない）', async () => {
    await addBook();
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const answer = mocks.mergePdf.getMockImplementation();
    mocks.mergePdf.mockImplementationOnce(async (args) => {
      await gate;
      return answer(args);
    });

    $('mergeBtn').click();
    await flush();
    fileItem('猫_表紙.pdf').querySelector('button[aria-label="このファイルを削除"]').click();
    release();

    await vi.waitFor(() => expect($('message').textContent).toContain('結合している間に並びか名前が変わりました'));
    expect($('downloadBtn').disabled).toBe(true);
    expect($('verifyResult').hidden).toBe(true);
    expect($('mergeBtn').disabled).toBe(false);

    // もう一度押せば、いまの並びで結合する。
    $('mergeBtn').click();
    await vi.waitFor(() => expect($('verifyResult').hidden).toBe(false));
    expect(mocks.mergePdf.mock.calls[1][0].order).toHaveLength(8);
    expect($('downloadBtn').disabled).toBe(false);
  });

  it('結合する中身が変わらない操作や裏の処理では、結合した PDF を捨てない', async () => {
    await addBook();
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const answer = mocks.mergePdf.getMockImplementation();
    mocks.mergePdf.mockImplementationOnce(async (args) => {
      await gate;
      return answer(args);
    });

    $('mergeBtn').click();
    await flush();
    // 先頭に置くファイルが 1 つだけなら、番号を入れても本の並びは変わらない。
    fileItem('猫_表紙.pdf').toggle();
    change(fileItem('猫_表紙.pdf').querySelector('.bm-file-controls input[type="text"]'), '3');
    release();

    await vi.waitFor(() => expect($('verifyResult').hidden).toBe(false));
    expect($('message').textContent).toBe('');
    expect($('downloadBtn').disabled).toBe(false);
  });

  it('提案する名前が変わったら、結合した PDF は捨てる（古い名前で保存しない）', async () => {
    await addBook();
    $('mergeBtn').click();
    await vi.waitFor(() => expect($('downloadBtn').disabled).toBe(false));
    expect($('outputName').value).toBe('猫.pdf');

    // 読めないファイルを足すと、並びは変わらず、提案する名前だけが変わる。
    drop([file('犬_奇数.pdf', encoder.encode('not a pdf'))]);
    await settled(4);

    expect($('outputName').value).not.toBe('猫.pdf');
    expect($('downloadBtn').disabled).toBe(true);
  });

  it('結合している間の拡大表示は、縮小画像だけを出す（PDF を開き直さない）', async () => {
    await addBook();
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const answer = mocks.mergePdf.getMockImplementation();
    mocks.mergePdf.mockImplementationOnce(async (args) => {
      await gate;
      return answer(args);
    });

    $('mergeBtn').click();
    await flush();
    document.querySelector('#pageGrid .bm-thumb').click();
    await flush();
    expect($('previewDialog').open).toBe(true);
    expect(mocks.renderPreview).not.toHaveBeenCalled();

    release();
    await vi.waitFor(() => expect($('downloadBtn').disabled).toBe(false));
    // 開いたままの拡大表示は、結合が済んだら大きく描き直す。
    await vi.waitFor(() => expect(mocks.renderPreview).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect($('previewImage').src).toBe('blob:preview'));
    $('previewCloseBtn').click();
    // 結合が済めば、また大きく描く。
    document.querySelector('#pageGrid .bm-thumb').click();
    await vi.waitFor(() => expect(mocks.renderPreview).toHaveBeenCalledTimes(2));
  });

  it('検証で読めない頁があっても、結合した PDF は閉じる', async () => {
    await addBook();
    const answer = mocks.mergePdf.getMockImplementation();
    mocks.mergePdf.mockImplementationOnce(async (args) => {
      const result = await answer(args);
      const spec = specOf(result.bytes);
      spec.pages[3].broken = '読めない頁';
      return { ...result, bytes: pdf(spec.pages, { title: spec.title, labels: spec.labels }) };
    });

    $('mergeBtn').click();

    await vi.waitFor(() => expect($('message').textContent).toContain('4 頁目を検証できませんでした'));
    expect(mocks.closePdf.mock.calls.some(([doc]) => doc?.spec?.title === '猫')).toBe(true);
    expect($('downloadBtn').disabled).toBe(true);
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
