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
    apiGet.mockRejectedValue(new Error('サーバーエラーが発生しました (HTTP 503)。'));

    expect(await hideStaffOnlyForExternalUsers()).toBe(false);
    expect(document.documentElement.dataset.account).toBeUndefined();
  });

  it('どちらの許可リストにも無いアカウント（403）は、理由を投げる', async () => {
    const refused = Object.assign(
      new Error('このアプリは許可されたアカウント専用です（someone@gmail.com は利用できません）。'),
      { status: 403 }
    );
    apiGet.mockRejectedValue(refused);

    await expect(hideStaffOnlyForExternalUsers()).rejects.toBe(refused);
    expect(document.documentElement.dataset.account).toBeUndefined();
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
    style.remove();
  });
});
