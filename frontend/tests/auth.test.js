// @vitest-environment jsdom
//
// サインインゲート（auth.js の requireSignIn）のテスト。
//
// ここで固定したいのは、画面を開いてから使えるようになるまでの段取り。
//
//   1. 画面（#app）を出すのも、読み込み中の表示を消すのも、requireSignIn の
//      仕事ではない。ツールはサインインのあとにも準備（フォーム定義と計算
//      実装の取得）があり、そこまで済んでから出したいため
//   2. サインイン画面（@clerk/ui。React ごと抱えていて重い）は、
//      **未サインインだと分かってから**でなければ読み込まない
//
// 2 は clerk-js の「ui.ClerkUI には Promise を渡せて、それを待つのは
// マウントするときだけ」という作りに乗っている。壊れると、ふだんの利用
// （サインイン済み）で余計な JS を読むことになるので、テストで固定する。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let clerkUiLoaded = false;

vi.mock('@clerk/ui/entry', () => {
  clerkUiLoaded = true;
  return { ClerkUI: class FakeClerkUI {} };
});

vi.mock('@clerk/localizations', () => ({ jaJP: { locale: 'ja-JP' } }));

// 画面に出す Clerk の代わり。load() の応答（サインイン済みかどうか）は
// テストごとに signedInUser で決める。
let signedInUser = null;
let loadOptions = null;
let mountedInto = null;

vi.mock('@clerk/clerk-js', () => ({
  Clerk: class FakeClerk {
    constructor(publishableKey) {
      this.publishableKey = publishableKey;
      this.user = null;
    }

    async load(options) {
      loadOptions = options;
      this.user = signedInUser;
    }

    mountSignIn(node) {
      mountedInto = node;
      // 本物も、渡された要素の中に自前の器を差し込む。
      node.appendChild(document.createElement('div'));
    }

    addListener() {}
  },
}));

const PAGE = `
  <portal-loading id="pageLoading" class="page-loading">サインインを確認しています…</portal-loading>
  <portal-auth-gate id="authGate" class="auth-gate" hidden></portal-auth-gate>
  <div id="app" class="container" hidden></div>
`;

/** テストごとに auth.js を読み直す（渡す約束はモジュール単位で 1 つのため）。 */
async function loadAuthModule() {
  vi.resetModules();
  clerkUiLoaded = false;
  loadOptions = null;
  mountedInto = null;
  await import('../src/components/index.js');
  document.body.innerHTML = PAGE;
  return import('../src/auth.js');
}

/** 約束がまだ果たされていないことを確かめる。 */
async function isPending(promise) {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  // 決着済みならマイクロタスクを数回まわすうちに必ず反映される。
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  return !settled;
}

beforeEach(() => {
  vi.stubEnv('VITE_CLERK_PUBLISHABLE_KEY', 'pk_test_dummy');
  signedInUser = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('requireSignIn（サインイン済み）', () => {
  it('@clerk/ui は読み込まず、画面を出すのは呼び出し側に任せる', async () => {
    const { requireSignIn } = await loadAuthModule();
    signedInUser = { primaryEmailAddress: { emailAddress: 'taro@example.com' } };

    const clerk = await requireSignIn();

    expect(clerk).not.toBeNull();
    expect(document.getElementById('authGate').hidden).toBe(true);
    // ツールはこのあとにも準備がある。画面はまだ出さず、読み込み中も残す。
    expect(document.getElementById('app').hidden).toBe(true);
    expect(document.getElementById('pageLoading')).not.toBeNull();
    // サインイン画面は要らないので、1 バイトも読み込まない。
    expect(clerkUiLoaded).toBe(false);
    expect(mountedInto).toBeNull();
    expect(await isPending(loadOptions.ui.ClerkUI)).toBe(true);
  });

  it('準備ができたら showApp() で画面が出て、読み込み中が消える', async () => {
    const { requireSignIn } = await loadAuthModule();
    const { showApp } = await import('../src/components/loading.js');
    signedInUser = { primaryEmailAddress: { emailAddress: 'taro@example.com' } };

    await requireSignIn();
    showApp();

    expect(document.getElementById('app').hidden).toBe(false);
    expect(document.getElementById('pageLoading')).toBeNull();
  });

  it('ヘッダーにアカウントを出す', async () => {
    document.body.innerHTML = '';
    const { requireSignIn } = await loadAuthModule();
    document.body.insertAdjacentHTML(
      'afterbegin',
      '<portal-header class="portal-header" portal-name="社内ポータル"></portal-header>'
    );
    signedInUser = { primaryEmailAddress: { emailAddress: 'taro@example.com' } };

    await requireSignIn();

    expect(document.getElementById('accountArea').hidden).toBe(false);
    expect(document.getElementById('accountEmail').textContent).toBe('taro@example.com');
  });
});

describe('requireSignIn（未サインイン）', () => {
  it('サインインゲートを出し、そこで初めて @clerk/ui を読み込む', async () => {
    const { requireSignIn } = await loadAuthModule();

    const clerk = await requireSignIn();

    expect(clerk).toBeNull();
    expect(document.getElementById('app').hidden).toBe(true);
    expect(document.getElementById('authGate').hidden).toBe(false);
    // サインイン画面を出すので、ページの読み込み中の表示はここで終わり。
    expect(document.getElementById('pageLoading')).toBeNull();

    expect(clerkUiLoaded).toBe(true);
    expect(mountedInto).toBe(document.querySelector('.clerk-mount'));
    // 渡してあった約束は、ここで果たされている（clerk-js がマウントできる）。
    expect(await isPending(loadOptions.ui.ClerkUI)).toBe(false);
  });

  it('サインイン画面が現れたら、ゲートの中の読み込み中の表示を消す', async () => {
    const { requireSignIn } = await loadAuthModule();

    await requireSignIn();
    // MutationObserver は次のマイクロタスクで動く。
    await Promise.resolve();

    const mount = document.querySelector('.clerk-mount');
    expect(mount.querySelector('portal-loading')).toBeNull();
    expect(mount.children).toHaveLength(1);
  });
});

describe('requireSignIn（サインイン画面を読み込めない）', () => {
  it('待たせたままにせず、ゲートの中の読み込み中を片付けて投げる', async () => {
    vi.resetModules();
    document.body.innerHTML = '';
    // @clerk/ui の取得そのものが失敗する状況（配信の不調・古いキャッシュ）。
    vi.doMock('@clerk/ui/entry', () => {
      throw new Error('サインイン画面を読み込めませんでした。');
    });
    await import('../src/components/index.js');
    document.body.innerHTML = PAGE;
    const { requireSignIn } = await import('../src/auth.js');

    // 失敗はそのまま投げ返す（理由の出し方はページが決める）。
    await expect(requireSignIn()).rejects.toThrow();

    // 回り続ける輪を残さない（理由は呼び出し側＝page-start.js が出す）。
    expect(document.querySelector('.clerk-mount portal-loading')).toBeNull();
    vi.doUnmock('@clerk/ui/entry');
  });
});

describe('requireSignIn（鍵が未設定）', () => {
  it('設定の不備を投げる（呼び出し側が画面に出す）', async () => {
    const { requireSignIn } = await loadAuthModule();
    vi.stubEnv('VITE_CLERK_PUBLISHABLE_KEY', '');

    await expect(requireSignIn()).rejects.toThrow('VITE_CLERK_PUBLISHABLE_KEY');
  });
});
