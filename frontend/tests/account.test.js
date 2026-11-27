// @vitest-environment jsdom
//
// 社内専用の入口は、社内ユーザーだと確かめてから見せる（account.js）。
//
// 見せる・隠すは CSS（base.css の :root:not([data-account='internal'])
// [data-staff-only]）で、ここが受け持つのは「/api/me を聞いて <html> に印を
// 付ける」ことと、「最後に確かめた結果を端末に覚えておき、次に先に見せる」こと。
// 見せ方だけなので、聞けなかったときは見せ方を変えない（断るのはサーバー）。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.fn();
vi.mock('../src/api.js', () => ({ apiGet: (...args) => apiGet(...args) }));

const { RETRY_DELAYS_MS, checkAccount, forgetRememberedAccount, showRememberedAccount } = await import(
  '../src/account.js'
);

/** localStorage の代役（読み書きを観測する）。 */
function memoryStorage(initial = {}) {
  const items = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key) => (items.has(key) ? items.get(key) : null)),
    setItem: vi.fn((key, value) => items.set(key, String(value))),
    removeItem: vi.fn((key) => items.delete(key)),
    items,
  };
}

const noWait = async () => {};
const account = () => document.documentElement.dataset.account;

beforeEach(() => {
  vi.clearAllMocks();
  delete document.documentElement.dataset.account;
  localStorage.clear();
});

describe('checkAccount', () => {
  it('社内ユーザーなら入口を見せる印を付け、覚えておく', async () => {
    apiGet.mockResolvedValue({ email: 'tester@example.co.jp', external: false });
    const storage = memoryStorage();

    expect(await checkAccount(document, noWait, storage)).toBe('internal');

    expect(apiGet).toHaveBeenCalledWith('/api/me');
    expect(account()).toBe('internal');
    expect(JSON.parse(storage.items.get('portal.account'))).toEqual({
      email: 'tester@example.co.jp',
    });
  });

  it('外部ユーザーなら隠したまま（前回社内として見せていても隠し、覚えた値も忘れる）', async () => {
    document.documentElement.dataset.account = 'internal';
    apiGet.mockResolvedValue({ email: 'partner@gmail.com', external: true });
    const storage = memoryStorage({
      'portal.account': JSON.stringify({ email: 'partner@gmail.com' }),
    });

    expect(await checkAccount(document, noWait, storage)).toBe('external');

    expect(account()).toBe('external');
    // 外部ユーザーのアドレスは端末に残さない。
    expect(storage.items.has('portal.account')).toBe(false);
  });

  it.each([['null', null], ['文字列', 'ok']])(
    '答えがオブジェクトでない（%s）なら、確かめられなかったのと同じ（閉じない・見せない）',
    async (_, body) => {
      apiGet.mockResolvedValue(body);

      expect(await checkAccount(document, noWait, memoryStorage())).toBeNull();
      expect(account()).toBeUndefined();
    }
  );

  it('社内ユーザーかをはっきり答えない（古いバックエンド）なら、見せない', async () => {
    apiGet.mockResolvedValue({ email: 'tester@example.co.jp' });

    expect(await checkAccount(document, noWait, memoryStorage())).toBe('external');
    expect(account()).toBe('external');
  });

  it('使えないアカウント（403）は、覚えた値を捨て、隠してから理由を投げる', async () => {
    document.documentElement.dataset.account = 'internal';
    const refused = Object.assign(
      new Error('このアプリは許可されたアカウント専用です（someone@gmail.com は利用できません）。'),
      { status: 403, code: 'account_not_allowed' }
    );
    apiGet.mockRejectedValue(refused);
    const storage = memoryStorage({
      'portal.account': JSON.stringify({ email: 'someone@gmail.com' }),
    });

    await expect(checkAccount(document, noWait, storage)).rejects.toBe(refused);
    expect(account()).toBe('refused');
    expect(storage.items.has('portal.account')).toBe(false);
  });

  it('取り直しても聞けなかったときは、見せ方を変えない', async () => {
    document.documentElement.dataset.account = 'internal'; // 覚えた値で見せていた
    apiGet.mockRejectedValue(
      Object.assign(new Error('サーバーエラーが発生しました (HTTP 503)。'), { status: 503 })
    );
    const wait = vi.fn(async () => {});
    const storage = memoryStorage();

    expect(await checkAccount(document, wait, storage)).toBeNull();
    expect(account()).toBe('internal');
    expect(storage.setItem).not.toHaveBeenCalled();
    // 間を置いて取り直してから、あきらめる。
    expect(wait.mock.calls).toEqual(RETRY_DELAYS_MS.map((ms) => [ms]));
    expect(apiGet).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length + 1);
  });

  it('通信の失敗のあとで答えが届けば、それに合わせる', async () => {
    apiGet
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ email: 'tester@example.co.jp', external: false });
    const wait = vi.fn(async () => {});

    expect(await checkAccount(document, wait, memoryStorage())).toBe('internal');
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it('流量の制限（429）は、待てば通りうるので取り直す', async () => {
    apiGet
      .mockRejectedValueOnce(Object.assign(new Error('HTTP 429'), { status: 429 }))
      .mockResolvedValueOnce({ email: 'tester@example.co.jp', external: false });
    const wait = vi.fn(async () => {});

    expect(await checkAccount(document, wait, memoryStorage())).toBe('internal');
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['目印の無い 403（プロキシなど）', Object.assign(new Error('HTTP 403'), { status: 403 })],
    ['応答の読み損ない', new SyntaxError('Unexpected token < in JSON')],
  ])('%s は、使えないアカウントとは見なさず、取り直しもしない', async (_, error) => {
    apiGet.mockRejectedValue(error);
    const wait = vi.fn(async () => {});

    expect(await checkAccount(document, wait, memoryStorage())).toBeNull();
    expect(account()).toBeUndefined();
    expect(wait).not.toHaveBeenCalled();
  });

  it('既定では、取り直す前に実際に間を置く', async () => {
    vi.useFakeTimers();
    try {
      apiGet
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce({ email: 'tester@example.co.jp', external: false });

      const result = checkAccount(document, undefined, memoryStorage());
      await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] - 1);
      expect(apiGet).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toBe('internal');
    } finally {
      vi.useRealTimers();
    }
  });

  it('端末に保存場所が無くても、見せ方は決まる', async () => {
    apiGet.mockResolvedValue({ email: 'tester@example.co.jp', external: false });

    expect(await checkAccount(document, noWait, null)).toBe('internal');
    expect(account()).toBe('internal');
  });

  it('端末に覚えられなくても（プライベートモードなど）、見せ方は決まる', async () => {
    apiGet.mockResolvedValue({ email: 'tester@example.co.jp', external: false });
    const storage = {
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };

    expect(await checkAccount(document, noWait, storage)).toBe('internal');
    expect(account()).toBe('internal');
  });
});

