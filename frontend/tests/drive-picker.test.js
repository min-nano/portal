// @vitest-environment jsdom
//
// Drive のファイル選択ダイアログ。一覧の API（/api/drive/items）は偽物に
// 差し替え、送る条件（場所・フォルダ・検索・種類の絞り込み）と、たどる・
// 選ぶ・キャンセルの操作の結果を確かめる。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// api.js は Clerk を読み込むため、丸ごと差し替える（API の応答を注入する）。
const apiGet = vi.fn();
vi.mock('../src/api.js', () => ({ apiGet: (path, options) => apiGet(path, options) }));

const PDF_MIME = 'application/pdf';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

const folder = (id, name) => ({ id, name, mimeType: FOLDER_MIME, folder: true, modifiedTime: null });
const pdf = (id, name) => ({
  id,
  name,
  mimeType: PDF_MIME,
  folder: false,
  modifiedTime: '2026-10-01T00:00:00Z',
});

/** 送られた条件（URL のクエリ）を辞書にする。 */
function query(path) {
  const url = new URL(path, 'https://portal.example');
  expect(url.pathname).toBe('/api/drive/items');
  return Object.fromEntries(url.searchParams);
}

/** 条件ごとの応答を決める。決めていない条件は空の一覧。 */
function respond(table) {
  apiGet.mockImplementation((path) => {
    const params = query(path);
    const key = params.q ? `q:${params.q}` : params.folder || params.location;
    const page = params.pageToken ? `${key}#${params.pageToken}` : key;
    const value = table[page];
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(value || { items: [], nextPageToken: null });
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const dialog = () => document.getElementById('drivePicker');
const items = () => [...dialog().querySelectorAll('.drive-picker-item')];
const itemNamed = (name) => items().find((node) => node.textContent.includes(name));
const button = (text) =>
  [...dialog().querySelectorAll('button')].find((node) => node.textContent.trim() === text);
const crumbs = () =>
  [...dialog().querySelectorAll('.drive-picker-crumbs li')].map((node) => node.textContent);
const status = () => dialog().querySelector('.drive-picker-status');

let pickFile;
let pickFiles;

beforeEach(async () => {
  vi.resetModules();
  apiGet.mockReset();
  document.body.innerHTML = '';
  // jsdom の <dialog> には showModal / close が無い。開閉の印だけを真似る。
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
  ({ pickFile, pickFiles } = await import('../src/drive-picker.js'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('最初の表示', () => {
  it('マイドライブを、指定した種類に絞って開く', async () => {
    respond({ 'my-drive': { items: [folder('d1', '図面'), pdf('p1', '証明書.pdf')] } });

    const picking = pickFile({ title: 'PDF を選択', mimeTypes: PDF_MIME });
    await flush();

    expect(dialog().hasAttribute('open')).toBe(true);
    expect(document.getElementById('drivePickerTitle').textContent).toBe('PDF を選択');
    expect(query(apiGet.mock.calls[0][0])).toEqual({
      location: 'my-drive',
      mimeTypes: PDF_MIME,
    });
    expect(items().map((node) => node.querySelector('.drive-picker-name').textContent)).toEqual([
      '図面',
      '証明書.pdf',
    ]);
    expect(crumbs()).toEqual(['マイドライブ']);
    button('キャンセル').click();
    await picking;
  });

  it('フォルダを選ぶときはフォルダだけを頼む', async () => {
    respond({});

    const picking = pickFile({ title: '保存先', selectFolder: true, mimeTypes: PDF_MIME });
    await flush();

    expect(query(apiGet.mock.calls[0][0])).toEqual({ location: 'my-drive', foldersOnly: 'true' });
    button('キャンセル').click();
    await picking;
  });

  it('空のときは、そう表示する', async () => {
    respond({});

    const picking = pickFile({});
    await flush();

    expect(status().textContent).toContain('選べるものがありません');
    button('キャンセル').click();
    await picking;
  });
});

describe('後ろのページ', () => {
  it('開いている間は動かさず、閉じたら元に戻す', async () => {
    respond({});
    document.body.style.paddingRight = '3px';

    const picking = pickFile({});
    await flush();
    expect(document.body.style.overflow).toBe('hidden');
    // スクロールバーが消えた分を余白で埋め、横にずれないようにする。
    const width = window.innerWidth - document.documentElement.clientWidth;
    if (width > 0) expect(document.body.style.paddingRight).toBe(`${3 + width}px`);
    button('キャンセル').click();
    await picking;

    expect(document.body.style.overflow).toBe('');
    expect(document.body.style.paddingRight).toBe('3px');
  });
});

describe('ファイルを選ぶ', () => {
  it('ファイルを選んで「選択」を押すと、その ID・名前・種類を返す', async () => {
    respond({ 'my-drive': { items: [pdf('p1', '証明書.pdf')] } });

    const picking = pickFile({ mimeTypes: PDF_MIME });
    await flush();
    expect(button('選択').disabled).toBe(true);

    itemNamed('証明書.pdf').click();
    expect(itemNamed('証明書.pdf').getAttribute('aria-pressed')).toBe('true');
    expect(button('選択').disabled).toBe(false);
    button('選択').click();

    await expect(picking).resolves.toEqual({ id: 'p1', name: '証明書.pdf', mimeType: PDF_MIME });
    expect(dialog().hasAttribute('open')).toBe(false);
  });

  it('ダブルクリックでそのまま決まる', async () => {
    respond({ 'my-drive': { items: [pdf('p1', '証明書.pdf')] } });

    const picking = pickFile({});
    await flush();
    // ブラウザは click（detail 1）・click（detail 2）・dblclick の順に送る。
    const row = itemNamed('証明書.pdf');
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    await expect(picking).resolves.toMatchObject({ id: 'p1' });
  });

  it('キャンセル・閉じる・Esc はどれも null', async () => {
    respond({});
    for (const close of [
      () => button('キャンセル').click(),
      () => dialog().querySelector('[aria-label="閉じる"]').click(),
      () => dialog().dispatchEvent(new Event('cancel', { cancelable: true })),
    ]) {
      const picking = pickFile({});
      await flush();
      close();
      await expect(picking).resolves.toBeNull();
    }
  });
});

describe('たどる', () => {
  it('フォルダに入り、パンくずで戻れる', async () => {
    respond({
      'my-drive': { items: [folder('d1', '案件')] },
      d1: { items: [folder('d2', '2026')] },
      d2: { items: [pdf('p1', '証明書.pdf')] },
    });

    const picking = pickFile({});
    await flush();
    itemNamed('案件').click();
    await flush();
    itemNamed('2026').click();
    await flush();

    expect(crumbs()).toEqual(['マイドライブ', '案件', '2026']);
    expect(query(apiGet.mock.calls.at(-1)[0])).toEqual({ folder: 'd2' });
    expect(itemNamed('証明書.pdf')).toBeTruthy();

    dialog().querySelector('.drive-picker-crumb[data-depth="1"]').click();
    await flush();
    expect(crumbs()).toEqual(['マイドライブ', '案件']);
    expect(itemNamed('2026')).toBeTruthy();

    button('キャンセル').click();
    await picking;
  });

  it('タブで場所を切り替える', async () => {
    respond({ 'shared-drives': { items: [folder('sd', '設計部')] } });

    const picking = pickFile({});
    await flush();
    dialog().querySelector('[data-location="shared-drives"]').click();
    await flush();

    expect(query(apiGet.mock.calls.at(-1)[0]).location).toBe('shared-drives');
    expect(
      dialog().querySelector('[data-location="shared-drives"]').getAttribute('aria-selected')
    ).toBe('true');
    expect(itemNamed('設計部')).toBeTruthy();
    button('キャンセル').click();
    await picking;
  });

  it('開き直すと、前回いたフォルダから始まる', async () => {
    respond({ 'my-drive': { items: [folder('d1', '案件')] } });

    let picking = pickFile({});
    await flush();
    itemNamed('案件').click();
    await flush();
    button('キャンセル').click();
    await picking;

    picking = pickFile({});
    await flush();
    expect(query(apiGet.mock.calls.at(-1)[0])).toEqual({ folder: 'd1' });
    expect(crumbs()).toEqual(['マイドライブ', '案件']);
    button('キャンセル').click();
    await picking;
  });

  it('検索結果から入ったフォルダは、パンくずの先頭が検索結果になる', async () => {
    respond({
      'q:案件': { items: [folder('sd-folder', '共有の案件')] },
      'sd-folder': { items: [pdf('p1', 'a.pdf')] },
    });

    let picking = pickFile({ selectFolder: true });
    await flush();
    const input = dialog().querySelector('input[type="search"]');
    input.value = '案件';
    dialog().querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    itemNamed('共有の案件').click();
    await flush();

    // どのタブの下にあるかは分からないので、タブの名前は出さない。
    expect(crumbs()).toEqual(['「案件」の検索結果', '共有の案件']);
    expect(dialog().querySelector('[aria-selected="true"]')).toBeNull();
    button('キャンセル').click();
    await picking;

    // 開き直しても同じ場所から。先頭を押すと元の検索に戻る。
    picking = pickFile({ selectFolder: true });
    await flush();
    expect(crumbs()).toEqual(['「案件」の検索結果', '共有の案件']);
    dialog().querySelector('.drive-picker-crumb[data-depth="0"]').click();
    await flush();
    expect(query(apiGet.mock.calls.at(-1)[0]).q).toBe('案件');
    expect(input.value).toBe('案件');
    button('キャンセル').click();
    await picking;
  });

  it('ダブルクリックの 2 回目で、開いた先の行を押さない', async () => {
    respond({
      'my-drive': { items: [folder('d1', '案件')] },
      d1: { items: [folder('d2', '2026')] },
    });

    const picking = pickFile({});
    await flush();
    itemNamed('案件').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    await flush();
    // 1 回目で開いた先の、同じ位置の行に 2 回目が当たる。
    itemNamed('2026').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
    await flush();

    expect(crumbs()).toEqual(['マイドライブ', '案件']);
    button('キャンセル').click();
    await picking;
  });

  it('フォルダのダブルクリックで、開いた先のファイルを確定しない', async () => {
    respond({
      'my-drive': { items: [folder('d1', '案件')] },
      d1: { items: [pdf('p1', '証明書.pdf')] },
    });

    const picking = pickFile({});
    await flush();
    itemNamed('案件').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    await flush();
    // dblclick は、開いた先の同じ位置にある（触っていない）ファイルに届く。
    itemNamed('証明書.pdf').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await flush();

    expect(dialog().hasAttribute('open')).toBe(true);
    button('キャンセル').click();
    await expect(picking).resolves.toBeNull();
  });

  it('続きがあれば「さらに表示」で足す', async () => {
    respond({
      'my-drive': { items: [pdf('p1', 'a.pdf')], nextPageToken: 'n2' },
      'my-drive#n2': { items: [pdf('p2', 'b.pdf')], nextPageToken: null },
    });

    const picking = pickFile({});
    await flush();
    const more = button('さらに表示');
    expect(more.hidden).toBe(false);
    more.click();
    await flush();

    expect(items()).toHaveLength(2);
    expect(more.hidden).toBe(true);
    button('キャンセル').click();
    await picking;
  });

  it('ページをまたいで同じものが返っても、2 度は出さない', async () => {
    respond({
      'my-drive': { items: [folder('d1', '案件')], nextPageToken: 'n2' },
      'my-drive#n2': { items: [folder('d1', '案件（ショートカット）'), pdf('p1', 'a.pdf')] },
    });

    const picking = pickFile({});
    await flush();
    button('さらに表示').click();
    await flush();

    expect(items().map((node) => node.dataset.id)).toEqual(['d1', 'p1']);
    button('キャンセル').click();
    await picking;
  });

  it('1 ページが丸ごと対象外でも、続きがあれば読み進める', async () => {
    respond({
      'my-drive': { items: [], nextPageToken: 'n2' },
      'my-drive#n2': { items: [pdf('p1', 'a.pdf')] },
    });

    const picking = pickFile({ mimeTypes: PDF_MIME });
    await flush();
    await flush();

    expect(itemNamed('a.pdf')).toBeTruthy();
    expect(status().textContent).not.toContain('選べるものがありません');
    button('キャンセル').click();
    await picking;
  });
});

describe('フォルダを選ぶ', () => {
  it('入っているフォルダを返す', async () => {
    respond({ 'my-drive': { items: [folder('d1', '証明書')] } });

    const picking = pickFile({ selectFolder: true });
    await flush();
    itemNamed('証明書').click();
    await flush();
    button('このフォルダを選択').click();

    await expect(picking).resolves.toEqual({ id: 'd1', name: '証明書', mimeType: FOLDER_MIME });
  });

  it('マイドライブの最上位も選べる', async () => {
    respond({});

    const picking = pickFile({ selectFolder: true });
    await flush();
    button('このフォルダを選択').click();

    await expect(picking).resolves.toEqual({
      id: 'root',
      name: 'マイドライブ',
      mimeType: FOLDER_MIME,
    });
  });

  it('共有ドライブの一覧のように、フォルダの中でない場所では選べない', async () => {
    respond({});

    const picking = pickFile({ selectFolder: true });
    await flush();
    dialog().querySelector('[data-location="shared-drives"]').click();
    await flush();

    expect(button('このフォルダを選択').disabled).toBe(true);
    button('キャンセル').click();
    await picking;
  });
});

describe('検索', () => {
  it('打ち終わるのを待ってから、名前で探す', async () => {
    respond({ 'q:証明': { items: [pdf('p1', '証明書.pdf')] } });

    const picking = pickFile({ mimeTypes: PDF_MIME });
    await flush();
    vi.useFakeTimers();
    const input = dialog().querySelector('input[type="search"]');
    input.value = '証';
    input.dispatchEvent(new Event('input'));
    input.value = '証明';
    input.dispatchEvent(new Event('input'));
    const before = apiGet.mock.calls.length;
    vi.advanceTimersByTime(400);
    vi.useRealTimers();
    await flush();

    // 打っている途中の「証」では問い合わせない。
    expect(apiGet.mock.calls.length).toBe(before + 1);
    expect(query(apiGet.mock.calls.at(-1)[0])).toEqual({ q: '証明', mimeTypes: PDF_MIME });
    expect(crumbs()).toEqual(['「証明」の検索結果']);
    expect(itemNamed('証明書.pdf')).toBeTruthy();
    button('キャンセル').click();
    await picking;
  });

  it('見つからなければ、そう表示する', async () => {
    respond({});

    const picking = pickFile({});
    await flush();
    const input = dialog().querySelector('input[type="search"]');
    input.value = '無い';
    dialog().querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();

    expect(status().textContent).toContain('見つかりませんでした');
    button('キャンセル').click();
    await picking;
  });
});

describe('失敗', () => {
  it('理由を表示し、再試行できる', async () => {
    respond({ 'my-drive': new Error('Drive の一覧の取得が拒否されました') });

    const picking = pickFile({});
    await flush();
    expect(status().textContent).toContain('拒否されました');

    respond({ 'my-drive': { items: [pdf('p1', 'a.pdf')] } });
    button('再試行').click();
    await flush();

    expect(itemNamed('a.pdf')).toBeTruthy();
    expect(status().hidden).toBe(true);
    button('キャンセル').click();
    await picking;
  });

  it('続きの読み込みに失敗しても、読めた分は残し、その続きだけを読み直す', async () => {
    respond({
      'my-drive': { items: [pdf('p1', 'a.pdf')], nextPageToken: 'n2' },
      'my-drive#n2': new Error('一時的なエラー'),
    });

    const picking = pickFile({});
    await flush();
    button('さらに表示').click();
    await flush();
    expect(status().textContent).toContain('一時的なエラー');
    expect(itemNamed('a.pdf')).toBeTruthy();

    respond({
      'my-drive': { items: [pdf('x', '最初から読み直した.pdf')] },
      'my-drive#n2': { items: [pdf('p2', 'b.pdf')] },
    });
    button('再試行').click();
    await flush();

    expect(items().map((node) => node.dataset.id)).toEqual(['p1', 'p2']);
    button('キャンセル').click();
    await picking;
  });

  it('Drive が一部の共有ドライブを探さずに返したら、そう添える', async () => {
    respond({ 'q:図面': { items: [], incomplete: true } });

    const picking = pickFile({});
    await flush();
    dialog().querySelector('input[type="search"]').value = '図面';
    dialog().querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();

    expect(status().textContent).toContain('見つかりませんでした');
    expect(status().textContent).toContain('一部の共有ドライブは探せていない');
    button('キャンセル').click();
    await picking;
  });

  it('移った先の読み込みが始まったら、前の通信は打ち切る', async () => {
    const signals = [];
    apiGet.mockImplementation((path, options) => {
      signals.push(options.signal);
      return new Promise(() => {});
    });

    const picking = pickFile({});
    await flush();
    dialog().querySelector('[data-location="recent"]').click();
    await flush();

    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    button('キャンセル').click();
    await picking;
    expect(signals[1].aborted).toBe(true);
  });

  it('遅れて届いた古い一覧で、今の場所を上書きしない', async () => {
    let releaseSlow;
    apiGet.mockImplementation((path) => {
      const params = query(path);
      if (params.location === 'my-drive') {
        return new Promise((resolve) => {
          releaseSlow = () => resolve({ items: [pdf('old', '古い.pdf')] });
        });
      }
      return Promise.resolve({ items: [folder('sd', '設計部')] });
    });

    const picking = pickFile({});
    await flush();
    dialog().querySelector('[data-location="shared-drives"]').click();
    await flush();
    releaseSlow();
    await flush();

    expect(itemNamed('古い.pdf')).toBeUndefined();
    expect(itemNamed('設計部')).toBeTruthy();
    button('キャンセル').click();
    await picking;
  });
});

describe('いくつも選ぶ', () => {
  const chooseButton = () => dialog().querySelector('.drive-picker-choose');
  const allButton = () => dialog().querySelector('.drive-picker-all');

  it('押すたびに選ぶ・外すが切り替わり、フォルダを移っても残る', async () => {
    respond({
      'my-drive': { items: [folder('d1', 'スキャン'), pdf('p0', '表紙.pdf')] },
      d1: { items: [pdf('p1', '奇数1.pdf'), pdf('p2', '偶数1.pdf')] },
    });

    const picking = pickFiles({ title: 'スキャンを選ぶ', mimeTypes: PDF_MIME });
    await flush();
    expect(chooseButton().disabled).toBe(true);
    // マイドライブの最上位では「すべて選ぶ」を出さない。
    expect(allButton().hidden).toBe(true);

    itemNamed('表紙.pdf').click();
    expect(chooseButton().textContent).toBe('選択（1 個）');
    itemNamed('スキャン').click();
    await flush();
    itemNamed('奇数1.pdf').click();
    itemNamed('偶数1.pdf').click();
    itemNamed('偶数1.pdf').click(); // 外す
    expect(itemNamed('偶数1.pdf').getAttribute('aria-pressed')).toBe('false');

    // 戻っても、選んだ印は残っている。
    dialog().querySelector('.drive-picker-crumb[data-depth="0"]').click();
    await flush();
    expect(itemNamed('表紙.pdf').getAttribute('aria-pressed')).toBe('true');
    expect(chooseButton().textContent).toBe('選択（2 個）');

    chooseButton().click();
    await expect(picking).resolves.toEqual([
      { id: 'p0', name: '表紙.pdf', mimeType: PDF_MIME },
      { id: 'p1', name: '奇数1.pdf', mimeType: PDF_MIME },
    ]);
  });

  it('ダブルクリックでは決めない', async () => {
    respond({ 'my-drive': { items: [pdf('p1', 'a.pdf')] } });
    const picking = pickFiles({});
    await flush();
    const row = itemNamed('a.pdf');
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(dialog().hasAttribute('open')).toBe(true);
    expect(row.getAttribute('aria-pressed')).toBe('true');
    button('キャンセル').click();
    await expect(picking).resolves.toEqual([]);
  });

  it('このフォルダのファイルを、続きまで読んですべて選ぶ', async () => {
    respond({
      'my-drive': { items: [folder('d1', 'スキャン')] },
      d1: { items: [folder('d9', '下書き'), pdf('p1', '1.pdf')], nextPageToken: 't2' },
      'd1#t2': { items: [pdf('p2', '2.pdf')] },
    });
    const picking = pickFiles({ mimeTypes: PDF_MIME });
    await flush();
    itemNamed('スキャン').click();
    await flush();
    expect(allButton().hidden).toBe(false);

    allButton().click();
    await flush();
    await flush();

    expect(chooseButton().textContent).toBe('選択（2 個）');
    expect(itemNamed('1.pdf').getAttribute('aria-pressed')).toBe('true');
    // 種類の絞り込みも付けて、そのフォルダを頼む。
    const asked = apiGet.mock.calls.map(([path]) => query(path)).filter((q) => q.folder === 'd1');
    expect(asked.at(-1)).toEqual({ folder: 'd1', mimeTypes: PDF_MIME, pageToken: 't2' });

    chooseButton().click();
    await expect(picking).resolves.toEqual([
      { id: 'p1', name: '1.pdf', mimeType: PDF_MIME },
      { id: 'p2', name: '2.pdf', mimeType: PDF_MIME },
    ]);
  });

  it('すべて選ぶ間に同じフォルダの続きを読んでも止めない。選び終えるまで「選択」は押せない', async () => {
    respond({
      'my-drive': { items: [folder('d1', 'スキャン')] },
      d1: { items: [pdf('p1', '1.pdf')], nextPageToken: 't2' },
      'd1#t2': { items: [pdf('p2', '2.pdf')] },
    });
    const picking = pickFiles({ mimeTypes: PDF_MIME });
    await flush();
    itemNamed('スキャン').click();
    await flush();
    itemNamed('1.pdf').click();
    expect(chooseButton().disabled).toBe(false);

    // 「すべて選ぶ」の最初の読み込みを待たせておき、その間に続きを読む。
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const answer = apiGet.getMockImplementation();
    apiGet.mockImplementationOnce(async (...args) => {
      await gate;
      return answer(...args);
    });
    allButton().click();
    expect(chooseButton().disabled).toBe(true);
    dialog().querySelector('.drive-picker-more').click();
    await flush();
    release();
    await flush();
    await flush();

    expect(chooseButton().disabled).toBe(false);
    expect(chooseButton().textContent).toBe('選択（2 個）');
    expect(itemNamed('2.pdf').getAttribute('aria-pressed')).toBe('true');
    chooseButton().click();
    await expect(picking).resolves.toHaveLength(2);
  });

  it('すべて選ぶ途中で別の場所へ移ったら、1 つも選ばない（フォルダの一部だけを選ばない）', async () => {
    respond({
      'my-drive': { items: [folder('d1', 'スキャン'), pdf('p0', '表紙.pdf')] },
      d1: { items: [pdf('p1', '1.pdf')], nextPageToken: 't2' },
      'd1#t2': { items: [pdf('p2', '2.pdf')] },
    });
    const picking = pickFiles({ mimeTypes: PDF_MIME });
    await flush();
    itemNamed('表紙.pdf').click();
    itemNamed('スキャン').click();
    await flush();

    // 1 ページ目を読んだところで、続きを待たせておく。
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const answer = apiGet.getMockImplementation();
    apiGet.mockImplementation(async (path, ...rest) => {
      if (query(path).pageToken === 't2') await gate;
      return answer(path, ...rest);
    });
    allButton().click();
    await flush();
    // 最上位へ戻る。
    dialog().querySelector('.drive-picker-crumb[data-depth="0"]').click();
    release();
    await flush();
    await flush();

    expect(chooseButton().disabled).toBe(false);
    expect(chooseButton().textContent).toBe('選択（1 個）');
    chooseButton().click();
    await expect(picking).resolves.toEqual([{ id: 'p0', name: '表紙.pdf', mimeType: PDF_MIME }]);
  });

  it('すべて選ぶのに失敗したら理由を出し、やり直せる。空ならそう出す', async () => {
    respond({
      'my-drive': { items: [folder('d1', '空')] },
      d1: { items: [folder('d2', '中')] },
    });
    const picking = pickFiles({});
    await flush();
    itemNamed('空').click();
    await flush();

    allButton().click();
    await flush();
    expect(status().textContent).toBe('このフォルダには選べるファイルがありません。');

    apiGet.mockRejectedValueOnce(new Error('Drive の一覧の取得に失敗しました。'));
    allButton().click();
    await flush();
    expect(status().textContent).toContain('Drive の一覧の取得に失敗しました。');
    status().querySelector('button').click();
    await flush();
    expect(status().textContent).toBe('このフォルダには選べるファイルがありません。');

    button('キャンセル').click();
    await expect(picking).resolves.toEqual([]);
  });

  it('1 つ選ぶダイアログに戻すと、すべて選ぶは出ない', async () => {
    respond({ 'my-drive': { items: [folder('d1', 'スキャン')] }, d1: { items: [pdf('p1', 'a.pdf')] } });
    const many = pickFiles({});
    await flush();
    itemNamed('スキャン').click();
    await flush();
    button('キャンセル').click();
    await many;

    const one = pickFile({});
    await flush();
    expect(allButton().hidden).toBe(true);
    expect(button('選択')).toBeTruthy();
    button('キャンセル').click();
    await expect(one).resolves.toBeNull();
  });
});
