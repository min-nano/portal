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

export const DEFAULT_NOTE = '社内の Google アカウントでサインインしてください。';

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

    this.append(note, mount);
  }
}

if (!customElements.get(TAG)) customElements.define(TAG, PortalAuthGate);
