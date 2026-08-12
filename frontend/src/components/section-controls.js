// セクションの一括開閉 <portal-section-controls>。
//
//   <portal-section-controls for="calcForm"></portal-section-controls>
//
// for に指定した要素（省略時はページ全体）の中の <portal-section> を、
// まとめて開く／折り畳む。全部折り畳むと節の見出しだけが並ぶので、
// 入力したい箇所を探すときの目次になる。
//
// 中身は light DOM に作る。ページ側の CSS（styles.css）でそのまま整えられる
// ようにするため。

import { setSectionsOpen } from './collapsible-section.js';

const TAG = 'portal-section-controls';

export class PortalSectionControls extends HTMLElement {
  connectedCallback() {
    if (this.dataset.ready) return;
    this.dataset.ready = 'true';

    const expand = this.button('すべて展開', true);
    const collapse = this.button('すべて折りたたむ', false);
    this.append(expand, collapse);
  }

  button(text, open) {
    const button = this.ownerDocument.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = text;
    button.addEventListener('click', () => setSectionsOpen(this.scope(), open));
    return button;
  }

  /** 開け閉めする範囲。for が指す要素が無ければページ全体。 */
  scope() {
    const id = this.getAttribute('for');
    const target = id ? this.ownerDocument.getElementById(id) : null;
    return target || this.ownerDocument;
  }
}

if (!customElements.get(TAG)) customElements.define(TAG, PortalSectionControls);
