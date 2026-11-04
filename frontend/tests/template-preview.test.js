// @vitest-environment jsdom
//
// 雛形のプレビュー（template-preview.js）。
//
// 雛形のファイル名を押すと、今の雛形の中身をポップアップで見せる。届くのは
// Google ドキュメントなら PDF、Excel ならシートの表（JSON）なので、その
// 見分けと、表の組み立て（結合・罫線・揃え）、閉じて開き直したときに前の
// 読み込みの結果を描かないことを固定する。

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/auth.js', () => ({ getSessionToken: async () => 'token' }));

const renderPdfPages = vi.fn();
vi.mock('../src/pdf-pages.js', () => ({
  renderPdfPages: (...args) => renderPdfPages(...args),
}));

const { buildSheet, connectTemplatePreview, openTemplatePreview } = await import(
  '../src/template-preview.js'
);

// jsdom の <dialog> には showModal / close が無い。開閉の印と close イベントだけを真似る。
HTMLDialogElement.prototype.showModal = function showModal() {
  this.open = true;
};
HTMLDialogElement.prototype.close = function close() {
  this.open = false;
  this.dispatchEvent(new Event('close'));
};

const URL = '/api/tools/excel-report-formatter/template/preview';

/** fetch が返す応答（届いた中身を Blob で読む）。 */
function response(body, type, status = 200) {
  return {
    ok: status < 400,
    status,
    blob: async () => new Blob([body], { type }),
    json: async () => JSON.parse(body),
  };
}

