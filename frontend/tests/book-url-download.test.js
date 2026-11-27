// PDF 結合ツールの、URL で指定された PDF の読み込み（src/pdf-book-merger/url-download.js）。
//
// 中身はサーバーを通さず、画面がその URL から直接読む。資格情報は送らない。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadUrlFile, nameFromUrl, parseUrls } from '../src/pdf-book-merger/url-download.js';

const DATA = Uint8Array.from({ length: 25 }, (_, i) => i);

/** 何回かに分けて届く本文（cutAt の位置で切れる）。 */
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
  fetchMock = vi.fn(
    async () => new Response(body(DATA), { status: 200, headers: { 'Content-Length': String(DATA.length) } })
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseUrls', () => {
  it('空白・改行で区切った http・https の URL を、入れた順に取り出す', () => {
    expect(parseUrls('  https://a.example/x.pdf\n\thttp://b.example/y.pdf  ', 'http:')).toEqual({
      urls: ['https://a.example/x.pdf', 'http://b.example/y.pdf'],
      bad: [],
      schemes: 'http・https',
    });
    expect(parseUrls('', 'http:')).toEqual({ urls: [], bad: [], schemes: 'http・https' });
  });

  it('https のページからは、http の URL も bad に入れる（ブラウザが読ませない）', () => {
    expect(parseUrls('http://a.example/x.pdf https://a.example/y.pdf', 'https:')).toEqual({
      urls: ['https://a.example/y.pdf'],
      bad: ['http://a.example/x.pdf'],
      schemes: 'https',
    });
  });

  it('URL でないもの・http・https 以外のものは bad に入れる', () => {
    expect(parseUrls('scan.pdf file:///tmp/a.pdf https://a.example/x.pdf', 'http:')).toEqual({
      urls: ['https://a.example/x.pdf'],
      bad: ['scan.pdf', 'file:///tmp/a.pdf'],
      schemes: 'http・https',
    });
  });
});

describe('nameFromUrl', () => {
  it('パスの最後の部分を、% を戻して名前にする（.pdf が無ければ付ける）', () => {
    expect(nameFromUrl('https://a.example/books/%E7%8C%AB_%E5%A5%87%E6%95%B0.pdf?dl=1')).toBe('猫_奇数.pdf');
    expect(nameFromUrl('https://a.example/download/123/')).toBe('123.pdf');
    expect(nameFromUrl('https://a.example/x.PDF')).toBe('x.PDF');
  });

  it('パスが空ならホスト名、% の並びが壊れていればそのまま', () => {
    expect(nameFromUrl('https://a.example/')).toBe('a.example.pdf');
    expect(nameFromUrl('https://a.example/%E7%8C')).toBe('%E7%8C.pdf');
  });
});

describe('downloadUrlFile', () => {
  it('資格情報を送らずに読み、大きさを先に予約して、届くたびに進み具合を知らせる', async () => {
    const reserve = vi.fn(async () => {});
    const progress = [];
    const bytes = await downloadUrlFile('https://a.example/x.pdf', {
      reserve,
      onProgress: (received, total) => progress.push([received, total]),
    });
    expect(bytes).toEqual(DATA);
    expect(reserve).toHaveBeenCalledWith(DATA.length);
    expect(progress).toEqual([
      [9, 25],
      [18, 25],
      [25, 25],
    ]);
    expect(fetchMock).toHaveBeenCalledWith('https://a.example/x.pdf', {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
  });

  it('大きさが分からなくても、場所を広げながら読む（進み具合の total は 0）', async () => {
    const large = Uint8Array.from({ length: 3 * 1024 * 1024 }, (_, i) => i % 251);
    fetchMock.mockResolvedValue(new Response(body(large, { pieces: 4 }), { status: 200 }));
    const reserve = vi.fn(async () => {});
    const progress = [];
    const bytes = await downloadUrlFile('https://a.example/x.pdf', {
      reserve,
      onProgress: (received, total) => progress.push(total === 0 && received > 0),
    });
    expect(reserve).toHaveBeenCalledWith(0);
    expect(bytes.length).toBe(large.length);
    expect(bytes).toEqual(large);
    expect(progress.every(Boolean)).toBe(true);
  });

  it('Content-Length より多く届いても（圧縮して送られた）、すべて読む', async () => {
    fetchMock.mockResolvedValue(new Response(body(DATA), { status: 200, headers: { 'Content-Length': '10' } }));
    const totals = [];
    expect(await downloadUrlFile('https://a.example/x.pdf', { onProgress: (r, total) => totals.push(total) })).toEqual(DATA);
    expect(totals).toEqual([10, 18, 25]); // 超えたら届いた分
  });

  it('相手が断った（HTTP のエラー）ときは、状態の番号を添えて投げる', async () => {
    fetchMock.mockResolvedValue(new Response('no', { status: 404 }));
    await expect(downloadUrlFile('https://a.example/x.pdf')).rejects.toThrow(
      '「https://a.example/x.pdf」を読み込めませんでした（HTTP 404）。'
    );
  });

  it('つながらない・CORS で断られたときは、その見込みを添えて投げる', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(downloadUrlFile('https://a.example/x.pdf')).rejects.toThrow(
      '相手のサーバーがブラウザからの読み込みを許していません: Failed to fetch'
    );
    fetchMock.mockRejectedValue('offline');
    await expect(downloadUrlFile('https://a.example/x.pdf')).rejects.toThrow('許していません: offline');
  });

  it('途中で切れたら投げる', async () => {
    fetchMock.mockResolvedValue(new Response(body(DATA, { cutAt: 10 }), { status: 200 }));
    await expect(downloadUrlFile('https://a.example/x.pdf')).rejects.toThrow(
      '「https://a.example/x.pdf」の読み込みが途中で切れました（network error）。'
    );
    // 届いたのが Content-Length より少なければ、切れたと見る。
    fetchMock.mockResolvedValue(new Response(DATA.slice(0, 5), { status: 200, headers: { 'Content-Length': '25' } }));
    await expect(downloadUrlFile('https://a.example/x.pdf')).rejects.toThrow('途中で切れました（5 / 25 バイト）');
    fetchMock.mockResolvedValue({ ok: true, headers: new Headers(), body: { getReader: () => ({ read: () => Promise.reject('gone') }) } });
    await expect(downloadUrlFile('https://a.example/x.pdf')).rejects.toThrow('途中で切れました（gone）');
  });
});