describe('forgetRememberedAccount', () => {
  it('覚えたアドレスを忘れる', () => {
    const storage = memoryStorage({ 'portal.account': JSON.stringify({ email: 'a@example.co.jp' }) });

    forgetRememberedAccount(storage);

    expect(storage.items.has('portal.account')).toBe(false);
  });
});

describe('showRememberedAccount', () => {
  const remembered = (value) => memoryStorage({ 'portal.account': JSON.stringify(value) });

  it('前回このアドレスが社内ユーザーだったなら、確かめる前に見せる', () => {
    showRememberedAccount(
      'Tester@Example.co.jp',
      document,
      remembered({ email: 'tester@example.co.jp' })
    );
    expect(account()).toBe('internal');
  });

  it.each([
    ['別のアドレスで覚えていた', { email: 'other@example.co.jp' }],
    ['アドレスの無い値', {}],
  ])('%s なら、見せない', (_, value) => {
    showRememberedAccount('tester@example.co.jp', document, remembered(value));
    expect(account()).toBeUndefined();
  });

  it.each([
    ['覚えていない', memoryStorage()],
    ['壊れた値', memoryStorage({ 'portal.account': '{' })],
    ['オブジェクトでない値', memoryStorage({ 'portal.account': '"internal"' })],
    ['端末に保存場所が無い', null],
  ])('%s なら、見せない', (_, storage) => {
    showRememberedAccount('tester@example.co.jp', document, storage);
    expect(account()).toBeUndefined();
  });

  it('サインインしているアドレスが分からなければ、見せない', () => {
    showRememberedAccount(
      undefined,
      document,
      remembered({ email: 'tester@example.co.jp' })
    );
    expect(account()).toBeUndefined();
  });
});

describe('見せ方の決めごと（base.css）', () => {
  function withBaseCss(body, check) {
    const style = document.createElement('style');
    style.textContent = readFileSync(resolve(process.cwd(), 'src/styles/base.css'), 'utf8');
    document.head.append(style);
    document.body.innerHTML = body;
    try {
      check((id) => getComputedStyle(document.getElementById(id)).display !== 'none');
    } finally {
      style.remove();
    }
  }

  it('印の付いた入口は、社内ユーザーと確かめてから見せる', () => {
    withBaseCss(
      `<button id="staff" data-staff-only>Drive から選ぶ</button>
       <button id="open">手元の PDF を追加</button>`,
      (shown) => {
        // 確かめる前は見せない（外部の人に一瞬でも見せない）。
        expect([shown('staff'), shown('open')]).toEqual([false, true]);

        for (const kind of ['external', 'refused']) {
          document.documentElement.dataset.account = kind;
          expect([shown('staff'), shown('open')]).toEqual([false, true]);
        }

        document.documentElement.dataset.account = 'internal';
        expect([shown('staff'), shown('open')]).toEqual([true, true]);
      }
    );
  });

  it('閉じた画面（#app[data-closed]）は、断りの理由（#refusal）だけを見せる', () => {
    withBaseCss(
      `<div id="app" data-closed>
         <button id="merge">結合</button>
         <div id="message">画像からの読み取りを使えませんでした。</div>
         <p id="refusal">このアプリは許可されたアカウント専用です。</p>
       </div>`,
      (shown) => {
        // ツールが後から hidden を外しても、閉じたまま。
        document.getElementById('merge').hidden = false;
        // ツールの理由の欄（#message）は、動いている処理が書き換えるので見せない。
        expect([shown('merge'), shown('message'), shown('refusal')]).toEqual([
          false,
          false,
          true,
        ]);
      }
    );
  });
});
