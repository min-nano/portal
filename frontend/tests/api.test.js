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
import { warmUpApi } from '../src/api.js';

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
