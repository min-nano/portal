// PDF 結合ツール: 大きな PDF を端末のダウンロードに保存させる Service Worker
// （download-worker.js）。ページから渡された PDF を、その ID のアドレスが開かれたら
// 付けた名前と attachment を付けて返す。
//
// Service Worker の self は偽物にして、届いた出来事（install・message・fetch）を
// そのまま渡す。

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const listeners = {};
const skipWaiting = vi.fn();

beforeAll(async () => {
  vi.stubGlobal('self', {
    addEventListener: (type, listener) => {
      listeners[type] = listener;
    },
    skipWaiting,
    location: { origin: 'https://portal.example' },
  });
  await import('../src/pdf-book-merger/download-worker.js');
});

afterEach(() => {
  vi.useRealTimers();
});

const SCOPE = 'https://portal.example/assets/pdf-download/';

/** ページから PDF を渡す。返すのは、Service Worker が止められずに待つ間の約束と、受け取った知らせ。 */
function hand(data, origin = 'https://portal.example') {
  let keep = null;
  const replies = [];
  listeners.message({
    data,
    origin,
    waitUntil: (promise) => {
      keep = promise;
    },
    ports: [{ postMessage: (message) => replies.push(message) }],
  });
  return { keep, replies };
}

/** アドレスを開く。返すのは Service Worker の応答。 */
function open(id) {
  let response = null;
  listeners.fetch({
    request: { url: `${SCOPE}${id}` },
    respondWith: (value) => {
      response = value;
    },
  });
  return response;
}

describe('download-worker', () => {
  it('入れたらすぐ動く（前の版の Service Worker が片付くのを待たない）', () => {
    listeners.install();
    expect(skipWaiting).toHaveBeenCalled();
  });

  it('渡された PDF を、開かれたら付けた名前で attachment にして返す（種類は octet-stream。Safari が PDF として開かないように）', async () => {
    const file = new File(['%PDF-1.7'], '木造住宅関連資材カタログ5.pdf', { type: 'application/pdf' });
    const { replies } = hand({ id: 'a1', file });
    expect(replies).toEqual(['ready']);

    const response = open('a1');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(response.headers.get('Content-Disposition')).toBe(
      `attachment; filename="____________5.pdf"; filename*=UTF-8''${encodeURIComponent('木造住宅関連資材カタログ5.pdf')}`
    );
    expect(await response.text()).toBe('%PDF-1.7');
    // 覚えていない ID には、何も返さない（エラーの頁でツールのページを置き換えない）。
    expect(open('unknown').status).toBe(204);
  });

  it('同じアドレスをもう一度読みに来ても返す（Safari はダウンロードに切り替えるときに読み直す）。5 分たったら手放す', async () => {
    vi.useFakeTimers();
    const { keep } = hand({ id: 'b1', file: new File(['x'], 'b.pdf') });
    expect(open('b1').status).toBe(200);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1);
    expect(open('b1').status).toBe(200);
    await vi.advanceTimersByTimeAsync(1);
    // 手放したら、止められてもよい。
    await keep;
    expect(open('b1').status).toBe(204);
  });

  it('名前の引用符・括弧も崩さない', () => {
    hand({ id: 'c1', file: new File(['x'], `a"b(1)'c*.pdf`) });
    const response = open('c1');
    expect(response.headers.get('Content-Disposition')).toBe(
      `attachment; filename="a_b(1)'c*.pdf"; filename*=UTF-8''a%22b%281%29%27c%2A.pdf`
    );
  });

  it('ほかのサイトからの知らせは相手にしない', () => {
    const { keep, replies } = hand({ id: 'e1', file: new File(['x'], 'e.pdf') }, 'https://evil.example');
    expect([keep, replies]).toEqual([null, []]);
    expect(open('e1').status).toBe(204);
  });

  it('ID か PDF の無い知らせは相手にしない', () => {
    const { keep, replies } = hand({ id: 'd1' });
    expect([keep, replies]).toEqual([null, []]);
    expect(hand(undefined).replies).toEqual([]);
  });
});
