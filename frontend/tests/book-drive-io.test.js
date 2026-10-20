// 書籍スキャン PDF 結合ツールの、Drive の PDF の読み込み。
//
// サーバーには PDF か確かめてもらい、読み取り専用のトークンを受け取るだけで、
// 中身は画面が Drive から直接読む（src/pdf-book-merger/drive-download.js）。
// Cloud Run・Hosting の転送量を使わないため。結合した PDF はダウンロード
// するだけなので、Drive へ書くものは無い。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.fn();
vi.mock('../src/api.js', () => ({
  apiGet: (...args) => apiGet(...args),
}));

const { downloadDriveFile } = await import('../src/pdf-book-merger/drive-download.js');

const DATA = Uint8Array.from({ length: 25 }, (_, i) => i);
const DRIVE = 'https://www.googleapis.com/drive/v3/files';

/** 何回かに分けて届く本文（cut の位置で切れる）。 */
function body(bytes, { pieces = 3, cutAt = null } = {}) {
  const step = Math.ceil(bytes.length / pieces);
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (cutAt !== null && at >= cutAt) {
        controller.error(new TypeError('network error'));
        return;
      }
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(bytes.length, at + step, cutAt ?? Infinity);
      controller.enqueue(bytes.slice(at, end));
      at = end;
    },
  });
}

let fetchMock;

beforeEach(() => {
  apiGet.mockReset();
  apiGet.mockResolvedValue({ id: 'scan/1', name: 'a.pdf', size: DATA.length, accessToken: 'tok-1', expiresAt: null });
  fetchMock = vi.fn(async () => new Response(body(DATA), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('downloadDriveFile', () => {
  it('サーバーからトークンを受け取り、Drive から直接読む（中身はサーバーを通さない）', async () => {
    const progress = [];

    const bytes = await downloadDriveFile(
      { id: 'scan/1', name: 'a.pdf' },
      { onProgress: (received, total) => progress.push([received, total]) }
    );

    expect([...bytes]).toEqual([...DATA]);
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(apiGet).toHaveBeenCalledWith('/api/tools/pdf-book-merger/files/scan%2F1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${DRIVE}/scan%2F1?alt=media&supportsAllDrives=true`);
    expect(init.headers).toEqual({ Authorization: 'Bearer tok-1' });
    // 残さない・Cookie を送らない・どこから来たかを知らせない。
    expect(init).toMatchObject({ cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.at(-1)).toEqual([25, 25]);
  });

  it('途中で切れたら、続きから読み直す', async () => {
    fetchMock
      .mockImplementationOnce(async () => new Response(body(DATA, { pieces: 5, cutAt: 10 }), { status: 200 }))
      .mockImplementationOnce(async () => new Response(body(DATA.slice(10)), { status: 206 }));

    const bytes = await downloadDriveFile({ id: 'f', name: 'a.pdf' });

    expect([...bytes]).toEqual([...DATA]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers).toEqual({ Authorization: 'Bearer tok-1', Range: 'bytes=10-' });
  });

  it('続きを頼んでも頭から返ってきたら、頭から書き直す', async () => {
    fetchMock
      .mockImplementationOnce(async () => new Response(body(DATA, { pieces: 5, cutAt: 10 }), { status: 200 }))
      .mockImplementationOnce(async () => new Response(body(DATA), { status: 200 }));

    const bytes = await downloadDriveFile({ id: 'f', name: 'a.pdf' });

    expect([...bytes]).toEqual([...DATA]);
  });

  it('トークンが切れていたら、取り直して読む', async () => {
    apiGet
      .mockResolvedValueOnce({ id: 'f', name: 'a.pdf', size: DATA.length, accessToken: 'old' })
      .mockResolvedValueOnce({ id: 'f', name: 'a.pdf', size: DATA.length, accessToken: 'new' });
    fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 401 }));

    const bytes = await downloadDriveFile({ id: 'f', name: 'a.pdf' });

    expect([...bytes]).toEqual([...DATA]);
    expect(fetchMock.mock.calls.map(([, init]) => init.headers.Authorization)).toEqual(['Bearer old', 'Bearer new']);
  });

  it('権限が無いなど、読み直しても同じ失敗は、Drive の理由を添えてすぐ止める', async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ error: { message: 'The user does not have sufficient permissions' } }), { status: 403 })
    );

    await expect(downloadDriveFile({ id: 'f', name: 'a.pdf' })).rejects.toThrow(
      '「a.pdf」を Drive から読み込めませんでした（HTTP 403: The user does not have sufficient permissions）。'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('読み直しても切れるなら、あきらめる', async () => {
    fetchMock.mockImplementation(async () => new Response(body(DATA, { cutAt: 0 }), { status: 200 }));

    await expect(downloadDriveFile({ id: 'f', name: 'a.pdf' })).rejects.toThrow('network error');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('聞いた大きさより多く届いたら、読めなかったことにする', async () => {
    apiGet.mockResolvedValue({ id: 'f', name: 'a.pdf', size: 10, accessToken: 'tok' });

    await expect(downloadDriveFile({ id: 'f', name: 'a.pdf' })).rejects.toThrow('読み込んだ大きさが合いません。');
  });

  it('PDF でない・ゴミ箱にあるなど、サーバーが断った理由を出す（トークンは無いので Drive は読まない）', async () => {
    apiGet.mockRejectedValue(new Error('PDF ファイルではありません。'));

    await expect(downloadDriveFile({ id: 'f', name: 'memo.txt' })).rejects.toThrow(
      '「memo.txt」を Drive から読み込めませんでした（PDF ファイルではありません。）。'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
