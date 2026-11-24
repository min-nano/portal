// @vitest-environment jsdom
//
// 外部ユーザーに社内専用の入口を見せない（account.js）。
//
// 隠すのは CSS（base.css の :root[data-account='external'] [data-staff-only]）で、
// ここが受け持つのは「/api/me を聞いて、外部ユーザーなら <html> に印を付ける」
// ことだけ。見せ方だけなので、聞けなかったときは何もしない（断るのはサーバー）。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.fn();
vi.mock('../src/api.js', () => ({ apiGet: (...args) => apiGet(...args) }));

const { hideStaffOnlyForExternalUsers } = await import('../src/account.js');

beforeEach(() => {
  vi.clearAllMocks();
  delete document.documentElement.dataset.account;
});

describe('hideStaffOnlyForExternalUsers', () => {
  it('外部ユーザーなら <html> に印を付ける', async () => {
    apiGet.mockResolvedValue({ email: 'partner@gmail.com', external: true });

    expect(await hideStaffOnlyForExternalUsers()).toBe(true);

    expect(apiGet).toHaveBeenCalledWith('/api/me');
    expect(document.documentElement.dataset.account).toBe('external');
  });

  it('社内ユーザーには何もしない', async () => {
    apiGet.mockResolvedValue({ email: 'tester@example.co.jp', external: false });

    expect(await hideStaffOnlyForExternalUsers()).toBe(false);
    expect(document.documentElement.dataset.account).toBeUndefined();
  });

  it('外部ユーザーかを答えない（古いバックエンド）なら、何もしない', async () => {
    apiGet.mockResolvedValue({ email: 'tester@example.co.jp' });

    expect(await hideStaffOnlyForExternalUsers()).toBe(false);
    expect(document.documentElement.dataset.account).toBeUndefined();
  });

  it('聞けなかったときは何もしない（入口が見えたままになるだけ）', async () => {
    apiGet.mockRejectedValue(
      Object.assign(new Error('サーバーエラーが発生しました (HTTP 503)。'), { status: 503 })
    );

    expect(await hideStaffOnlyForExternalUsers()).toBe(false);
    expect(document.documentElement.dataset.account).toBeUndefined();
  });

  it('どちらの許可リストにも無いアカウント（403）は、理由を投げる', async () => {
    const refused = Object.assign(
      new Error('このアプリは許可されたアカウント専用です（someone@gmail.com は利用できません）。'),
      { status: 403, code: 'account_not_allowed' }
    );
    apiGet.mockRejectedValue(refused);

    await expect(hideStaffOnlyForExternalUsers()).rejects.toBe(refused);
    // 社内専用の入口（「設定」など）も隠す。
    expect(document.documentElement.dataset.account).toBe('refused');
  });

  it('目印の無い 403（プロキシなど）は、使えないアカウントとは見なさない', async () => {
    apiGet.mockRejectedValue(
      Object.assign(new Error('サーバーエラーが発生しました (HTTP 403)。'), { status: 403 })
    );

    expect(await hideStaffOnlyForExternalUsers()).toBe(false);
  });

  it('5xx は一時的かもしれないので、何もしない（画面を閉じない）', async () => {
    apiGet.mockRejectedValue(
      Object.assign(new Error('サーバーエラーが発生しました (HTTP 500)。'), { status: 500 })
    );

    expect(await hideStaffOnlyForExternalUsers()).toBe(false);
  });

  it('隠すのは、印の付いた入口だけ（base.css の決めごと）', () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(resolve(process.cwd(), 'src/styles/base.css'), 'utf8');
    document.head.append(style);
    document.body.innerHTML = `
      <button id="staff" data-staff-only>Drive から選ぶ</button>
      <button id="open">手元の PDF を追加</button>`;
    const shown = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';

    // 社内ユーザー（印が無い）には、どちらも見える。
    expect([shown('staff'), shown('open')]).toEqual([true, true]);

    document.documentElement.dataset.account = 'external';
    expect([shown('staff'), shown('open')]).toEqual([false, true]);

    // 使えないアカウントにも見せない。
    document.documentElement.dataset.account = 'refused';
    expect([shown('staff'), shown('open')]).toEqual([false, true]);
    style.remove();
  });

  it('閉じた画面（#app[data-closed]）は、理由の欄だけを見せる（base.css の決めごと）', () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(resolve(process.cwd(), 'src/styles/base.css'), 'utf8');
    document.head.append(style);
    document.body.innerHTML = `
      <div id="app" data-closed>
        <button id="merge">結合</button>
        <div id="message">このアプリは許可されたアカウント専用です。</div>
      </div>`;
    const shown = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';

    // ツールが後から hidden を外しても、閉じたまま。
    document.getElementById('merge').hidden = false;
    expect([shown('merge'), shown('message')]).toEqual([false, true]);
    style.remove();
  });
});
