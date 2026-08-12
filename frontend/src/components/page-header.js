// ページ共通のヘッダー <portal-header>。
//
//   <portal-header class="portal-header" portal-name="%PORTAL_TITLE%" home></portal-header>
//
// ポータルの表示名（ビルド時に vite が %PORTAL_TITLE% を差し替える）と、
// サインイン中のアカウント欄を出す。home 属性を付けるとトップページへの
// リンクになる（トップページ自身では付けない）。
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
    if (this.hasAttribute('home')) {
      const link = doc.createElement('a');
      link.href = '/';
      link.textContent = name;
      title.appendChild(link);
    } else {
      title.textContent = name;
    }

    const account = doc.createElement('span');
    account.className = 'account';
    account.id = 'accountArea';
    account.hidden = true;
    const email = doc.createElement('span');
    email.id = 'accountEmail';
    const signOut = doc.createElement('button');
    signOut.type = 'button';
    signOut.id = 'signOutBtn';
    signOut.textContent = 'サインアウト';
    account.append(email, signOut);

    this.append(title, account);
  }
}

if (!customElements.get(TAG)) customElements.define(TAG, PortalHeader);
