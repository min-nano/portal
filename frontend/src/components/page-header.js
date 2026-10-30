// ページ共通のヘッダー <portal-header>。
//
//   <portal-header class="portal-header" home></portal-header>
//
// ポータルのロゴと表示名、サインイン中のアカウント欄を出す。home 属性を
// 付けるとトップページへのリンクになる（トップページ自身では付けない）。
//
// ロゴと表示名は Firestore のサイト設定から来る（../site-settings.js が
// setSite で入れる）。入るまでは名前は空で、ロゴの場所には既定の四角を出す。
//
// ヘッダーは狭い画面でも常に 1 行に収める。アカウント欄はアバター（丸い顔
// 写真）だけにして、メールアドレス・設定・サインアウトはアバターに触れたとき
// （マウスなら重ねたとき、指ならタップしたとき）に開くメニューに入れる。
// 毎回見る必要のないものでヘッダーを 2 行にしないため。
//
// 中身は light DOM に作る。アカウント欄の id（accountArea / accountEmail /
// siteSettingsBtn / signOutBtn）は auth.js などが探すので、shadow DOM に隠さない。

const TAG = 'portal-header';

export class PortalHeader extends HTMLElement {
  connectedCallback() {
    if (this.dataset.ready) return;
    this.dataset.ready = 'true';
    const doc = this.ownerDocument;

    const title = doc.createElement('span');
    title.className = 'title';
    // ロゴ。画像が無ければ空のままにして、CSS が既定の四角を描く。
    const logo = doc.createElement('span');
    logo.className = 'site-logo';
    logo.id = 'siteLogo';
    // 長い名前は折り返さず、末尾を … で切る（ヘッダーを 1 行に保つ）。
    // 省いた分はツールチップで読めるようにする（setSite）。
    const name = doc.createElement(this.hasAttribute('home') ? 'a' : 'span');
    name.className = 'name';
    name.id = 'siteName';
    if (this.hasAttribute('home')) name.href = '/';
    title.append(logo, name);

    const account = doc.createElement('span');
    account.className = 'account';
    account.id = 'accountArea';
    account.hidden = true;

    const toggle = doc.createElement('button');
    toggle.type = 'button';
    toggle.className = 'account-toggle';
    toggle.id = 'accountToggle';
    toggle.setAttribute('aria-haspopup', 'true');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', 'accountMenu');
    toggle.setAttribute('aria-label', 'アカウント');
    // 写真が読めないときは、メールアドレスの頭文字を丸の中に出す。
    const initial = doc.createElement('span');
    initial.className = 'avatar-initial';
    initial.id = 'accountInitial';
    initial.setAttribute('aria-hidden', 'true');
    const avatar = doc.createElement('img');
    avatar.className = 'avatar';
    avatar.id = 'accountAvatar';
    avatar.alt = '';
    avatar.hidden = true;
    avatar.referrerPolicy = 'no-referrer';
    avatar.addEventListener('error', () => {
      avatar.hidden = true;
    });
    avatar.addEventListener('load', () => {
      avatar.hidden = false;
    });
    toggle.append(initial, avatar);

    const menu = doc.createElement('div');
    menu.className = 'account-menu';
    menu.id = 'accountMenu';
    const email = doc.createElement('span');
    email.className = 'account-email';
    email.id = 'accountEmail';
    // ポータル全体の設定（表示名・ロゴ）。押したときの動きは site-settings.js。
    const settings = doc.createElement('button');
    settings.type = 'button';
    settings.id = 'siteSettingsBtn';
    settings.className = 'secondary';
    settings.textContent = '設定';
    const signOut = doc.createElement('button');
    signOut.type = 'button';
    signOut.id = 'signOutBtn';
    signOut.textContent = 'サインアウト';
    menu.append(email, settings, signOut);

    account.append(toggle, menu);
    this.append(title, account);

    // タップ（とクリック・キーボード）で開け閉めする。マウスを重ねたときに
    // 開くのは CSS（:hover）の仕事で、ここでは扱わない。
    const setOpen = (open) => {
      account.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', String(open));
    };
    toggle.addEventListener('click', () => {
      setOpen(!account.classList.contains('open'));
    });
    // メニューの外（幕）に触れたら閉じるだけにする。そのクリックは下の
    // 本文へ渡さない（幕の下のリンクやボタンが、触れたつもりのないまま
    // 動かないように）。
    //
    // 閉じるのは pointerdown ではなく click で行う。指を置いた時点で閉じると
    // 幕がそこで消え、指を離したときの click が幕の下の要素に届いてしまう。
    // 捕捉段階で受けて、ほかの誰よりも先に止める。
    doc.addEventListener(
      'click',
      (event) => {
        if (!account.classList.contains('open') || account.contains(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      },
      true
    );
    account.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !account.classList.contains('open')) return;
      setOpen(false);
      toggle.focus();
    });
  }

  /** メニューを閉じる（メニューから設定画面を開くとき）。 */
  closeMenu() {
    this.querySelector('#accountArea')?.classList.remove('open');
    this.querySelector('#accountToggle')?.setAttribute('aria-expanded', 'false');
  }

  /**
   * ポータルのロゴと表示名を出す（site-settings.js が呼ぶ）。
   *
   * @param {{ title: string, logo?: string|null }} site logo は data: URL
   */
  setSite({ title, logo }) {
    const name = this.querySelector('#siteName');
    if (!name) return;
    name.textContent = title;
    this.querySelector('.title').title = title;
    const box = this.querySelector('#siteLogo');
    const current = box.querySelector('img');
    if (!logo) {
      box.replaceChildren();
    } else if (current?.getAttribute('src') !== logo) {
      const img = this.ownerDocument.createElement('img');
      img.alt = '';
      // 読めない画像なら、既定の四角に戻す。
      img.addEventListener('error', () => img.remove());
      img.src = logo;
      box.replaceChildren(img);
    }
  }

  /**
   * サインイン中のアカウントを出す（auth.js がサインインの確認後に呼ぶ）。
   *
   * @param {{ email: string, imageUrl?: string }} account
   */
  setAccount({ email, imageUrl }) {
    const area = this.querySelector('#accountArea');
    if (!area) return;
    this.querySelector('#accountEmail').textContent = email;
    this.querySelector('#accountInitial').textContent = (email[0] || '?').toUpperCase();
    this.querySelector('#accountToggle').setAttribute(
      'aria-label',
      email ? `アカウント（${email}）` : 'アカウント'
    );
    // 写真は読めてから出す（load で hidden を外す）。読めなければ頭文字のまま。
    if (imageUrl) this.querySelector('#accountAvatar').src = imageUrl;
    area.hidden = false;
  }
}

if (!customElements.get(TAG)) customElements.define(TAG, PortalHeader);
