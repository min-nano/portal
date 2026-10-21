// @vitest-environment jsdom
//
// 書籍スキャン PDF 結合ツール: 結合した PDF を、付けた名前のまま端末に保存する
// （save-file.js）。パソコンは名前付きのダウンロード、iPhone・iPad・Android は
// 共有シート（Safari はページの中で作った PDF をプレビューで開き、名前を
// 落とすことがあるため）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isMobile, savePdf } from '../src/pdf-book-merger/save-file.js';

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
