// @vitest-environment jsdom
//
// PDF 結合ツール: 結合した PDF を、付けた名前のまま端末に保存する
// （save-file.js）。パソコンは名前付きのダウンロード、iPhone・iPad・Android は
// 共有シート（Safari はページの中で作った PDF をプレビューで開き、名前を
// 落とすことがあるため）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isMobile, saveMethod, savePdf, SHARE_LIMIT } from '../src/pdf-book-merger/save-file.js';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const bytes = new Uint8Array([37, 80, 68, 70]);

let clicked;

beforeEach(() => {
  clicked = [];
  URL.createObjectURL = vi.fn(() => 'blob:pdf');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() {
    clicked.push({ href: this.href, download: this.download });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isMobile', () => {
  it.each([
    [{ userAgent: IPHONE }, true],
    [{ userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile' }, true],
    // iPad の Safari は Mac を名乗る（タッチで見分ける）。
    [{ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 5 }, true],
    [{ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 0 }, false],
    [{ userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120' }, false],
    [undefined, false],
  ])('%j → %s', (nav, expected) => {
    expect(isMobile(nav)).toBe(expected);
  });
});

describe('saveMethod', () => {
  it('iPhone では共有シートに渡すが、大きなファイルは Service Worker を通してダウンロードする（共有シートに渡すと、Safari が中身をまるごとページのメモリに読む）', () => {
    const iphone = { userAgent: IPHONE };
    expect(saveMethod(SHARE_LIMIT, iphone)).toBe('share');
    expect(saveMethod(SHARE_LIMIT + 1, iphone)).toBe('worker');
    // 615 MB（1 頁のファイル 492 個を結合した PDF）は、共有シートに渡すとページごと落ちた。
    expect(saveMethod(615 * 1024 * 1024, iphone)).toBe('worker');
    // パソコンは、大きさに関わらずダウンロード。
    expect(saveMethod(1, { userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 0 })).toBe('download');
  });
});

describe('savePdf', () => {
  it('パソコンでは、付けた名前でダウンロードする', async () => {
    const nav = { userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 0, share: vi.fn(), canShare: () => true };

    expect(await savePdf(bytes, '吾輩は猫である.pdf', nav)).toBe('downloaded');

    expect(nav.share).not.toHaveBeenCalled();
    expect(clicked).toEqual([{ href: 'blob:pdf', download: '吾輩は猫である.pdf' }]);
    const [file] = URL.createObjectURL.mock.calls[0];
    expect([file.name, file.type, file.size]).toEqual(['吾輩は猫である.pdf', 'application/pdf', 4]);
  });

  it('iPhone では、付けた名前のファイルを共有シートに渡す', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const nav = { userAgent: IPHONE, share, canShare: ({ files }) => files.length === 1 };

    expect(await savePdf(bytes, '吾輩は猫である.pdf', nav)).toBe('shared');

    // ファイルだけを渡す（title を添えると、iOS は「テキスト.txt」も一緒に渡す）。
    const [shared] = share.mock.calls[0];
    expect(Object.keys(shared)).toEqual(['files']);
    const { files } = shared;
    expect([files[0].name, files[0].type]).toEqual(['吾輩は猫である.pdf', 'application/pdf']);
    expect(clicked).toEqual([]);
  });

  it('共有シートを閉じただけなら何もしない。開けなければダウンロードする', async () => {
    const abort = Object.assign(new Error('canceled'), { name: 'AbortError' });
    const nav = { userAgent: IPHONE, share: vi.fn().mockRejectedValue(abort), canShare: () => true };
    expect(await savePdf(bytes, 'a.pdf', nav)).toBe('cancelled');
    expect(clicked).toEqual([]);

    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    nav.share.mockRejectedValue(denied);
    expect(await savePdf(bytes, 'a.pdf', nav)).toBe('downloaded');
    expect(clicked).toEqual([{ href: 'blob:pdf', download: 'a.pdf' }]);
  });

  it('ファイルを共有できない端末では、ダウンロードする', async () => {
    const nav = { userAgent: IPHONE, share: vi.fn(), canShare: () => false };
    expect(await savePdf(bytes, 'a.pdf', nav)).toBe('downloaded');
    expect(nav.share).not.toHaveBeenCalled();

    expect(await savePdf(bytes, 'b.pdf', { userAgent: IPHONE })).toBe('downloaded');
    expect(clicked.map((c) => c.download)).toEqual(['a.pdf', 'b.pdf']);
  });
});

/**
 * Service Worker の偽物。active なら登録したらすぐ動いている。そうでなければ
 * installing のまま（settle で状態を変える）。reply が false なら PDF を受け取らない。
 */
function fakeServiceWorker({ active = true, reply = true, slot = 'installing' } = {}) {
  const listeners = [];
  const posted = [];
  const worker = {
    state: active ? 'activated' : 'installing',
    addEventListener: (type, listener) => listeners.push(listener),
    postMessage: (data, [port]) => {
      posted.push(data);
      if (reply) port.postMessage('ready');
    },
  };
  const register = vi.fn(async () => (active ? { active: worker } : { [slot]: worker }));
  return {
    serviceWorker: { register },
    register,
    posted,
    settle(state) {
      worker.state = state;
      listeners.forEach((listener) => listener());
    },
  };
}

describe('大きな PDF を Service Worker を通して保存する', () => {
  it('PDF を Service Worker に渡し、download を付けずにそのアドレスを開く（Service Worker が attachment で返す）', async () => {
    const sw = fakeServiceWorker();
    const nav = { userAgent: IPHONE, share: vi.fn(), canShare: () => true, serviceWorker: sw.serviceWorker };

    expect(await savePdf(bytes, '木造住宅関連資材カタログ5.pdf', nav, 'worker')).toBe('downloaded');

    expect(nav.share).not.toHaveBeenCalled();
    const [script, { scope }] = sw.register.mock.calls[0];
    expect(script).toMatch(/\/download-worker\.js/);
    expect(scope).toBe(new URL('./pdf-download/', script).href);
    const [{ id, file }] = sw.posted;
    expect([file.name, file.type, file.size]).toEqual(['木造住宅関連資材カタログ5.pdf', 'application/pdf', 4]);
    expect(clicked).toEqual([{ href: `${scope}${id}`, download: '' }]);
    // ページの中に blob: の URL は作らない（作ったページが閉じると消える）。
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('登録したばかりの Service Worker は、動き出すのを待ってから渡す。動かせなければ失敗にする', async () => {
    const sw = fakeServiceWorker({ active: false });
    const nav = { userAgent: IPHONE, serviceWorker: sw.serviceWorker };
    const saving = savePdf(bytes, 'a.pdf', nav, 'worker');
    await vi.waitFor(() => expect(sw.register).toHaveBeenCalled());
    sw.settle('installed'); // まだ動いていない
    expect(sw.posted).toEqual([]);
    sw.settle('activated');
    expect(await saving).toBe('downloaded');
    expect(sw.posted).toHaveLength(1);

    // 入れ終えて、動き出す直前（waiting）のこともある。
    const waiting = fakeServiceWorker({ active: false, slot: 'waiting' });
    const later = savePdf(bytes, 'c.pdf', { userAgent: IPHONE, serviceWorker: waiting.serviceWorker }, 'worker');
    await vi.waitFor(() => expect(waiting.register).toHaveBeenCalled());
    waiting.settle('activated');
    expect(await later).toBe('downloaded');

    const broken = fakeServiceWorker({ active: false });
    const failing = savePdf(bytes, 'b.pdf', { userAgent: IPHONE, serviceWorker: broken.serviceWorker }, 'worker');
    await vi.waitFor(() => expect(broken.register).toHaveBeenCalled());
    broken.settle('redundant');
    await expect(failing).rejects.toThrow('Service Worker を動かせませんでした');
  });

  it('Service Worker を使えない・受け取らないときは失敗にする（共有シートにもダウンロードにも替えない）', async () => {
    const share = vi.fn();
    await expect(savePdf(bytes, 'a.pdf', { userAgent: IPHONE, share, canShare: () => true }, 'worker')).rejects.toThrow(
      'このブラウザは Service Worker を使えません'
    );

    vi.useFakeTimers();
    try {
      const silent = fakeServiceWorker({ reply: false });
      const saving = savePdf(bytes, 'a.pdf', { userAgent: IPHONE, serviceWorker: silent.serviceWorker }, 'worker');
      const failed = expect(saving).rejects.toThrow('Service Worker が PDF を受け取りませんでした');
      await vi.advanceTimersByTimeAsync(10 * 1000);
      await failed;
    } finally {
      vi.useRealTimers();
    }
    expect(share).not.toHaveBeenCalled();
    expect(clicked).toEqual([]);
  });
});
