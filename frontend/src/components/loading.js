// 読み込み中の表示 <portal-loading>。
//
//   <portal-loading id="pageLoading" class="page-loading">読み込んでいます…</portal-loading>
//
// 画面を開いてから使えるようになるまでには、サインインの確認（Clerk の
// 読み込みとセッションの問い合わせ）で数秒かかることがある。そのあいだ何も
// 出ないと「壊れている」ように見えるので、待っていることを必ず見せる。
//
// この部品は **JS を待たずに出る**のが仕事なので、ほかの部品と約束事が違う。
//
//   - 回る輪は CSS の擬似要素だけで描く（styles/components.css の .page-loading）。
//     部品が登録される前――スクリプトを 1 行も読み込む前――から出る。
//   - 文言は HTML に直接書く。読み込みの何を待っているかはページごとに違い、
//     ここで作ると部品の登録待ちになるため。
//
// JS 側の仕事は「終わったら消す」ことだけ（auth.js と各ページの start）。

const TAG = 'portal-loading';

/** ページの読み込み中の表示に使う id（各ページの HTML に置く）。 */
export const PAGE_LOADING_ID = 'pageLoading';

export const DEFAULT_LABEL = '読み込んでいます…';

export class PortalLoading extends HTMLElement {
  connectedCallback() {
    // 文言は HTML 側に置くのが基本。空のまま置かれたときだけ既定を入れる。
    if (!this.textContent.trim()) this.textContent = DEFAULT_LABEL;
    // 待ち終わりの差し替えを読み上げに伝える（role=status は polite の live 領域）。
    if (!this.hasAttribute('role')) this.setAttribute('role', 'status');
  }

  /** 読み込みが終わったので消す。 */
  done() {
    this.remove();
  }
}

/**
 * ページの読み込み中の表示を消す。
 * 画面（#app）かサインイン画面が出せるようになった時点で呼ぶ。
 *
 * @param {Document} [doc]
 */
export function finishPageLoading(doc = document) {
  doc.getElementById(PAGE_LOADING_ID)?.remove();
}

if (!customElements.get(TAG)) customElements.define(TAG, PortalLoading);
