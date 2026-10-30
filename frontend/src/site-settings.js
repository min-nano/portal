// ポータル全体の設定（表示名とロゴ）を画面に出す。
//
// 設定は Firestore にあり、設定画面（site-settings-dialog.js）から変える。
// 以前はビルド時の環境変数で HTML に埋め込んでいたが、変えるたびに再デプロイが
// 要ったため、実行時に /api/site から読むようにした（backend/app/site_settings.py）。
//
// 読み込むまでのあいだ前の名前（や空欄）がちらつかないよう、最後に読めた値を
// この端末に覚えておき、ページを開いたら**まずそれを出してから**読み直す。
// ヘッダーは JS が組み立てるまで中身が無いので、同じ流れの中で覚えた値を
// 入れれば、初めて描かれるときにはもう正しい名前が入っている。
//
// /api/site はサインイン前でも読める（サインイン画面のヘッダーにも出すため）。
// ここは認証（auth.js）を読み込まない。設定を保存する側だけが認証を使う。

export const DEFAULT_PORTAL_TITLE = '社内ポータル';

const CACHE_KEY = 'portal.site';

/**
 * 設定の表示名からポータルの表示名を決める。未設定・空白のみなら既定値。
 *
 * @param {string|undefined|null} value
 * @return {string}
 */
export function resolvePortalTitle(value) {
  const trimmed = (value || '').trim();
  return trimmed || DEFAULT_PORTAL_TITLE;
}

/**
 * 受け取った値を { title, logo } に整える（壊れた値は未設定とみなす）。
 *
 * @param {unknown} value
 * @return {{ title: string, logo: string|null }}
 */
export function normalizeSite(value) {
  const site = value && typeof value === 'object' ? value : {};
  return {
    title: typeof site.title === 'string' ? site.title : '',
    logo:
      typeof site.logo === 'string' && site.logo.startsWith('data:image/') ? site.logo : null,
  };
}

/** この端末に覚えている設定。無ければ（読めなければ）null。 */
export function readCachedSite(storage = globalThis.localStorage) {
  try {
    const text = storage?.getItem(CACHE_KEY);
    return text ? normalizeSite(JSON.parse(text)) : null;
  } catch {
    return null;
  }
}

export function writeCachedSite(site, storage = globalThis.localStorage) {
  try {
    storage?.setItem(CACHE_KEY, JSON.stringify(normalizeSite(site)));
  } catch {
    // 覚えられなくても、毎回読み直すだけで困らない（容量超過・プライベートモード）。
  }
}

/**
 * 設定をページに出す（ヘッダーの名前とロゴ、タブの名前）。
 *
 * タブの名前を変えるのは <title data-site-title="ページ名"> と書いたページだけ
 * （トップページは表示名そのもの、それ以外は「ページ名 | 表示名」）。ツールの
 * ページはツールの名前だけをタブに出すので、印を付けていない。
 *
 * @param {{ title?: string, logo?: string|null }} site
 */
export function applySite(site, doc = document) {
  const { title, logo } = normalizeSite(site);
  const name = resolvePortalTitle(title);
  doc.querySelector('portal-header')?.setSite?.({ title: name, logo });
  const titleEl = doc.querySelector('title[data-site-title]');
  if (titleEl) {
    const page = titleEl.dataset.siteTitle;
    titleEl.textContent = page ? `${page} | ${name}` : name;
  }
}

/** /api/site から読み直して、覚え直し、ページに出す。 */
export async function loadSite(doc = document) {
  // no-store: 設定画面で変えた直後にも、新しい値が届くように。
  const resp = await fetch('/api/site', { cache: 'no-store' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const site = normalizeSite(await resp.json());
  writeCachedSite(site);
  applySite(site, doc);
  return site;
}

/**
 * ページを開いたときに呼ぶ。覚えている値をすぐ出し、裏で読み直す。
 *
 * 読めなかったときは、覚えている値のまま（初めての端末なら既定の名前）にする。
 * ポータルの名前が出ないことで、ツールが使えなくなってはいけないため。
 */
export function showSite(doc = document) {
  const cached = readCachedSite();
  if (cached) applySite(cached, doc);
  return loadSite(doc).catch(() => {
    if (!cached) applySite({}, doc);
  });
}

/**
 * アカウントのメニューの「設定」を、設定画面につなぐ（サインイン後に呼ぶ）。
 *
 * 設定画面は滅多に開かないので、押されてから読み込む（ふだんのページの
 * 読み込みを重くしない）。
 */
export function connectSiteSettingsMenu(doc = document) {
  const button = doc.getElementById('siteSettingsBtn');
  if (!button) return;
  button.addEventListener('click', async () => {
    doc.querySelector('portal-header')?.closeMenu?.();
    const { openSiteSettings } = await import('./site-settings-dialog.js');
    await openSiteSettings(doc);
  });
}
