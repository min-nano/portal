// @vitest-environment jsdom
//
// ポータル全体の設定（表示名とロゴ）を画面に出す流れ（site-settings.js）。
//
// 前回の値をすぐ出してから読み直すこと、読めなくてもページが壊れないこと、
// タブの名前を変えるのは印を付けたページだけであることを固定する。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/components/index.js';
import {
  DEFAULT_PORTAL_TITLE,
  applySite,
  connectSiteSettingsMenu,
  normalizeSite,
  readCachedSite,
  resolvePortalTitle,
  showSite,
  writeCachedSite,
} from '../src/site-settings.js';

const openSiteSettings = vi.fn();
vi.mock('../src/site-settings-dialog.js', () => ({
  openSiteSettings: (doc) => openSiteSettings(doc),
}));

const LOGO = 'data:image/png;base64,iVBORw0KGgo=';

function respond(body, ok = true) {
  return vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body }));
}

function siteName() {
  return document.getElementById('siteName').textContent;
}

beforeEach(() => {
  localStorage.clear();
  document.head.innerHTML = '<title data-site-title=""></title>';
  document.body.innerHTML = '<portal-header class="portal-header"></portal-header>';
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolvePortalTitle', () => {
  it('設定されていればその値、空白だけ・未設定なら既定値', () => {
    expect(resolvePortalTitle(' ○○建築設計事務所 ')).toBe('○○建築設計事務所');
    expect(resolvePortalTitle('')).toBe(DEFAULT_PORTAL_TITLE);
    expect(resolvePortalTitle('   ')).toBe(DEFAULT_PORTAL_TITLE);
    expect(resolvePortalTitle(undefined)).toBe(DEFAULT_PORTAL_TITLE);
    expect(resolvePortalTitle(null)).toBe(DEFAULT_PORTAL_TITLE);
  });
});

describe('normalizeSite', () => {
  it('壊れた値は未設定とみなす（画像でない data: URL もロゴにしない）', () => {
    expect(normalizeSite(null)).toEqual({ title: '', logo: null });
    expect(normalizeSite({ title: 3, logo: 'javascript:alert(1)' })).toEqual({
      title: '',
      logo: null,
    });
    expect(normalizeSite({ title: 'a', logo: LOGO })).toEqual({ title: 'a', logo: LOGO });
  });
});

describe('この端末に覚える値', () => {
  it('書いたものを読み戻せる。無い・壊れていれば null', () => {
    expect(readCachedSite()).toBeNull();
    writeCachedSite({ title: '設計室', logo: LOGO });
    expect(readCachedSite()).toEqual({ title: '設計室', logo: LOGO });

    localStorage.setItem('portal.site', '{壊れた');
    expect(readCachedSite()).toBeNull();
  });

  it('保存先が使えなくても落ちない', () => {
    const broken = {
      getItem() {
        throw new Error('denied');
      },
      setItem() {
        throw new Error('quota');
      },
    };
    expect(readCachedSite(broken)).toBeNull();
    expect(() => writeCachedSite({ title: 'x' }, broken)).not.toThrow();
  });
});

describe('applySite', () => {
  it('ヘッダーの名前・ロゴと、トップページのタブの名前を変える', () => {
    applySite({ title: '設計室', logo: LOGO });

    expect(siteName()).toBe('設計室');
    expect(document.querySelector('#siteLogo img').getAttribute('src')).toBe(LOGO);
    expect(document.title).toBe('設計室');
  });

  it('ページ名のあるページは「ページ名 | 表示名」にする', () => {
    document.head.innerHTML = '<title data-site-title="デザインシステム">デザインシステム</title>';

    applySite({ title: '' });

    expect(document.title).toBe(`デザインシステム | ${DEFAULT_PORTAL_TITLE}`);
    expect(siteName()).toBe(DEFAULT_PORTAL_TITLE);
  });

  it('印の無いページ（ツール）のタブの名前は変えない', () => {
    document.head.innerHTML = '<title>面材張り大壁 計算ツール</title>';

    applySite({ title: '設計室' });

    expect(document.title).toBe('面材張り大壁 計算ツール');
    expect(siteName()).toBe('設計室');
  });
});

describe('showSite', () => {
  it('覚えている値をすぐ出し、読み直した値で置き換えて覚え直す', async () => {
    writeCachedSite({ title: '前の名前', logo: null });
    const fetch = respond({ title: '新しい名前', logo: LOGO });
    vi.stubGlobal('fetch', fetch);

    const done = showSite();
    // 読み込みを待たずに、覚えている値が入っている。
    expect(siteName()).toBe('前の名前');

    await done;
    expect(fetch).toHaveBeenCalledWith('/api/site', { cache: 'no-store' });
    expect(siteName()).toBe('新しい名前');
    expect(readCachedSite()).toEqual({ title: '新しい名前', logo: LOGO });
  });

  it('読めなければ、覚えている値のまま', async () => {
    writeCachedSite({ title: '前の名前', logo: LOGO });
    vi.stubGlobal('fetch', respond({}, false));

    await showSite();

    expect(siteName()).toBe('前の名前');
    expect(document.querySelector('#siteLogo img')).not.toBeNull();
  });

  it('初めての端末で読めなければ、既定の名前を出す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline');
      })
    );

    const done = showSite();
    expect(siteName()).toBe('');
    await done;

    expect(siteName()).toBe(DEFAULT_PORTAL_TITLE);
    expect(readCachedSite()).toBeNull();
  });
});

describe('connectSiteSettingsMenu', () => {
  it('「設定」でメニューを閉じて、設定画面を開く', async () => {
    connectSiteSettingsMenu();
    document.getElementById('accountToggle').click();

    document.getElementById('siteSettingsBtn').click();

    expect(document.getElementById('accountArea').classList.contains('open')).toBe(false);
    // 設定画面は押されてから読み込むので、開くのは読み込みのあと。
    await vi.waitFor(() => expect(openSiteSettings).toHaveBeenCalledWith(document));
  });

  it('ヘッダーの無いページでは何もしない', () => {
    document.body.innerHTML = '';
    expect(() => connectSiteSettingsMenu()).not.toThrow();
  });
});
