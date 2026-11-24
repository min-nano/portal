// @vitest-environment jsdom
//
// ポータルトップページの入口（portal.js）。
//
// このページに準備は無い（ツール一覧は HTML に書いてある）ので、固定するのは
// 「サインインの確認が済めば画面が出る」ことと、**理由の出し方がツールと
// 違う**こと。トップページの画面の中にはメッセージ欄が無いので、先に進めない
// 理由はサインインゲートに出す。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireSignIn = vi.fn();
const warmUpApi = vi.fn();
const apiGet = vi.fn();

vi.mock('../src/canonical-host.js', () => ({
  redirectToCanonicalHost: () => false,
}));
vi.mock('../src/auth.js', () => ({
  requireSignIn: () => requireSignIn(),
  getSessionToken: async () => 'token',
}));
vi.mock('../src/api.js', () => ({
  warmUpApi: () => warmUpApi(),
  apiGet: (...args) => apiGet(...args),
}));

const PAGE = `
  <portal-loading id="pageLoading" class="page-loading">サインインを確認しています…</portal-loading>
  <portal-auth-gate id="authGate" class="auth-gate" hidden></portal-auth-gate>
  <div id="app" class="container" hidden><h2>ツール一覧</h2></div>
`;

/** 入口は読み込んだ時点で走るので、テストごとに読み直す。 */
async function loadPortal() {
  vi.resetModules();
  await import('../src/components/index.js');
  document.body.innerHTML = PAGE;
  await import('../src/portal.js');
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  apiGet.mockResolvedValue({ email: 'tester@example.co.jp', external: false });
  delete document.documentElement.dataset.account;
});

describe('ポータルトップページ', () => {
  it('サインインが済めば、そのままツール一覧を出す', async () => {
    requireSignIn.mockResolvedValue({ user: { id: 'user-1' } });

    await loadPortal();

    expect(document.getElementById('app').hidden).toBe(false);
    expect(document.getElementById('pageLoading')).toBeNull();
    expect(document.getElementById('authGate').hidden).toBe(true);
  });

  it('バックエンドを起こし、外部ユーザーなら社内専用のツールを隠す印を付ける', async () => {
    requireSignIn.mockResolvedValue({ user: { id: 'user-1' } });
    apiGet.mockResolvedValue({ email: 'partner@gmail.com', external: true });

    await loadPortal();

    expect(warmUpApi).toHaveBeenCalledTimes(1);
    expect(apiGet).toHaveBeenCalledWith('/api/me');
    expect(document.documentElement.dataset.account).toBe('external');
  });

  it('どちらの許可リストにも無いアカウントには、一覧をしまって理由を出す', async () => {
    requireSignIn.mockResolvedValue({ user: { id: 'user-1' } });
    apiGet.mockRejectedValue(
      Object.assign(new Error('このアプリは許可されたアカウント専用です。'), { status: 403 })
    );

    await loadPortal();

    expect(document.getElementById('app').hidden).toBe(true);
    const gate = document.getElementById('authGate');
    expect(gate.hidden).toBe(false);
    expect(gate.querySelector('.note').textContent).toBe('このアプリは許可されたアカウント専用です。');
  });

  it('先に進めないときは、理由をサインインゲートに出す', async () => {
    requireSignIn.mockRejectedValue(
      new Error('VITE_CLERK_PUBLISHABLE_KEY が設定されていません。')
    );

    await loadPortal();

    const gate = document.getElementById('authGate');
    expect(gate.hidden).toBe(false);
    expect(gate.querySelector('.note').textContent).toContain(
      'VITE_CLERK_PUBLISHABLE_KEY'
    );
    // サインイン画面は出てこないので、ゲートの中の読み込み中も片付ける。
    expect(gate.querySelector('portal-loading')).toBeNull();
    // ツール一覧は出さない（サインインしていないので使えない）。
    expect(document.getElementById('app').hidden).toBe(true);
    // 輪が回り続けたまま終わらない。
    expect(document.getElementById('pageLoading')).toBeNull();
  });
});
