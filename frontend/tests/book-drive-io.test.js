// @vitest-environment jsdom
//
// 書籍スキャン PDF 結合ツールの、Drive との受け渡し（どちらもサーバーの中継）。
//
//   読む: PDF の大きさを聞き、8 MiB ずつの範囲に分けて頼む
//         （src/pdf-book-merger/drive-download.js）
//   書く: サーバーが作った再開可能なアップロードへ、切って順に送る
//         （src/pdf-book-merger/drive-upload.js）

import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.fn();
const apiGetBytes = vi.fn();
const apiSendJson = vi.fn();
const apiPostForm = vi.fn();
vi.mock('../src/api.js', () => ({
  apiGet: (...args) => apiGet(...args),
  apiGetBytes: (...args) => apiGetBytes(...args),
  apiSendJson: (...args) => apiSendJson(...args),
  apiPostForm: (...args) => apiPostForm(...args),
}));

const { downloadDriveFile } = await import('../src/pdf-book-merger/drive-download.js');
const { uploadToDrive } = await import('../src/pdf-book-merger/drive-upload.js');

beforeEach(() => {
  apiGet.mockReset();
  apiGetBytes.mockReset();
  apiSendJson.mockReset();
  apiPostForm.mockReset();
});

describe('downloadDriveFile', () => {
  const DATA = Uint8Array.from({ length: 25 }, (_, i) => i);

  /** サーバーの代役。頼まれた範囲を返す（fail に入れた範囲は、その回数だけ失敗する）。 */
  function serve({ size = DATA.length, chunkBytes = 10, fail = {} } = {}) {
    apiGet.mockResolvedValue({ id: 'scan/1', name: 'a.pdf', size, chunkBytes });
    apiGetBytes.mockImplementation(async (path) => {
      const url = new URL(path, 'https://portal.example');
      const start = Number(url.searchParams.get('start'));
      const end = Number(url.searchParams.get('end'));
      const key = `${start}-${end}`;
      if (fail[key] > 0) {
        fail[key]--;
        throw new Error('HTTP 503');
      }
      return DATA.slice(start, end + 1).buffer;
    });
  }

  it('大きさを聞き、範囲に分けて頼み、つないで返す', async () => {
    serve();
    const progress = [];

    const bytes = await downloadDriveFile(
      { id: 'scan/1', name: 'a.pdf' },
      { onProgress: (received, total) => progress.push([received, total]) }
    );

    expect([...bytes]).toEqual([...DATA]);
    expect(apiGet).toHaveBeenCalledWith('/api/tools/pdf-book-merger/files/scan%2F1');
    const asked = apiGetBytes.mock.calls.map(([path]) => path).sort();
    expect(asked).toEqual([
      '/api/tools/pdf-book-merger/files/scan%2F1/content?start=0&end=9',
      '/api/tools/pdf-book-merger/files/scan%2F1/content?start=10&end=19',
      '/api/tools/pdf-book-merger/files/scan%2F1/content?start=20&end=24',
    ]);
    expect(progress.at(-1)).toEqual([25, 25]);
  });

  it('失敗した範囲は頼み直す', async () => {
    serve({ fail: { '10-19': 2 } });

    const bytes = await downloadDriveFile({ id: 'f', name: 'a.pdf' });

    expect([...bytes]).toEqual([...DATA]);
    expect(apiGetBytes.mock.calls.filter(([path]) => path.endsWith('start=10&end=19'))).toHaveLength(3);
  });

  it('頼み直しても読めなければ、ファイル名と理由を添えて止める', async () => {
    serve({ fail: { '0-9': 5 } });

    await expect(downloadDriveFile({ id: 'f', name: 'a.pdf' })).rejects.toThrow(
      '「a.pdf」を Drive から読み込めませんでした（HTTP 503）。'
    );
  });

  it('返ってきた大きさが範囲と合わなければ、読めなかったことにする', async () => {
    serve();
    apiGetBytes.mockResolvedValue(new ArrayBuffer(3));

    await expect(downloadDriveFile({ id: 'f', name: 'a.pdf' })).rejects.toThrow('読み込んだ大きさが合いません。');
  });

  it('PDF でない・ゴミ箱にあるなど、サーバーが断った理由を出す', async () => {
    apiGet.mockRejectedValue(new Error('PDF ファイルではありません。'));

    await expect(downloadDriveFile({ id: 'f', name: 'memo.txt' })).rejects.toThrow(
      '「memo.txt」を Drive から読み込めませんでした（PDF ファイルではありません。）。'
    );
    expect(apiGetBytes).not.toHaveBeenCalled();
  });
});

