// @vitest-environment jsdom
//
// バックエンドを先に起こしておく処理（api.js の warmUpApi）。
//
// ツールの準備は「/config → 計算実装（wasm）」という直列の並びで、その先頭が
// Cloud Run のインスタンス起動待ちを丸ごと被る。サインインの確認と同時に
// 起こしておくのが狙いなので、
//
//   - 呼び出し側を待たせない（await しない）
//   - キャッシュで済まさない（起こすのが目的）
//   - 失敗しても投げない（起きていなければ、続く /config が普通に起こす）
//
// の 3 つを固定する。

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/auth.js', () => ({ getSessionToken: async () => 'token' }));

const { apiGet, warmUpApi } = await import('../src/api.js');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('warmUpApi', () => {
  it('認証の要らない /api/healthz を、キャッシュを使わずに叩く', () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    // 呼び出し側は待たない（await しない）。投げっぱなしで、その場で戻る。
    warmUpApi();

    expect(fetchMock).toHaveBeenCalledWith('/api/healthz', { cache: 'no-store' });
  });

  it('失敗しても投げない（起こせなければ、続く /config が起こす）', async () => {
    const rejected = Promise.reject(new Error('オフライン'));
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(rejected));

    expect(() => warmUpApi()).not.toThrow();
    // 握りつぶしているので、未処理の拒否にもならない。
    await expect(rejected.catch(() => 'handled')).resolves.toBe('handled');
  });
});

describe('失敗の伝え方（apiGet）', () => {
  /** 失敗の応答を返す fetch。body が文字列なら JSON として読めない本文。 */
  function failWith(status, body) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status,
        json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
      })
    );
  }

  it('サーバーが種類を名乗った失敗は、その目印（code）を添える', async () => {
    failWith(403, { error: 'このアプリは許可されたアカウント専用です。', code: 'account_not_allowed' });

    await expect(apiGet('/api/me')).rejects.toMatchObject({
      message: 'このアプリは許可されたアカウント専用です。',
      status: 403,
      code: 'account_not_allowed',
    });
  });

  it('名乗らない失敗には目印を付けない（文言だけ）', async () => {
    failWith(403, { error: 'この機能は社内アカウント専用です。' });

    const error = await apiGet('/api/me').catch((e) => e);
    expect(error).toMatchObject({ message: 'この機能は社内アカウント専用です。', status: 403 });
    expect(error.code).toBeUndefined();
  });

  it('本文が空（null）の失敗も、既定の文言で、目印も無い', async () => {
    failWith(500, null);

    const error = await apiGet('/api/me').catch((e) => e);
    expect(error).toMatchObject({ message: 'サーバーエラーが発生しました (HTTP 500)。', status: 500 });
    expect(error.code).toBeUndefined();
  });

  it('JSON でない失敗（プロキシなど）は、既定の文言で、目印も無い', async () => {
    failWith(403, '<html>Forbidden</html>');

    const error = await apiGet('/api/me').catch((e) => e);
    expect(error.message).toBe('サーバーエラーが発生しました (HTTP 403)。');
    expect(error.code).toBeUndefined();
  });
});
