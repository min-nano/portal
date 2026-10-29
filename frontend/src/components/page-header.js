// ページ共通のヘッダー <portal-header>。
//
//   <portal-header class="portal-header" portal-name="%PORTAL_TITLE%" home></portal-header>
//
// ポータルの表示名（ビルド時に vite が %PORTAL_TITLE% を差し替える）と、
// サインイン中のアカウント欄を出す。home 属性を付けるとトップページへの
// リンクになる（トップページ自身では付けない）。
//
// ヘッダーは狭い画面でも常に 1 行に収める。アカウント欄はアバター（丸い顔
// 写真）だけにして、メールアドレスとサインアウトはアバターに触れたとき
// （マウスなら重ねたとき、指ならタップしたとき）に開くメニューに入れる。
// 毎回見る必要のないものでヘッダーを 2 行にしないため。
//
// 中身は light DOM に作る。アカウント欄の id（accountArea / accountEmail /
// signOutBtn）は auth.js が探すので、shadow DOM に隠さない。

const TAG = 'portal-header';

export class PortalHeader extends HTMLElement {
  connectedCallback() {
    if (this.dataset.ready) return;
    this.dataset.ready = 'true';
    const doc = this.ownerDocument;

    const title = doc.createElement('span');
    title.className = 'title';
    const name = this.getAttribute('portal-name') || '';
    // 長い名前は折り返さず、末尾を … で切る（ヘッダーを 1 行に保つ）。
    // 省いた分はツールチップで読めるようにする。
    title.title = name;
    if (this.hasAttribute('home')) {
      const link = doc.createElement('a');
      link.href = '/';
      link.className = 'name';
      link.textContent = name;
      title.appendChild(link);
    } else {
      const text = doc.createElement('span');
      text.className = 'name';
      text.textContent = name;
      title.appendChild(text);
    }

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
    const signOut = doc.createElement('button');
    signOut.type = 'button';
    signOut.id = 'signOutBtn';
    signOut.textContent = 'サインアウト';
    menu.append(email, signOut);

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