function stubFetch(...responses) {
  const fetchMock = vi.fn();
  responses.forEach((r) => fetchMock.mockResolvedValueOnce(r));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const dialog = () => document.getElementById('templatePreview');
const status = () => dialog().querySelector('.template-preview-status');
const body = () => dialog().querySelector('.template-preview-body');

const SHEET = {
  name: '報告書',
  cols: [64, 100],
  rows: [
    {
      h: 20,
      cells: [
        { v: '見出し', cs: 2, b: true, a: 'center', bd: 'trbl', bg: '#cce5ff', fs: 19 },
      ],
    },
    { h: 40, cells: [{ v: '<b>そのまま</b>', rs: 1, va: 'top', w: true }, { v: '12', a: 'right' }] },
  ],
  truncated: false,
};

beforeEach(() => {
  // 前のテストで開いたままのダイアログを閉じ、後ろのページの固定を戻してから片付ける。
  document.getElementById('templatePreview')?.close();
  document.body.innerHTML = '';
  document.body.removeAttribute('style');
  document.documentElement.removeAttribute('style');
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('シートの表', () => {
  it('列の幅・行の高さ・結合・書式を写す', () => {
    const section = buildSheet(document, SHEET);

    expect(section.querySelector('h4').textContent).toBe('報告書');
    const table = section.querySelector('table');
    expect(table.style.width).toBe('164px');
    expect([...table.querySelectorAll('col')].map((col) => col.style.width)).toEqual(['64px', '100px']);
    const rows = table.querySelectorAll('tr');
    expect(rows[0].style.height).toBe('20px');

    const heading = rows[0].querySelector('td');
    expect(heading.colSpan).toBe(2);
    expect(heading.style.fontWeight).toBe('700');
    expect(heading.style.textAlign).toBe('center');
    expect(heading.style.fontSize).toBe('19px');
    expect(heading.style.backgroundColor).toBe('rgb(204, 229, 255)');
    expect(heading.dataset.edges).toBe('trbl');
    expect(heading.hasAttribute('data-wrap')).toBe(false);

    const [text, number] = rows[1].querySelectorAll('td');
    // 雛形の中身は HTML として解釈しない。
    expect(text.textContent).toBe('<b>そのまま</b>');
    expect(text.querySelector('b')).toBeNull();
    expect(text.style.verticalAlign).toBe('top');
    expect(text.hasAttribute('data-wrap')).toBe(true);
    expect(number.style.textAlign).toBe('right');
    expect(number.hasAttribute('data-edges')).toBe(false);
    expect(section.querySelector('.hint')).toBeNull();
  });

  it('上限で切ったシートは、そのことを添える', () => {
    const section = buildSheet(document, { ...SHEET, truncated: true });

    expect(section.querySelector('.hint').textContent).toContain('一部だけ');
  });

  it('何も無いシートは、表の代わりにその旨を出す', () => {
    const section = buildSheet(document, { name: '空', cols: [], rows: [], truncated: false });

    expect(section.querySelector('table')).toBeNull();
    expect(section.querySelector('.hint').textContent).toContain('何も書かれていない');
  });
});

describe('プレビューを開く', () => {
  it('Excel の雛形はシートを表にして並べる', async () => {
    const fetchMock = stubFetch(
      response(JSON.stringify({ sheets: [SHEET, { ...SHEET, name: '控え' }] }), 'application/json')
    );

    await openTemplatePreview({ url: URL, fileName: '雛形.xlsx' });

    expect(fetchMock).toHaveBeenCalledWith(URL, { headers: { Authorization: 'Bearer token' } });
    expect(dialog().open).toBe(true);
    expect(dialog().querySelector('h3').textContent).toBe('雛形.xlsx');
    expect([...body().querySelectorAll('h4')].map((h) => h.textContent)).toEqual(['報告書', '控え']);
    expect(status().textContent).toContain('セルの値と罫線');
    expect(renderPdfPages).not.toHaveBeenCalled();
  });

  it('表示できるシートが無ければ、そう出す', async () => {
    stubFetch(response(JSON.stringify({ sheets: [] }), 'application/json'));

    await openTemplatePreview({ url: URL, fileName: '雛形.xlsx' });

    expect(status().textContent).toBe('表示できるシートがありません。');
    expect(body().children).toHaveLength(0);
  });

  it('Google ドキュメントの雛形は PDF の頁を描く', async () => {
    stubFetch(response('%PDF-1.7', 'application/pdf'));
    renderPdfPages.mockResolvedValue(1);

    await openTemplatePreview({ url: URL, fileName: '証明書 雛形' });

    expect(renderPdfPages).toHaveBeenCalledTimes(1);
    const [bytes, container, { stopped }] = renderPdfPages.mock.calls[0];
    expect(new TextDecoder().decode(bytes)).toBe('%PDF-1.7');
    expect(container).toBe(body());
    expect(status().textContent).toBe('');
    // 開いている間は描き続け、閉じたら残りの頁を描かない。
    expect(stopped()).toBe(false);
    dialog().close();
    expect(stopped()).toBe(true);
  });

  it('読み込めなければ、理由をダイアログの中に出す', async () => {
    stubFetch(response(JSON.stringify({ error: '雛形が未設定です。' }), 'application/json', 409));

    await openTemplatePreview({ url: URL, fileName: '雛形.xlsx' });

    expect(status().textContent).toBe('雛形が未設定です。');
    expect(status().classList.contains('dialog-error')).toBe(true);
  });

  it('開き直すと前の中身と失敗の表示を消し、ダイアログは使い回す', async () => {
    stubFetch(
      response(JSON.stringify({ error: '失敗' }), 'application/json', 500),
      response(JSON.stringify({ sheets: [SHEET] }), 'application/json')
    );

    await openTemplatePreview({ url: URL, fileName: '一度目' });
    await openTemplatePreview({ url: URL, fileName: '二度目' });

    expect(document.querySelectorAll('#templatePreview')).toHaveLength(1);
    expect(dialog().querySelector('h3').textContent).toBe('二度目');
    expect(status().classList.contains('dialog-error')).toBe(false);
    expect(body().querySelectorAll('section')).toHaveLength(1);
  });

  it('閉じるボタンで閉じ、中身を捨てる', async () => {
    stubFetch(response(JSON.stringify({ sheets: [SHEET] }), 'application/json'));
    await openTemplatePreview({ url: URL, fileName: '雛形.xlsx' });

    dialog().querySelector('.template-preview-close').click();

    expect(dialog().open).toBe(false);
    expect(body().children).toHaveLength(0);
  });

  it.each([
    ['表', response(JSON.stringify({ sheets: [SHEET] }), 'application/json')],
    ['PDF', response('%PDF-1.7', 'application/pdf')],
    ['失敗', response(JSON.stringify({ error: '失敗' }), 'application/json', 500)],
  ])('届く前に閉じたら、届いた%sを描かない', async (_, late) => {
    let deliver;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise((resolve) => (deliver = resolve)))
    );

    const opening = openTemplatePreview({ url: URL, fileName: '雛形.xlsx' });
    await vi.waitFor(() => expect(deliver).toBeTypeOf('function'));
    dialog().close();
    deliver(late);
    await opening;

    expect(body().children).toHaveLength(0);
    expect(status().textContent).toBe('雛形を読み込んでいます…');
    expect(renderPdfPages).not.toHaveBeenCalled();
  });

  it('PDF を読み終える前に開き直したら、前の PDF は描かず、読み込み中の表示も消さない', async () => {
    let first;
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      blob: async () => ({
        type: 'application/pdf',
        arrayBuffer: () => new Promise((resolve) => (first = resolve)),
      }),
    });
    let second;
    fetchMock.mockReturnValueOnce(new Promise((resolve) => (second = resolve)));
    vi.stubGlobal('fetch', fetchMock);

    const opening = openTemplatePreview({ url: URL, fileName: '一度目' });
    await vi.waitFor(() => expect(first).toBeTypeOf('function'));
    const reopening = openTemplatePreview({ url: URL, fileName: '二度目' });
    first(new ArrayBuffer(4));
    await opening;

    expect(status().textContent).toBe('雛形を読み込んでいます…');
    expect(renderPdfPages).not.toHaveBeenCalled();
    second(response(JSON.stringify({ sheets: [] }), 'application/json'));
    await reopening;
  });

  it('開いている間は後ろのページを固定し、閉じたら戻す', async () => {
    stubFetch(
      response(JSON.stringify({ sheets: [] }), 'application/json'),
      response(JSON.stringify({ sheets: [] }), 'application/json')
    );
    document.body.style.overflow = 'scroll';

    await openTemplatePreview({ url: URL, fileName: '雛形.xlsx' });
    await openTemplatePreview({ url: URL, fileName: '雛形.xlsx' });
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.documentElement.style.overflow).toBe('hidden');

    dialog().close();
    expect(document.body.style.overflow).toBe('scroll');
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('表を読み終える前に開き直したら、前の表は描かない', async () => {
    let first;
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      blob: async () => ({
        type: 'application/json',
        text: () => new Promise((resolve) => (first = resolve)),
      }),
    });
    fetchMock.mockResolvedValueOnce(response(JSON.stringify({ sheets: [] }), 'application/json'));
    vi.stubGlobal('fetch', fetchMock);

    const opening = openTemplatePreview({ url: URL, fileName: '一度目' });
    await vi.waitFor(() => expect(first).toBeTypeOf('function'));
    await openTemplatePreview({ url: URL, fileName: '二度目' });
    first(JSON.stringify({ sheets: [SHEET] }));
    await opening;

    expect(body().children).toHaveLength(0);
    expect(status().textContent).toBe('表示できるシートがありません。');
  });
});

describe('ファイル名のボタン', () => {
  it('押すと、ボタンに出ているファイル名でプレビューを開く', async () => {
    stubFetch(response(JSON.stringify({ sheets: [] }), 'application/json'));
    document.body.innerHTML = '<button id="templateName">IP_230901_11.xlsx</button>';
    const button = document.getElementById('templateName');
    connectTemplatePreview(button, URL);

    button.click();

    await vi.waitFor(() => expect(status().textContent).toBe('表示できるシートがありません。'));
    expect(dialog().querySelector('h3').textContent).toBe('IP_230901_11.xlsx');
  });
});
