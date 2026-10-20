// @vitest-environment jsdom
//
// 書籍スキャン PDF 結合ツールの、Drive の PDF の読み込み（サーバーの中継）。
//
// PDF の大きさを聞き、8 MiB ずつの範囲に分けて頼んでつなぐ
// （src/pdf-book-merger/drive-download.js）。結合した PDF はダウンロード
// するだけなので、Drive へ書くものは無い。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.fn();
const apiGetBytes = vi.fn();
vi.mock('../src/api.js', () => ({
  apiGet: (...args) => apiGet(...args),
  apiGetBytes: (...args) => apiGetBytes(...args),
}));

const { downloadDriveFile } = await import('../src/pdf-book-merger/drive-download.js');

beforeEach(() => {
  apiGet.mockReset();
  apiGetBytes.mockReset();
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
