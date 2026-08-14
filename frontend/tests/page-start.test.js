// @vitest-environment jsdom
//
// 各ページの入口の共通の段取り（page-start.js）。
//
// 5 つの入口が同じ順序で始まることと、どこで失敗しても
// 「輪が回り続けたまま終わらない」ことを、ここで固定する。
//
//   1. 別ドメインなら、何もせずに終わる（Clerk を初期化しない）
//   2. バックエンドは、サインインの確認と**同時に**起こす
//   3. 未サインインなら、サインイン画面を出して終わる（準備は走らせない）
//   4. 画面（#app）を出すのは、準備が終わってから
//   5. 失敗したら、読み込み中を終わりにして理由を出す

import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/components/index.js';

const redirectToCanonicalHost = vi.fn();
const requireSignIn = vi.fn();
const warmUpApi = vi.fn();

vi.mock('../src/canonical-host.js', () => ({
  redirectToCanonicalHost: () => redirectToCanonicalHost(),
}));
vi.mock('../src/auth.js', () => ({
  requireSignIn: () => requireSignIn(),
  getSessionToken: async () => 'token',
}));
vi.mock('../src/api.js', () => ({ warmUpApi: () => warmUpApi() }));

const { startPage } = await import('../src/page-start.js');

const CLERK = { user: { id: 'user-1' } };

const PAGE = `
  <portal-loading id="pageLoading" class="page-loading">サインインを確認しています…</portal-loading>
  <div id="app" class="container" hidden><div id="message"></div></div>
`;

/** startPage は待てないので（入口なので何も返さない）、決着まで回す。 */
async function settle() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function loading() {
  return document.getElementById('pageLoading');
}

function app() {
  return document.getElementById('app');
}

beforeEach(() => {
  document.body.innerHTML = PAGE;
  vi.clearAllMocks();
  redirectToCanonicalHost.mockReturnValue(false);
  requireSignIn.mockResolvedValue(CLERK);
});

describe('startPage', () => {
  it('準備が終わってから画面を出す（組み立て途中を見せない）', async () => {
    const seen = [];
    const prepare = vi.fn(async () => {
      // 準備の最中は、まだ画面を出していない。
      seen.push({ appHidden: app().hidden, label: loading()?.textContent });
    });

    startPage({ prepare, usesApi: true, preparing: '計算の準備をしています…' });
    await settle();

    expect(seen).toEqual([
      { appHidden: true, label: '計算の準備をしています…' },
    ]);
    expect(prepare).toHaveBeenCalledWith(CLERK);
    expect(app().hidden).toBe(false);
    expect(loading()).toBeNull();
  });

  it('バックエンドは、サインインの確認を待たずに起こす', async () => {
    let warmedBeforeSignIn = false;
    requireSignIn.mockImplementation(async () => {
      warmedBeforeSignIn = warmUpApi.mock.calls.length === 1;
      return CLERK;
    });

    startPage({ usesApi: true });
    await settle();

    expect(warmedBeforeSignIn).toBe(true);
  });

  it('バックエンドを使わないページでは起こさない', async () => {
    startPage({});
    await settle();

    expect(warmUpApi).not.toHaveBeenCalled();
    // 準備が無いページ（トップページ）でも、画面は出る。
    expect(app().hidden).toBe(false);
    expect(loading()).toBeNull();
  });

  it('別ドメインへ移動するときは、サインインの確認も準備もしない', async () => {
    redirectToCanonicalHost.mockReturnValue(true);
    const prepare = vi.fn();

    startPage({ prepare, usesApi: true });
    await settle();

    expect(warmUpApi).not.toHaveBeenCalled();
    expect(requireSignIn).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    // 移動するまでのあいだ、読み込み中は出したままにする。
    expect(loading()).not.toBeNull();
    expect(app().hidden).toBe(true);
  });

  it('未サインインなら、準備は走らせず画面も出さない（サインイン画面を表示中）', async () => {
    requireSignIn.mockResolvedValue(null);
    const prepare = vi.fn();

    startPage({ prepare, preparing: 'ツールの準備をしています…' });
    await settle();

    expect(prepare).not.toHaveBeenCalled();
    expect(app().hidden).toBe(true);
  });

  it('準備に失敗したら、画面を出して理由をメッセージ欄に出す', async () => {
    const prepare = vi.fn().mockRejectedValue(new Error('雛形を取得できません。'));

    startPage({ prepare, usesApi: true, preparing: '準備中…' });
    await settle();

    // 理由の置き場所は画面の中にあるので、出せないときも画面は出す。
    expect(app().hidden).toBe(false);
    expect(loading()).toBeNull();
    expect(document.getElementById('message').textContent).toBe(
      '雛形を取得できません。'
    );
    expect(document.getElementById('message').style.color).toBe('red');
  });

  it('サインインの確認に失敗したときも、理由を出す', async () => {
    requireSignIn.mockRejectedValue(new Error('鍵が設定されていません。'));

    startPage({ prepare: vi.fn(), usesApi: true });
    await settle();

    expect(document.getElementById('message').textContent).toBe(
      '鍵が設定されていません。'
    );
  });

  it('理由の出し方はページごとに差し替えられる（トップページはゲートに出す）', async () => {
    requireSignIn.mockRejectedValue(new Error('壊れています。'));
    const onError = vi.fn();

    startPage({ onError });
    await settle();

    expect(onError).toHaveBeenCalledWith('壊れています。');
    // 差し替えたときは画面を出さない（トップページはゲートに出すため）。
    expect(app().hidden).toBe(true);
    // それでも、輪は回り続けない。
    expect(loading()).toBeNull();
  });

  it('メッセージ欄が無いページでも落ちない', async () => {
    document.body.innerHTML =
      '<portal-loading id="pageLoading" class="page-loading">…</portal-loading>' +
      '<div id="app" hidden></div>';
    requireSignIn.mockRejectedValue(new Error('だめでした。'));

    startPage({});
    await settle();

    expect(app().hidden).toBe(false);
  });
});
