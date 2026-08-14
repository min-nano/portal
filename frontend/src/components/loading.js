// 読み込み中の表示 <portal-loading> と、画面を出すまでの見せ方。
//
//   <portal-loading id="pageLoading" class="page-loading">読み込んでいます…</portal-loading>
//
// 画面を開いてから使えるようになるまでには、
//
//   1. サインインの確認（Clerk の読み込みとセッションの問い合わせ）
//   2. ツールの準備（フォーム定義の取得と、計算実装（wasm）の読み込み）
//
// の 2 段があり、合わせて数秒かかることがある。そのあいだ何も出ないと
// 「壊れている」ように見えるので、待っていることを必ず見せる。
//
// この部品は **JS を待たずに出る**のが仕事なので、ほかの部品と約束事が違う。
//
//   - 回る輪は CSS の擬似要素だけで描く（styles/components.css の .page-loading）。
//     部品が登録される前――スクリプトを 1 行も読み込む前――から出る。
//   - 文言は HTML に直接書く。読み込みの何を待っているかはページごとに違い、
//     ここで作ると部品の登録待ちになるため。
//
// JS 側の仕事は 2 つ。段が変わったら文言を差し替えること
// （setPageLoadingLabel）と、使える状態になったら画面を出すこと（showApp）。
// 画面（#app）を出すのは**入力できるようになった時点**で、組み立て途中の
// フォームは見せない。

const TAG = 'portal-loading';

/** ページの読み込み中の表示に使う id（各ページの HTML に置く）。 */
export const PAGE_LOADING_ID = 'pageLoading';

/** ページ本体の id（各ページの HTML に置く。準備ができるまで hidden）。 */
export const APP_ID = 'app';

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
 * 待っているものが変わったので、文言を差し替える。
 * 「サインインを確認しています…」→「ツールの準備をしています…」のように、
 * **何を待っているか**を書く（role=status なので読み上げにも伝わる）。
 *
 * @param {string} label
 * @param {Document} [doc]
 */
export function setPageLoadingLabel(label, doc = document) {
  const loading = doc.getElementById(PAGE_LOADING_ID);
  if (loading) loading.textContent = label;
}

/**
 * ページの読み込み中の表示を消す。
 * サインイン画面を出すときや、待っても出てこないと分かったときに呼ぶ。
 * 画面（#app）を出すときは showApp() を使う。
 *
 * @param {Document} [doc]
 */
export function finishPageLoading(doc = document) {
  doc.getElementById(PAGE_LOADING_ID)?.remove();
}

/**
 * 画面（#app）を出して、読み込み中の表示を消す。
 * 入力できる状態になった時点――ツールならフォームを組み立て終えた時点――で
 * 呼ぶ。失敗して先に進めないときも、理由（#message）を見せるために呼ぶ。
 *
 * @param {Document} [doc]
 */
export function showApp(doc = document) {
  const app = doc.getElementById(APP_ID);
  if (app) app.hidden = false;
  finishPageLoading(doc);
}

if (!customElements.get(TAG)) customElements.define(TAG, PortalLoading);
