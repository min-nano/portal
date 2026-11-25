// サインインゲート <portal-auth-gate>。
//
//   <portal-auth-gate id="authGate" class="auth-gate" hidden></portal-auth-gate>
//
// 未サインインのときだけ表示され、Clerk のサインイン画面をこの中
// （.clerk-mount）へマウントする（auth.js の requireSignIn）。
//
// id・class・hidden を HTML 側に残しているのは、部品が読み込まれる前
// （＝最初の描画）から隠しておくため。中身は light DOM に作る。

const TAG = 'portal-auth-gate';

// 社員も外部ユーザーも Google で入る。外部ユーザーを使わせる環境では、先に
// 管理者が Clerk にユーザーを作り、そのアドレスの Google アカウントで入る
// （README「外部ユーザー（組織外のアカウント）」）。どちらの環境でも誤りの
// ない言い方にする。
export const DEFAULT_NOTE =
  'Google アカウントでサインインしてください。サインインできない場合は、管理者にお問い合わせください。';

// Clerk のサインイン画面は、未サインインだと分かってから読み込む
// （auth.js の loadClerkUI）。描かれるまでのあいだ枠だけが空で残らないよう、
// マウント先に読み込み中の表示を置いておく（auth.js が消す）。
export const SIGN_IN_LOADING = 'サインイン画面を読み込んでいます…';

export class PortalAuthGate extends HTMLElement {
  connectedCallback() {
    if (this.dataset.ready) return;
    this.dataset.ready = 'true';
    const doc = this.ownerDocument;

    const note = doc.createElement('p');
    note.className = 'note';
    note.textContent = this.getAttribute('note') || DEFAULT_NOTE;
    const mount = doc.createElement('div');
    mount.className = 'clerk-mount';
    const loading = doc.createElement('portal-loading');
    loading.className = 'page-loading';
    loading.textContent = SIGN_IN_LOADING;
    mount.appendChild(loading);

    this.append(note, mount);
  }
}

if (!customElements.get(TAG)) customElements.define(TAG, PortalAuthGate);
