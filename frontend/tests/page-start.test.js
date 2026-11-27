// @vitest-environment jsdom
//
// 各ページの入口の共通の段取り（page-start.js）。
//
// 5 つの入口が同じ順序で始まることと、どこで失敗しても
// 「輪が回り続けたまま終わらない」ことを、ここで固定する。
//
//   1. 別ドメインなら、何もせずに終わる（Clerk を初期化しない）
//   2. バックエンドは、サインインの確認と**同時に**起こす
//   3. ポータルの名前とロゴは、サインインの確認を待たずに出す。「設定」の
//      メニューは、サインインしてからつなぐ
//   4. 未サインインなら、サインイン画面を出して終わる（準備は走らせない）
//   5. 画面（#app）を出すのは、準備が終わってから
//   6. 失敗したら、読み込み中を終わりにして理由を出す

import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/components/index.js';

const redirectToCanonicalHost = vi.fn();
const requireSignIn = vi.fn();
const warmUpApi = vi.fn();
const showSite = vi.fn();
const connectSiteSettingsMenu = vi.fn();
const hideStaffOnlyForExternalUsers = vi.fn();

vi.mock('../src/canonical-host.js', () => ({
  redirectToCanonicalHost: () => redirectToCanonicalHost(),
}));
vi.mock('../src/auth.js', () => ({
  requireSignIn: () => requireSignIn(),
  getSessionToken: async () => 'token',
}));
vi.mock('../src/api.js', () => ({ warmUpApi: () => warmUpApi() }));
vi.mock('../src/account.js', () => ({
  hideStaffOnlyForExternalUsers: () => hideStaffOnlyForExternalUsers(),
}));
vi.mock('../src/site-settings.js', () => ({
  showSite: () => showSite(),
  connectSiteSettingsMenu: () => connectSiteSettingsMenu(),
}));

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
  hideStaffOnlyForExternalUsers.mockResolvedValue(false);
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

  it('ポータルの名前とロゴは、サインインの確認を待たずに出す', async () => {
    let shownBeforeSignIn = false;
    requireSignIn.mockImplementation(async () => {
      shownBeforeSignIn = showSite.mock.calls.length === 1;
      expect(connectSiteSettingsMenu).not.toHaveBeenCalled();
      return CLERK;
    });

    startPage({});
    await settle();

    expect(shownBeforeSignIn).toBe(true);
    // 「設定」は、サインインを確かめてからつなぐ。
    expect(connectSiteSettingsMenu).toHaveBeenCalledTimes(1);
  });

  it('使えないアカウントだと分かったら、その理由を出す', async () => {
    hideStaffOnlyForExternalUsers.mockRejectedValue(
      Object.assign(new Error('このアプリは許可されたアカウント専用です。'), { status: 403, code: 'account_not_allowed' })
    );
    const onError = vi.fn();

    startPage({ onError });
    await settle();

    expect(onError).toHaveBeenCalledWith('このアプリは許可されたアカウント専用です。');
  });

  it('使えないアカウントには、画面を隠して断りの理由だけを出す（API を呼ばないツールも使わせない）', async () => {
    app().insertAdjacentHTML('afterbegin', '<button id="mergeBtn">結合</button>');
    hideStaffOnlyForExternalUsers.mockRejectedValue(
      Object.assign(new Error('このアプリは許可されたアカウント専用です。'), { status: 403, code: 'account_not_allowed' })
    );

    startPage({ prepare: async () => {} });
    await settle();

    // 消さずに印を付け、CSS で隠す（動いている途中の処理が要素を見失わない）。
    expect(document.getElementById('mergeBtn')).not.toBeNull();
    expect(app().hasAttribute('data-closed')).toBe(true);
    // 閉じた後に開いたダイアログは、開いたそばから閉じる（見えないモーダルを
    // 残して画面全体を操作できなくしない）。開いたままでないものは触らない。
    document.body.insertAdjacentHTML(
      'beforeend',
      '<dialog id="late"></dialog><div id="other"></div><portal-header><dialog id="menu"></dialog></portal-header>'
    );
    const late = document.getElementById('late');
    late.close = vi.fn(() => late.removeAttribute('open'));
    late.setAttribute('open', '');
    document.getElementById('other').setAttribute('open', '');
    // ポータル共通のヘッダーのものは閉じない。
    const menu = document.getElementById('menu');
    menu.close = vi.fn();
    menu.setAttribute('open', '');
    await settle();
    expect(late.close).toHaveBeenCalledTimes(1);
    expect(late.hasAttribute('open')).toBe(false);
    expect(menu.close).not.toHaveBeenCalled();
    // 理由は専用の欄に出す（#message は動いている途中の処理が書き換えるため）。
    const refusal = document.getElementById('refusal');
    expect(refusal.textContent).toBe('このアプリは許可されたアカウント専用です。');
    expect(refusal.getAttribute('role')).toBe('alert');
    // 既定の理由の出し方（#message）にも出る（閉じた画面では見えない）。
    expect(document.getElementById('message').textContent).toBe(
      'このアプリは許可されたアカウント専用です。'
    );
    // 動いている途中の処理が #message を書き換えても、理由は残る。
    document.getElementById('message').textContent = '画像からの読み取りを使えませんでした。';
    expect(refusal.textContent).toBe('このアプリは許可されたアカウント専用です。');
  });

  it('準備が使えないアカウントとして断られたら、画面の中身も隠す', async () => {
    // /api/me は断りを返さなかった（準備のほうが断られた）。
    hideStaffOnlyForExternalUsers.mockResolvedValue(false);
    const refused = Object.assign(new Error('このアプリは許可されたアカウント専用です。'), {
      status: 403,
      code: 'account_not_allowed',
    });

    startPage({ prepare: async () => Promise.reject(refused) });
    await settle();

    expect(app().hasAttribute('data-closed')).toBe(true);
    expect(document.getElementById('message').textContent).toBe(
      'このアプリは許可されたアカウント専用です。'
    );
  });

  it('外部ユーザーが社内専用のツールを開いたら、画面の中身を隠す（答えを待たずに）', async () => {
    hideStaffOnlyForExternalUsers.mockReturnValue(new Promise(() => {})); // /api/me はまだ
    const refused = Object.assign(new Error('この機能は社内アカウント専用です。'), {
      status: 403,
      code: 'staff_only',
    });

    startPage({ prepare: async () => Promise.reject(refused) });
    await settle();

    expect(app().hasAttribute('data-closed')).toBe(true);
  });

  it('準備が別の理由で先に失敗しても、使えないアカウントならそちらを出す', async () => {
    hideStaffOnlyForExternalUsers.mockRejectedValue(
      Object.assign(new Error('このアプリは許可されたアカウント専用です。'), {
        status: 403,
        code: 'account_not_allowed',
      })
    );
    const coldStart = Object.assign(new Error('サーバーエラーが発生しました (HTTP 503)。'), {
      status: 503,
    });

    startPage({ prepare: async () => Promise.reject(coldStart) });
    await settle();

    expect(app().hasAttribute('data-closed')).toBe(true);
    expect(document.getElementById('message').textContent).toBe(
      'このアプリは許可されたアカウント専用です。'
    );
  });

  it('使えないアカウントかの答えを待たずに、準備の失敗をすぐ出す', async () => {
    hideStaffOnlyForExternalUsers.mockReturnValue(new Promise(() => {})); // 答えが来ない
    const onError = vi.fn();

    startPage({ prepare: async () => Promise.reject(new Error('通信に失敗しました。')), onError });
    await settle();

    expect(onError).toHaveBeenCalledWith('通信に失敗しました。');
    expect(app().hasAttribute('data-closed')).toBe(false);
  });

  it('外部ユーザーと分かっても、準備の失敗はそのまま（閉じない）', async () => {
    hideStaffOnlyForExternalUsers.mockResolvedValue(true);
    const onError = vi.fn();

    startPage({ prepare: async () => Promise.reject(new Error('通信に失敗しました。')), onError });
    await settle();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(app().hasAttribute('data-closed')).toBe(false);
  });

  it('準備の失敗を出した後に断りが届いたら、画面を閉じて理由を出し直す', async () => {
    {
      let answer;
      hideStaffOnlyForExternalUsers.mockReturnValue(new Promise((resolve, reject) => { answer = reject; }));
      const onError = vi.fn();

      startPage({ prepare: async () => Promise.reject(new Error('通信に失敗しました。')), onError });
      await settle();
      expect(onError).toHaveBeenLastCalledWith('通信に失敗しました。');
      expect(app().hasAttribute('data-closed')).toBe(false);

      answer(Object.assign(new Error('このアプリは許可されたアカウント専用です。'), {
        status: 403,
        code: 'account_not_allowed',
      }));
      await settle();
      expect(onError).toHaveBeenLastCalledWith('このアプリは許可されたアカウント専用です。');
      expect(app().hasAttribute('data-closed')).toBe(true);
    }
  });

  it('画面を閉じるときは、#app の外に開いているダイアログも閉じる', async () => {
    document.body.insertAdjacentHTML('beforeend', '<dialog id="preview" open></dialog>');
    const preview = document.getElementById('preview');
    preview.close = vi.fn(() => preview.removeAttribute('open'));
    hideStaffOnlyForExternalUsers.mockRejectedValue(
      Object.assign(new Error('このアプリは許可されたアカウント専用です。'), {
        status: 403,
        code: 'account_not_allowed',
      })
    );

    startPage({ prepare: async () => {} });
    await settle();

    expect(preview.close).toHaveBeenCalledTimes(1);
    expect(preview.hasAttribute('open')).toBe(false);
  });

  it('ほかの理由で準備に失敗したときは、画面を閉じない（理由を出すだけ）', async () => {
    startPage({ prepare: async () => Promise.reject(new Error('通信に失敗しました。')) });
    await settle();

    expect(app().hasAttribute('data-closed')).toBe(false);
    expect(document.getElementById('message').textContent).toBe('通信に失敗しました。');
  });

  it('準備の途中で断られたと分かっても、理由を出すのは準備が終わってから', async () => {
    hideStaffOnlyForExternalUsers.mockRejectedValue(
      Object.assign(new Error('このアプリは許可されたアカウント専用です。'), { status: 403, code: 'account_not_allowed' })
    );
    let finishPreparing;
    const prepare = vi.fn(() => new Promise((resolve) => { finishPreparing = resolve; }));
    const onError = vi.fn(() => expect(app().hidden).toBe(false));

    startPage({ prepare, onError });
    await settle();
    // 組み立て途中の画面は出さない（理由もまだ出さない）。
    expect(app().hidden).toBe(true);
    expect(onError).not.toHaveBeenCalled();

    finishPreparing();
    await settle();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('このアプリは許可されたアカウント専用です。');
  });

  it('サインインしたら、外部ユーザーかを確かめに行くが、答えは待たない', async () => {
    // 答えが返らないままでも、画面は出る（社内ユーザーに起動待ちを被せない）。
    hideStaffOnlyForExternalUsers.mockReturnValue(new Promise(() => {}));
    const prepare = vi.fn(async () => {});

    startPage({ prepare });
    await settle();

    expect(hideStaffOnlyForExternalUsers).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(app().hidden).toBe(false);
  });

  it('未サインインのときも名前とロゴは出すが、「設定」はつながない', async () => {
    requireSignIn.mockResolvedValue(null);

    startPage({});
    await settle();

    expect(showSite).toHaveBeenCalledTimes(1);
    expect(connectSiteSettingsMenu).not.toHaveBeenCalled();
    expect(hideStaffOnlyForExternalUsers).not.toHaveBeenCalled();
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
    expect(showSite).not.toHaveBeenCalled();
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