describe('uploadToDrive', () => {
  const SESSION = { uploadId: 'upload-x', chunkBytes: 4, fileName: '本.pdf' };

  /** 送られたフォームを、読める形にして記録する。 */
  async function sent() {
    return Promise.all(
      apiPostForm.mock.calls.map(async ([path, form]) => ({
        path,
        offset: Number(form.get('offset')),
        total: Number(form.get('total')),
        uploadId: form.get('uploadId'),
        bytes: [...new Uint8Array(await form.get('chunk').arrayBuffer())],
      }))
    );
  }

  it('保存先を伝えて受け口を作り、決まった大きさに切って順に送る', async () => {
    apiSendJson.mockResolvedValue(SESSION);
    apiPostForm
      .mockResolvedValueOnce({ done: false, received: 4 })
      .mockResolvedValueOnce({ done: false, received: 8 })
      .mockResolvedValueOnce({ done: true, fileId: 'f1', fileName: '本.pdf', webViewLink: 'https://drive/f1' });
    const progress = [];

    const saved = await uploadToDrive(
      new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
      { folderId: 'folder', fileName: '本.pdf' },
      { onProgress: (s, t) => progress.push([s, t]) }
    );

    expect(saved.webViewLink).toBe('https://drive/f1');
    expect(apiSendJson).toHaveBeenCalledWith('/api/tools/pdf-book-merger/uploads', 'POST', {
      folderId: 'folder',
      fileName: '本.pdf',
      size: 10,
    });
    expect((await sent()).map(({ path, offset, total, uploadId, bytes }) => [path, offset, total, uploadId, bytes])).toEqual([
      ['/api/tools/pdf-book-merger/uploads/chunk', 0, 10, 'upload-x', [0, 1, 2, 3]],
      ['/api/tools/pdf-book-merger/uploads/chunk', 4, 10, 'upload-x', [4, 5, 6, 7]],
      ['/api/tools/pdf-book-merger/uploads/chunk', 8, 10, 'upload-x', [8, 9]],
    ]);
    expect(progress).toEqual([
      [4, 10],
      [8, 10],
      [10, 10],
    ]);
  });

  it('Drive が受け取った分の続きから送り直す', async () => {
    apiSendJson.mockResolvedValue(SESSION);
    apiPostForm
      .mockResolvedValueOnce({ done: false, received: 2 })
      .mockResolvedValueOnce({ done: true, fileId: 'f1' });

    await uploadToDrive(new Uint8Array([0, 1, 2, 3, 4, 5]), { folderId: 'f', fileName: 'x.pdf' });

    expect((await sent()).map((call) => [call.offset, call.bytes])).toEqual([
      [0, [0, 1, 2, 3]],
      [2, [2, 3, 4, 5]],
    ]);
  });

  it('送信の失敗は同じ位置から送り直し、続けば諦める', async () => {
    apiSendJson.mockResolvedValue(SESSION);
    apiPostForm
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ done: true, fileId: 'f1' });

    await uploadToDrive(new Uint8Array([1, 2]), { folderId: 'f', fileName: 'x.pdf' });
    expect((await sent()).map((call) => call.offset)).toEqual([0, 0]);

    apiPostForm.mockReset();
    apiPostForm.mockRejectedValue(new Error('サーバーエラー'));
    await expect(uploadToDrive(new Uint8Array([1, 2]), { folderId: 'f', fileName: 'x.pdf' })).rejects.toThrow(
      'サーバーエラー'
    );
    expect(apiPostForm).toHaveBeenCalledTimes(4);
  });

  it('1 バイトも進まないことが続けば諦める', async () => {
    apiSendJson.mockResolvedValue(SESSION);
    apiPostForm.mockResolvedValue({ done: false, received: 0 });

    await expect(uploadToDrive(new Uint8Array([1, 2, 3, 4, 5]), { folderId: 'f', fileName: 'x.pdf' })).rejects.toThrow(
      'Drive が続きを受け取りませんでした'
    );
    expect(apiPostForm).toHaveBeenCalledTimes(4);
  });
});
