// @vitest-environment jsdom
//
// サイトの設定画面（site-settings-dialog.js）。
//
// 開くと今の設定が入ること、PNG・SVG 以外や大きすぎる画像は送る前に断ること、
// 保存したらこのページのヘッダーにもすぐ出ることを固定する。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/components/index.js';

const apiSendJson = vi.fn();
vi.mock('../src/api.js', () => ({
  apiSendJson: (...args) => apiSendJson(...args),
}));

const {
  MAX_LOGO_BYTES,
  logoDataUrl,
  logoFileProblem,
  logoMimeType,
  openSiteSettings,
} = await import('../src/site-settings-dialog.js');
const { readCachedSite } = await import('../src/site-settings.js');

// jsdom の <dialog> には showModal / close が無い。開閉の印だけを真似る。
HTMLDialogElement.prototype.showModal = function showModal() {
  this.open = true;
};
HTMLDialogElement.prototype.close = function close() {
  this.open = false;
};

const PNG_LOGO = 'data:image/png;base64,iVBORw0KGgo=';
const SVG_TEXT = '<svg xmlns="http://www.w3.org/2000/svg"/>';

const $ = (id) => document.getElementById(id);

function stubSite(site) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => site }))
  );
}

/** ファイルを選んだことにする。 */
function choose(file) {
  Object.defineProperty($('siteLogoInput'), 'files', { value: [file], configurable: true });
  $('siteLogoInput').dispatchEvent(new Event('change'));
}

