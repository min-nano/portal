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

const { downloadDriveFile: download } = await import('../src/pdf-book-merger/drive-download.js');

/** 待たずに読み直す（待つ時間は記録する）。 */
const waited = [];
const downloadDriveFile = (file, options = {}) =>
  download(file, {
    delay: (attempt) => {
      waited.push(attempt);
      return 0;
    },
    ...options,
  });

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
  waited.length = 0;
  apiGet.mockReset();
  apiGet.mockResolvedValue({ id: 'scan/1', name: 'a.pdf', size: DATA.length, accessToken: 'tok-1', expiresAt: null });
  fetchMock = vi.fn(async () => new Response(body(DATA), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

  it('流量制限の理由は、errors のどこにあっても、details や status にあっても読み取る', async () => {
    const limited = (error) => new Response(JSON.stringify({ error }), { status: 403 });
    fetchMock
      .mockImplementationOnce(async () => limited({ errors: [{ reason: 'forbidden' }, { reason: 'userRateLimitExceeded' }] }))
      .mockImplementationOnce(async () => limited({ details: [{ reason: 'RATE_LIMIT_EXCEEDED' }] }))
      .mockImplementationOnce(async () => limited({ status: 'RESOURCE_EXHAUSTED' }));

    const bytes = await downloadDriveFile({ id: 'f', name: 'a.pdf' });

    expect([...bytes]).toEqual([...DATA]);
    expect(waited).toEqual([0, 1, 2]);
  });

  it('Retry-After があれば、その間は待つ', async () => {
    const pauses = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms) => {
      pauses.push(ms);
      callback();
      return 0;
    });
    fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 429, headers: { 'Retry-After': '30' } }));

    const bytes = await download({ id: 'f', name: 'a.pdf' });

    expect([...bytes]).toEqual([...DATA]);
    expect(pauses).toContain(30000);
  });

  it('トークンを取り直すときの一時的な失敗も、待ってやり直す', async () => {
    apiGet
      .mockResolvedValueOnce({ id: 'f', name: 'a.pdf', size: DATA.length, accessToken: 'old' })
      .mockRejectedValueOnce(Object.assign(new Error('サーバーエラーが発生しました (HTTP 503)。'), { status: 503 }))
      .mockResolvedValueOnce({ id: 'f', name: 'a.pdf', size: DATA.length, accessToken: 'new' });
    fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 401 }));

    const bytes = await downloadDriveFile({ id: 'f', name: 'a.pdf' });

    expect([...bytes]).toEqual([...DATA]);
    expect(waited).toEqual([0]);
    expect(fetchMock.mock.calls.at(-1)[1].headers.Authorization).toBe('Bearer new');
  });

  it('続きから読んだら、読み終えたあとに同じ版か確かめ、違えば始めから読み直す', async () => {
    const NEW = Uint8Array.from({ length: 30 }, (_, i) => 100 + i);
    apiGet
      .mockResolvedValueOnce({ id: 'f', name: 'a.pdf', size: DATA.length, accessToken: 'tok', revision: 'r1' })
      .mockResolvedValueOnce({ id: 'f', name: 'a.pdf', size: NEW.length, accessToken: 'tok', revision: 'r2' })
      .mockResolvedValueOnce({ id: 'f', name: 'a.pdf', size: NEW.length, accessToken: 'tok', revision: 'r2' });
    fetchMock
      .mockImplementationOnce(async () => new Response(body(DATA, { pieces: 5, cutAt: 10 }), { status: 200 }))
      .mockImplementationOnce(async () => new Response(body(DATA.slice(10)), { status: 206 }))
      .mockImplementationOnce(async () => new Response(body(NEW), { status: 200 }));

    const bytes = await downloadDriveFile({ id: 'f', name: 'a.pdf' });

    // 差し替えられたあとの版を、始めから読んだもの（古い版の前半とつながない）。
    expect([...bytes]).toEqual([...NEW]);
    expect(fetchMock.mock.calls[2][1].headers.Range).toBeUndefined();
  });

  it('トークンを取り直したら版が変わっていたときも、始めから読み直す。何度も変わるならあきらめる', async () => {
    apiGet
      .mockResolvedValueOnce({ id: 'f', name: 'a.pdf', size: DATA.length, accessToken: 'tok', revision: 'r1' })
      .mockResolvedValueOnce({ id: 'f', name: 'a.pdf', size: DATA.length, accessToken: 'tok', revision: 'r2' })
      .mockResolvedValueOnce({ id: 'f', name: 'a.pdf', size: DATA.length, accessToken: 'tok', revision: 'r3' });
    fetchMock.mockImplementation(async () => new Response('{}', { status: 401 }));

    await expect(downloadDriveFile({ id: 'f', name: 'a.pdf' })).rejects.toThrow('Drive のファイルが差し替えられました');
  });

  it('続きから読まずに 1 度で読めたときは、版を聞き直さない', async () => {
    await downloadDriveFile({ id: 'f', name: 'a.pdf' });

    expect(apiGet).toHaveBeenCalledTimes(1);
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

  it('読み直しても切れるなら、間を空けて 4 回読み直してから、あきらめる', async () => {
    fetchMock.mockImplementation(async () => new Response(body(DATA, { cutAt: 0 }), { status: 200 }));

    await expect(downloadDriveFile({ id: 'f', name: 'a.pdf' })).rejects.toThrow('network error');
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(waited).toEqual([0, 1, 2, 3]);
  });

  it('待つ時間は、回ごとに倍にする（1, 2, 4, 8 秒）', async () => {
    const delays = [];
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(async () => new Response('{}', { status: 503 }));
      const reading = download({ id: 'f', name: 'a.pdf' }).catch((error) => error);
      for (let i = 0; i < 4; i++) {
        await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
        delays.push(vi.getTimerCount() && Math.round((await nextTimer()) / 1000));
      }
      expect(await reading).toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }
    expect(delays).toEqual([1, 2, 4, 8]);

    async function nextTimer() {
      const before = Date.now();
      await vi.runOnlyPendingTimersAsync();
      return Date.now() - before;
    }
  });

  it('流量を絞られたら（429・403 の rateLimitExceeded）、待ってから読み直す', async () => {
    const limited = (status, reason) =>
      new Response(JSON.stringify({ error: { message: 'Rate limit', errors: [{ reason }] } }), { status });
    fetchMock
      .mockImplementationOnce(async () => limited(429, 'rateLimitExceeded'))
      .mockImplementationOnce(async () => limited(403, 'userRateLimitExceeded'))
      .mockImplementationOnce(async () => limited(403, 'rateLimitExceeded'));

    const bytes = await downloadDriveFile({ id: 'f', name: 'a.pdf' });

    expect([...bytes]).toEqual([...DATA]);
    expect(waited).toEqual([0, 1, 2]);
  });

  it('トークンの取り直しは、読み直しの回数に数えない', async () => {
    let call = 0;
    fetchMock.mockImplementation(async () => {
      call++;
      // 切れる → 401 → 切れる → 切れる → 切れる → 401 → 読める
      if (call === 2 || call === 6) return new Response('{}', { status: 401 });
      if (call < 7) return new Response(body(DATA, { cutAt: 0 }), { status: 200 });
      return new Response(body(DATA), { status: 200 });
    });

    const bytes = await downloadDriveFile({ id: 'f', name: 'a.pdf' });

    expect([...bytes]).toEqual([...DATA]);
    expect(apiGet).toHaveBeenCalledTimes(3);
    expect(waited).toEqual([0, 1, 2, 3]);
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
