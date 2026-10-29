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
const MODIFIED = '2026-10-01T00:00:00Z';

const folder = (id, name) => ({ id, name, mimeType: FOLDER_MIME, folder: true, modifiedTime: null });
const pdf = (id, name) => ({
  id,
  name,
  mimeType: PDF_MIME,
  folder: false,
  modifiedTime: MODIFIED,
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

  it('押すたびに選ぶ・外すが切り替わり、フォルダを移っても残る', async () => {
    respond({
      'my-drive': { items: [folder('d1', 'スキャン'), pdf('p0', '表紙.pdf')] },
      d1: { items: [pdf('p1', '奇数1.pdf'), pdf('p2', '偶数1.pdf')] },
    });

    const picking = pickFiles({ title: 'スキャンを選ぶ', mimeTypes: PDF_MIME });
    await flush();
    expect(chooseButton().disabled).toBe(true);
    // 1 つずつ選ぶ（フォルダのファイルをまとめて選ぶボタンは無い）。
    expect(dialog().querySelectorAll('.dialog-actions button')).toHaveLength(2);

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
      { id: 'p0', name: '表紙.pdf', mimeType: PDF_MIME, modifiedTime: MODIFIED },
      { id: 'p1', name: '奇数1.pdf', mimeType: PDF_MIME, modifiedTime: MODIFIED },
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

  it('1 つ選ぶダイアログに戻すと、選んだ数は出ない', async () => {
    respond({ 'my-drive': { items: [folder('d1', 'スキャン')] }, d1: { items: [pdf('p1', 'a.pdf')] } });
    const many = pickFiles({});
    await flush();
    itemNamed('スキャン').click();
    await flush();
    button('キャンセル').click();
    await many;

    const one = pickFile({});
    await flush();
    expect(button('選択')).toBeTruthy();
    button('キャンセル').click();
    await expect(one).resolves.toBeNull();
  });
});

describe('なぞって選ぶ', () => {
  const ROW_PX = 44;
  const LIST_TOP = 100;
  const chooseButton = () => dialog().querySelector('.drive-picker-choose');
  const pressed = () =>
    items()
      .filter((node) => node.getAttribute('aria-pressed') === 'true')
      .map((node) => node.querySelector('.drive-picker-name').textContent);

  /**
   * 行を縦に並べる（jsdom は配置を計算しないので、位置を決めてやる）。一覧の
   * 見えている高さは rowsVisible 行分で、scrollTop で送れる。
   */
  function layOut(rowsVisible = 20) {
    const body = dialog().querySelector('.drive-picker-body');
    let scrollTop = 0;
    Object.defineProperty(body, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        const max = Math.max(0, items().length - rowsVisible) * ROW_PX;
        const next = Math.min(max, Math.max(0, value));
        if (next === scrollTop) return;
        scrollTop = next;
        body.dispatchEvent(new Event('scroll')); // ブラウザと同じく、送ったら知らせる
      },
    });
    body.getBoundingClientRect = () => ({ top: LIST_TOP, bottom: LIST_TOP + rowsVisible * ROW_PX });
    items().forEach((row, index) => {
      row.getBoundingClientRect = () => ({ top: LIST_TOP + index * ROW_PX - scrollTop });
    });
  }
  /** index 行目の真ん中の高さ。 */
  const rowY = (index) => LIST_TOP + index * ROW_PX + ROW_PX / 2;

  /** jsdom には PointerEvent が無いので、MouseEvent に指の印を足して送る。 */
  function pointer(target, type, { x = 20, y, kind = 'touch', id = 1, buttons }) {
    const pressing = type === 'pointerdown' || type === 'pointermove';
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      buttons: buttons ?? (pressing ? 1 : 0),
    });
    Object.defineProperties(event, {
      pointerId: { value: id },
      pointerType: { value: kind },
      isPrimary: { value: id === 1 }, // 2 本目の指は primary ではない
    });
    target.dispatchEvent(event);
  }
  /** 指やマウスを離したあとにブラウザが送る click（detail は押した回数）。 */
  const phantomClick = (target) =>
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  const check = (name) => itemNamed(name).querySelector('.drive-picker-check');
  const nameOf = (name) => itemNamed(name).querySelector('.drive-picker-name');

  const five = {
    'my-drive': {
      items: [
        pdf('p1', '1.pdf'),
        pdf('p2', '2.pdf'),
        folder('d1', 'フォルダ'),
        pdf('p3', '3.pdf'),
        pdf('p4', '4.pdf'),
      ],
    },
  };

  it('丸を下へなぞると通った行がまとめて選ばれ、戻ると外れる（フォルダは飛ばす）', async () => {
    respond(five);
    const picking = pickFiles({ mimeTypes: PDF_MIME });
    await flush();
    layOut();
    expect(dialog().querySelector('.drive-picker-hint').hidden).toBe(false);

    pointer(check('1.pdf'), 'pointerdown', { y: rowY(0) });
    pointer(check('1.pdf'), 'pointermove', { y: rowY(0) + 12 });
    expect(pressed()).toEqual(['1.pdf']);
    pointer(check('1.pdf'), 'pointermove', { y: rowY(4) });
    expect(pressed()).toEqual(['1.pdf', '2.pdf', '3.pdf', '4.pdf']);
    expect(itemNamed('フォルダ').hasAttribute('aria-pressed')).toBe(false);
    expect(chooseButton().textContent).toBe('選択（4 個）');
    // 行き過ぎて戻れば、通り過ぎた行は元に戻る。
    pointer(check('1.pdf'), 'pointermove', { y: rowY(1) });
    expect(pressed()).toEqual(['1.pdf', '2.pdf']);
    pointer(check('1.pdf'), 'pointerup', { y: rowY(1) });

    chooseButton().click();
    await expect(picking).resolves.toEqual([
      { id: 'p1', name: '1.pdf', mimeType: PDF_MIME, modifiedTime: MODIFIED },
      { id: 'p2', name: '2.pdf', mimeType: PDF_MIME, modifiedTime: MODIFIED },
    ]);
  });

  it('上へなぞってもよく、選んだ順はなぞった順', async () => {
    respond(five);
    const picking = pickFiles({});
    await flush();
    layOut();

    pointer(check('4.pdf'), 'pointerdown', { y: rowY(4) });
    pointer(check('4.pdf'), 'pointermove', { y: rowY(1) });
    pointer(check('4.pdf'), 'pointerup', { y: rowY(1) });

    chooseButton().click();
    expect((await picking).map(({ id }) => id)).toEqual(['p4', 'p3', 'p2']);
  });

  it('選んである行からなぞり始めると、通った行を外す', async () => {
    respond(five);
    const picking = pickFiles({});
    await flush();
    layOut();
    ['1.pdf', '2.pdf', '4.pdf'].forEach((name) => itemNamed(name).click());

    pointer(check('2.pdf'), 'pointerdown', { y: rowY(1) });
    pointer(check('2.pdf'), 'pointermove', { y: rowY(3) });
    pointer(check('2.pdf'), 'pointerup', { y: rowY(3) });
    expect(pressed()).toEqual(['1.pdf', '4.pdf']);

    button('キャンセル').click();
    await picking;
  });

  it('丸の外は、横に動かし始めればなぞって選び、縦に動かし始めればスクロールに任せる', async () => {
    respond(five);
    const picking = pickFiles({});
    await flush();
    layOut();

    // 縦に動かし始めた（一覧のスクロール）。
    pointer(nameOf('1.pdf'), 'pointerdown', { x: 100, y: rowY(0) });
    pointer(nameOf('1.pdf'), 'pointermove', { x: 102, y: rowY(0) + 20 });
    pointer(nameOf('1.pdf'), 'pointermove', { x: 102, y: rowY(3) });
    pointer(nameOf('1.pdf'), 'pointercancel', { x: 102, y: rowY(3) });
    expect(pressed()).toEqual([]);

    // 横に動かし始めてから縦へ。
    pointer(nameOf('2.pdf'), 'pointerdown', { x: 100, y: rowY(1) });
    pointer(nameOf('2.pdf'), 'pointermove', { x: 120, y: rowY(1) + 2 });
    pointer(nameOf('2.pdf'), 'pointermove', { x: 120, y: rowY(3) });
    pointer(nameOf('2.pdf'), 'pointerup', { x: 120, y: rowY(3) });
    expect(pressed()).toEqual(['2.pdf', '3.pdf']);

    button('キャンセル').click();
    await picking;
  });

  it('マウスはどの向きでもなぞれ、なぞり終えた行の click では切り替えない', async () => {
    respond(five);
    const picking = pickFiles({});
    await flush();
    layOut();

    pointer(nameOf('1.pdf'), 'pointerdown', { x: 100, y: rowY(0), kind: 'mouse' });
    pointer(nameOf('1.pdf'), 'pointermove', { x: 100, y: rowY(1), kind: 'mouse' });
    pointer(nameOf('2.pdf'), 'pointerup', { x: 100, y: rowY(1), kind: 'mouse' });
    phantomClick(itemNamed('2.pdf'));
    expect(pressed()).toEqual(['1.pdf', '2.pdf']);

    // その次の click は、いつも通り切り替える。
    await flush();
    itemNamed('2.pdf').click();
    expect(pressed()).toEqual(['1.pdf']);

    button('キャンセル').click();
    await picking;
  });

  it('一覧の下端まで来たら一覧を送り、送った先の行も選ぶ', async () => {
    respond(five);
    const picking = pickFiles({});
    await flush();
    layOut(2); // 2 行分しか見えていない

    pointer(check('1.pdf'), 'pointerdown', { y: rowY(0) });
    pointer(check('1.pdf'), 'pointermove', { y: LIST_TOP + 2 * ROW_PX - 1 });
    await vi.waitFor(() => expect(pressed()).toContain('4.pdf'));
    expect(dialog().querySelector('.drive-picker-body').scrollTop).toBeGreaterThan(0);
    pointer(check('1.pdf'), 'pointerup', { y: LIST_TOP + 2 * ROW_PX - 1 });

    button('キャンセル').click();
    await picking;
  });

  it('一覧の上端まで来たら、上へも送る', async () => {
    respond(five);
    const picking = pickFiles({});
    await flush();
    layOut(2);
    const body = dialog().querySelector('.drive-picker-body');
    body.scrollTop = 3 * ROW_PX; // 4.pdf と、その上のフォルダが見えている

    pointer(check('4.pdf'), 'pointerdown', { y: LIST_TOP + ROW_PX + ROW_PX / 2 });
    pointer(check('4.pdf'), 'pointermove', { y: LIST_TOP + 1 });
    await vi.waitFor(() => expect(body.scrollTop).toBe(0));
    pointer(check('4.pdf'), 'pointerup', { y: LIST_TOP + 1 });
    await flush();
    expect(pressed()).toEqual(['1.pdf', '2.pdf', '3.pdf', '4.pdf']);

    button('キャンセル').click();
    await picking;
  });

  it('端の行から反対へなぞり始めても、一覧は送らない', async () => {
    respond(five);
    const picking = pickFiles({});
    await flush();
    layOut(2); // 1.pdf と 2.pdf が見えている
    const body = dialog().querySelector('.drive-picker-body');

    // 下端の行（2.pdf）から上へ。指はまだ下端の幅の中にいる。
    pointer(check('2.pdf'), 'pointerdown', { y: rowY(1) });
    pointer(check('2.pdf'), 'pointermove', { y: rowY(1) - 12 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(body.scrollTop).toBe(0);
    expect(pressed()).toEqual(['2.pdf']);
    pointer(check('2.pdf'), 'pointermove', { y: rowY(0) });
    pointer(check('2.pdf'), 'pointerup', { y: rowY(0) });
    await flush();
    expect(pressed()).toEqual(['1.pdf', '2.pdf']);

    button('キャンセル').click();
    await picking;
  });

  it('少し動いただけ・フォルダの上・2 本目の指では、なぞり始めない', async () => {
    respond(five);
    const picking = pickFiles({});
    await flush();
    layOut();

    // タップの揺れ。
    pointer(check('1.pdf'), 'pointerdown', { y: rowY(0) });
    pointer(check('1.pdf'), 'pointermove', { y: rowY(0) + 3 });
    pointer(check('1.pdf'), 'pointerup', { y: rowY(0) + 3 });
    expect(pressed()).toEqual([]);

    // フォルダの上から。
    pointer(itemNamed('フォルダ'), 'pointerdown', { y: rowY(2) });
    pointer(itemNamed('フォルダ'), 'pointermove', { y: rowY(4) });
    pointer(itemNamed('フォルダ'), 'pointerup', { y: rowY(4) });
    expect(pressed()).toEqual([]);

    // 1 本目でなぞっている間の、2 本目の指は無視する。
    pointer(check('1.pdf'), 'pointerdown', { y: rowY(0) });
    pointer(check('3.pdf'), 'pointerdown', { y: rowY(3), id: 2 });
    pointer(check('1.pdf'), 'pointermove', { y: rowY(1) });
    pointer(check('3.pdf'), 'pointermove', { y: rowY(4), id: 2 });
    pointer(check('3.pdf'), 'pointerup', { y: rowY(4), id: 2 });
    pointer(check('3.pdf'), 'pointercancel', { y: rowY(4), id: 2 });
    expect(pressed()).toEqual(['1.pdf', '2.pdf']);
    // 1 本目はまだなぞっている。
    pointer(check('1.pdf'), 'pointermove', { y: rowY(3) });
    expect(pressed()).toEqual(['1.pdf', '2.pdf', '3.pdf']);
    pointer(check('1.pdf'), 'pointercancel', { y: rowY(3) });
    // 離れた後の動きでは変わらない。
    pointer(check('1.pdf'), 'pointermove', { y: rowY(4) });
    expect(pressed()).toEqual(['1.pdf', '2.pdf', '3.pdf']);

    button('キャンセル').click();
    await picking;
  });

  it('指でなぞったあとの click は呑まない（支援技術の click も受ける）', async () => {
    respond(five);
    const picking = pickFiles({});
    await flush();
    layOut();

    pointer(check('1.pdf'), 'pointerdown', { y: rowY(0) });
    pointer(check('1.pdf'), 'pointermove', { y: rowY(1) });
    pointer(check('1.pdf'), 'pointerup', { y: rowY(1) }); // 動いたタッチは click にならない
    // pointerdown を伴わない click（VoiceOver などの支援技術）。
    phantomClick(nameOf('4.pdf'));
    expect(pressed()).toEqual(['1.pdf', '2.pdf', '4.pdf']);

    button('キャンセル').click();
    await picking;
  });

  it('マウスのボタンを一覧の外で離したら、そのあと動かしても選ばない', async () => {
    respond(five);
    const picking = pickFiles({});
    await flush();
    layOut();

    pointer(nameOf('1.pdf'), 'pointerdown', { x: 100, y: rowY(0), kind: 'mouse' });
    // 一覧の外（ダイアログの余白）で離した。
    pointer(dialog(), 'pointerup', { x: 100, y: LIST_TOP - 10, kind: 'mouse' });
    pointer(nameOf('2.pdf'), 'pointermove', { x: 100, y: rowY(3), kind: 'mouse', buttons: 0 });
    expect(pressed()).toEqual([]);
    // ウィンドウの外で離した（pointerup はどこにも届かない）。
    pointer(nameOf('1.pdf'), 'pointerdown', { x: 100, y: rowY(0), kind: 'mouse' });
    pointer(nameOf('2.pdf'), 'pointermove', { x: 100, y: rowY(3), kind: 'mouse', buttons: 0 });
    expect(pressed()).toEqual([]);
    // 次に押せば、また普通になぞれる。
    pointer(nameOf('2.pdf'), 'pointerdown', { x: 100, y: rowY(1), kind: 'mouse' });
    pointer(nameOf('2.pdf'), 'pointermove', { x: 100, y: rowY(3), kind: 'mouse' });
    pointer(nameOf('3.pdf'), 'pointerup', { x: 100, y: rowY(3), kind: 'mouse' });
    expect(pressed()).toEqual(['2.pdf', '3.pdf']);

    button('キャンセル').click();
    await picking;
  });

  it('一覧の上へ指が出ても、送ってあって見えていない行までは一度に選ばない', async () => {
    respond(five);
    const picking = pickFiles({});
    await flush();
    layOut(2);
    dialog().querySelector('.drive-picker-body').scrollTop = 3 * ROW_PX; // 3.pdf と 4.pdf が見えている

    pointer(check('4.pdf'), 'pointerdown', { y: LIST_TOP + ROW_PX + ROW_PX / 2 });
    pointer(check('4.pdf'), 'pointermove', { y: LIST_TOP - 100 }); // パンくずの辺り
    // 自動送りで見せる前は、見えている行だけ。
    expect(pressed()).toEqual(['3.pdf', '4.pdf']);
    pointer(check('4.pdf'), 'pointerup', { y: LIST_TOP - 100 });

    button('キャンセル').click();
    await picking;
  });

  it('マウスでなぞったあとの click が届かなくても、次に押した行は切り替わる', async () => {
    respond(five);
    const picking = pickFiles({});
    await flush();
    layOut();

    pointer(nameOf('1.pdf'), 'pointerdown', { x: 100, y: rowY(0), kind: 'mouse' });
    pointer(nameOf('1.pdf'), 'pointermove', { x: 100, y: rowY(1), kind: 'mouse' });
    pointer(nameOf('2.pdf'), 'pointerup', { x: 100, y: rowY(1), kind: 'mouse' }); // click は来ない
    pointer(nameOf('4.pdf'), 'pointerdown', { x: 100, y: rowY(4), kind: 'mouse' });
    pointer(nameOf('4.pdf'), 'pointerup', { x: 100, y: rowY(4), kind: 'mouse' });
    phantomClick(nameOf('4.pdf'));
    expect(pressed()).toEqual(['1.pdf', '2.pdf', '4.pdf']);

    button('キャンセル').click();
    await picking;
  });

  it('離したのを取り逃しても、次に押した行からなぞり直す', async () => {
    respond(five);
    const picking = pickFiles({});
    await flush();
    layOut();

    // 1.pdf を押したあと、離したことが届かなかった。
    pointer(nameOf('1.pdf'), 'pointerdown', { x: 100, y: rowY(0), kind: 'mouse' });
    pointer(nameOf('3.pdf'), 'pointerdown', { x: 100, y: rowY(3), kind: 'mouse' });
    pointer(nameOf('3.pdf'), 'pointermove', { x: 100, y: rowY(4), kind: 'mouse' });
    pointer(nameOf('4.pdf'), 'pointerup', { x: 100, y: rowY(4), kind: 'mouse' });
    expect(pressed()).toEqual(['3.pdf', '4.pdf']);

    button('キャンセル').click();
    await picking;
  });

  it('なぞっている最中にホイールで送っても、指の下を通った行を選ぶ', async () => {
    respond(five);
    const picking = pickFiles({});
    await flush();
    layOut(3); // 1.pdf・2.pdf・フォルダが見えている

    pointer(nameOf('1.pdf'), 'pointerdown', { x: 100, y: rowY(0), kind: 'mouse' });
    pointer(nameOf('1.pdf'), 'pointermove', { x: 100, y: rowY(1), kind: 'mouse' });
    expect(pressed()).toEqual(['1.pdf', '2.pdf']);
    // マウスは動かさずに、2 行分送る。
    dialog().querySelector('.drive-picker-body').scrollTop = 2 * ROW_PX;
    expect(pressed()).toEqual(['1.pdf', '2.pdf', '3.pdf']);
    pointer(nameOf('2.pdf'), 'pointerup', { x: 100, y: rowY(1), kind: 'mouse' });

    button('キャンセル').click();
    await picking;
  });

  it('端の行から離れたあと端へ戻れば、その端でも送る', async () => {
    respond(five);
    const picking = pickFiles({});
    await flush();
    layOut(2); // 1.pdf と 2.pdf が見えている
    const body = dialog().querySelector('.drive-picker-body');

    pointer(check('2.pdf'), 'pointerdown', { y: rowY(1) });
    pointer(check('2.pdf'), 'pointermove', { y: rowY(0) }); // 下端の帯の外へ
    // 押した所よりは上だが、下端の帯の中へ戻る。
    pointer(check('2.pdf'), 'pointermove', { y: rowY(1) - 6 });
    await vi.waitFor(() => expect(body.scrollTop).toBeGreaterThan(0));
    pointer(check('2.pdf'), 'pointerup', { y: rowY(1) - 6 });

    button('キャンセル').click();
    await picking;
  });

  it('端の帯にいないときは、自動送りのフレームを回さない', async () => {
    respond(five);
    const picking = pickFiles({});
    await flush();
    layOut();
    const frame = vi.spyOn(window, 'requestAnimationFrame');

    pointer(check('1.pdf'), 'pointerdown', { y: rowY(0) });
    pointer(check('1.pdf'), 'pointermove', { y: rowY(3) });
    pointer(check('1.pdf'), 'pointerup', { y: rowY(3) });
    expect(frame).not.toHaveBeenCalled();
    frame.mockRestore();

    button('キャンセル').click();
    await picking;
  });

  it('自動送りの速さは、画面のリフレッシュレートに依らない', async () => {
    respond(five);
    const picking = pickFiles({});
    await flush();
    layOut(1); // 1.pdf だけが見えている（4 行分送れる）
    const body = dialog().querySelector('.drive-picker-body');
    // フレームを手で進める。
    let pending = null;
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      pending = callback;
      return 1;
    });
    const caf = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const scrolledIn = (hz) => {
      body.scrollTop = 0;
      pointer(check('1.pdf'), 'pointerdown', { y: rowY(0) - 10 });
      pointer(check('1.pdf'), 'pointermove', { y: LIST_TOP + ROW_PX - 1 }); // 下端
      for (let frame = 0; frame <= hz / 10; frame++) pending((frame * 1000) / hz); // 0.1 秒分
      const distance = body.scrollTop;
      pointer(check('1.pdf'), 'pointerup', { y: LIST_TOP + ROW_PX - 1 });
      return distance;
    };

    const at60 = scrolledIn(60);
    const at120 = scrolledIn(120);
    // 1 秒に約 960px（端いっぱいの手前なので少し遅い）で、約 0.12 秒分。
    expect(at60).toBeGreaterThan(90);
    expect(Math.abs(at120 - at60)).toBeLessThanOrEqual(2);
    raf.mockRestore();
    caf.mockRestore();

    button('キャンセル').click();
    await picking;
  });

  it('端の帯から出たら、自動送りを止める', async () => {
    respond(five);
    const picking = pickFiles({});
    await flush();
    layOut(3); // 下端の帯は 2 行目の下半分から
    let pending = null;
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      pending = callback;
      return 1;
    });
    const caf = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    pointer(check('1.pdf'), 'pointerdown', { y: rowY(0) });
    pointer(check('1.pdf'), 'pointermove', { y: LIST_TOP + 3 * ROW_PX - 1 }); // 下端
    pending(0);
    pointer(check('1.pdf'), 'pointermove', { y: rowY(1) }); // 帯の外
    const next = pending;
    pending = null;
    next(16);
    expect(pending).toBeNull(); // 次のフレームを頼まない
    pointer(check('1.pdf'), 'pointerup', { y: rowY(1) });
    raf.mockRestore();
    caf.mockRestore();

    button('キャンセル').click();
    await picking;
  });

  it('なぞっている最中に読み足した行も、なぞって選べる', async () => {
    respond({
      'my-drive': { ...five['my-drive'], nextPageToken: 'n2' },
      'my-drive#n2': { items: [pdf('p5', '5.pdf')] },
    });
    const picking = pickFiles({});
    await flush();
    layOut();

    pointer(nameOf('1.pdf'), 'pointerdown', { x: 100, y: rowY(0), kind: 'mouse' });
    pointer(nameOf('1.pdf'), 'pointermove', { x: 100, y: rowY(1), kind: 'mouse' });
    button('さらに表示').click();
    await flush();
    layOut(); // 足した行にも位置を決める
    pointer(nameOf('2.pdf'), 'pointermove', { x: 100, y: rowY(5), kind: 'mouse' });
    pointer(nameOf('5.pdf'), 'pointerup', { x: 100, y: rowY(5), kind: 'mouse' });
    expect(pressed()).toEqual(['1.pdf', '2.pdf', '3.pdf', '4.pdf', '5.pdf']);

    button('キャンセル').click();
    await picking;
  });

  it('1 つ選ぶダイアログには丸も案内も出ない', async () => {
    respond(five);
    const picking = pickFile({});
    await flush();
    expect(dialog().querySelector('.drive-picker-check')).toBeNull();
    expect(dialog().querySelector('.drive-picker-hint').hidden).toBe(true);
    expect(dialog().classList.contains('multiple')).toBe(false);
    button('キャンセル').click();
    await picking;
  });
});