beforeEach(() => {
  localStorage.clear();
  document.head.innerHTML = '<title data-site-title=""></title>';
  document.body.innerHTML = '<portal-header class="portal-header"></portal-header>';
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('ロゴのファイルの確かめ', () => {
  it('PNG と SVG だけを受け付ける（種類が空なら拡張子で見る）', () => {
    expect(logoMimeType({ name: 'a.png', type: 'image/png' })).toBe('image/png');
    expect(logoMimeType({ name: 'a.svg', type: '' })).toBe('image/svg+xml');
    expect(logoMimeType({ name: 'A.SVG', type: '' })).toBe('image/svg+xml');
    expect(logoMimeType({ name: 'a.jpg', type: 'image/jpeg' })).toBeNull();
    expect(logoMimeType({ name: 'logo', type: '' })).toBeNull();
  });

  it('大きすぎる画像と、種類の違うファイルを断る', () => {
    expect(logoFileProblem({ name: 'a.png', type: 'image/png', size: MAX_LOGO_BYTES })).toBeNull();
    expect(
      logoFileProblem({ name: 'a.png', type: 'image/png', size: MAX_LOGO_BYTES + 1 })
    ).toContain('256KB');
    expect(logoFileProblem({ name: 'a.gif', type: 'image/gif', size: 10 })).toContain(
      'PNG か SVG'
    );
  });

  it('data: URL にする（種類は拡張子から補う）', async () => {
    const file = new File([SVG_TEXT], 'logo.svg', { type: '' });

    expect(await logoDataUrl(file)).toBe(`data:image/svg+xml;base64,${btoa(SVG_TEXT)}`);
  });
});

describe('openSiteSettings', () => {
  it('開くと今の設定を読み直して入れる', async () => {
    stubSite({ title: '設計室', logo: PNG_LOGO });

    await openSiteSettings();

    expect($('siteSettingsDialog').open).toBe(true);
    expect($('siteTitleInput').value).toBe('設計室');
    expect($('siteTitleInput').disabled).toBe(false);
    expect($('siteLogoPreview').querySelector('img').getAttribute('src')).toBe(PNG_LOGO);
    expect($('siteLogoRemoveBtn').disabled).toBe(false);
    // 読み直した値はヘッダーにも出る。
    expect($('siteName').textContent).toBe('設計室');
  });

  it('今の設定を読めなければ、保存させずに理由を出す', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));

    await openSiteSettings();

    expect($('siteSettingsSaveBtn').disabled).toBe(true);
    expect($('siteSettingsMessage').textContent).toContain('読み込めませんでした');
  });

  it('画像を選んで保存すると、ヘッダーとタブの名前にすぐ出て、端末にも覚える', async () => {
    stubSite({ title: '', logo: null });
    await openSiteSettings();
    expect($('siteLogoState').textContent).toBe('未設定');
    expect($('siteLogoRemoveBtn').disabled).toBe(true);

    choose(new File([SVG_TEXT], 'logo.svg', { type: 'image/svg+xml' }));
    const svgLogo = `data:image/svg+xml;base64,${btoa(SVG_TEXT)}`;
    await vi.waitFor(() =>
      expect($('siteLogoPreview').querySelector('img')?.getAttribute('src')).toBe(svgLogo)
    );
    $('siteTitleInput').value = '  設計室ポータル ';
    apiSendJson.mockResolvedValue({ title: '設計室ポータル', logo: svgLogo });

    $('siteSettingsSaveBtn').click();
    await vi.waitFor(() => expect($('siteSettingsDialog').open).toBe(false));

    expect(apiSendJson).toHaveBeenCalledWith('/api/site', 'PUT', {
      title: '設計室ポータル',
      logo: svgLogo,
    });
    expect($('siteName').textContent).toBe('設計室ポータル');
    expect(document.querySelector('#siteLogo img').getAttribute('src')).toBe(svgLogo);
    expect(document.title).toBe('設計室ポータル');
    expect(readCachedSite()).toEqual({ title: '設計室ポータル', logo: svgLogo });
  });

  it('受け付けない画像は送らずに理由を出す', async () => {
    stubSite({ title: '', logo: null });
    await openSiteSettings();

    choose(new File(['GIF89a'], 'logo.gif', { type: 'image/gif' }));

    expect($('siteSettingsMessage').textContent).toContain('PNG か SVG');
    expect($('siteLogoPreview').children).toHaveLength(0);
  });

  it('「外す」で、ロゴなしとして保存する', async () => {
    stubSite({ title: '設計室', logo: PNG_LOGO });
    await openSiteSettings();
    apiSendJson.mockResolvedValue({ title: '設計室', logo: null });

    $('siteLogoRemoveBtn').click();
    expect($('siteLogoPreview').children).toHaveLength(0);
    $('siteSettingsSaveBtn').click();
    await vi.waitFor(() => expect($('siteSettingsDialog').open).toBe(false));

    expect(apiSendJson).toHaveBeenCalledWith('/api/site', 'PUT', { title: '設計室', logo: null });
    expect(document.querySelector('#siteLogo img')).toBeNull();
  });

  it('保存に失敗したら、閉じずに理由を出す', async () => {
    stubSite({ title: '設計室', logo: null });
    await openSiteSettings();
    apiSendJson.mockRejectedValue(new Error('ロゴには PNG か SVG の画像を選んでください。'));

    $('siteSettingsSaveBtn').click();
    await vi.waitFor(() => expect($('siteSettingsMessage').textContent).not.toBe(''));

    expect($('siteSettingsDialog').open).toBe(true);
    expect($('siteSettingsSaveBtn').disabled).toBe(false);
  });

  it('キャンセルは何も保存せずに閉じる。開き直しても画面は 1 つ', async () => {
    stubSite({ title: '設計室', logo: null });
    await openSiteSettings();
    $('siteTitleInput').value = '書きかけ';

    $('siteSettingsCancelBtn').click();
    expect($('siteSettingsDialog').open).toBe(false);
    expect(apiSendJson).not.toHaveBeenCalled();

    await openSiteSettings();
    expect(document.querySelectorAll('#siteSettingsDialog')).toHaveLength(1);
    // 書きかけは残さず、今の設定を入れ直す。
    expect($('siteTitleInput').value).toBe('設計室');
  });
});
