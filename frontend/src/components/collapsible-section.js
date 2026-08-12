// 折り畳めるセクション <portal-section>。
//
// 入力・計算内容が増えても目的の入力欄を探しやすいよう、各ページの節を
// 見出しの行で開け閉めできるようにする部品。
//
//   <portal-section class="cert-section">
//     <h3 slot="title">物件</h3>
//     <button type="button" slot="actions">この面材を削除</button>
//     …中身…
//   </portal-section>
//
// 見出し（slot="title"）と操作ボタン（slot="actions"）は light DOM のまま
// 置く。shadow DOM に取り込むと、ページ側の CSS が当たらなくなるうえ、
// aria-labelledby（構造計算安全証明書の節 → その中の入力欄）が境界を越えられ
// なくなるため。開け閉めの仕組み（見出しの行・つまみ）だけを shadow DOM に
// 持たせて、ページ側の button 一括指定（幅 100% の青いボタン）から守る。
//
// 既定は「開いている」状態で、collapsed 属性が付いているあいだだけ折り畳む。
// 属性を書き忘れても中身が消えない側に倒してある（<details> の open とは逆）。

const TAG = 'portal-section';

// 見出しの行の中で押されても開け閉めしないもの（操作ボタン・入力欄など）。
const INTERACTIVE = 'a, button, input, select, textarea, label, summary, [contenteditable]';

const STYLE = `
  :host { display: block; }
  :host([hidden]) { display: none; }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
  }
  .toggle {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.7em;
    height: 1.7em;
    margin: 0;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: #1a3a8f;
    cursor: pointer;
    font: inherit;
  }
  .toggle:hover { background: rgba(26, 58, 143, 0.1); }
  .toggle:focus-visible { outline: 2px solid #4285f4; outline-offset: 1px; }
  .chevron { transform: rotate(-90deg); transition: transform 0.12s ease; }
  :host(:not([collapsed])) .chevron { transform: none; }
  @media (prefers-reduced-motion: reduce) {
    .chevron { transition: none; }
  }
  .title { flex: 1 1 auto; min-width: 0; }
  .actions { flex: none; display: flex; align-items: center; gap: 6px; }
  .body { display: block; }
  :host([collapsed]) .body { display: none; }
`;

const CHEVRON =
  '<svg class="chevron" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">' +
  '<path d="M1.5 4 L6 8.5 L10.5 4" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round"></path></svg>';

const CONTENT =
  `<div class="head" part="head">` +
  `<button class="toggle" part="toggle" type="button" aria-expanded="true">${CHEVRON}</button>` +
  `<div class="title" part="title"><slot name="title"></slot></div>` +
  `<div class="actions" part="actions"><slot name="actions"></slot></div>` +
  `</div>` +
  `<div class="body" part="body"><slot></slot></div>`;

/** 押された場所が、開け閉めではなくその部品自身への操作かどうか。 */
function isInteractive(event, head) {
  return event.composedPath().some((node) => {
    if (node === head) return false;
    return node.nodeType === 1 && node.matches && node.matches(INTERACTIVE);
  });
}

/** 見出しに出す名前（label 属性 > slot="title" の文字）。 */
function titleTextOf(section) {
  const label = section.getAttribute('label');
  if (label) return label;
  // 入れ子のセクションの見出しを拾わないよう、直下だけを見る。
  const slotted = section.querySelector(':scope > [slot="title"]');
  return slotted ? slotted.textContent.trim() : '';
}

export class PortalSection extends HTMLElement {
  static get observedAttributes() {
    return ['collapsed', 'label'];
  }

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${STYLE}</style>${CONTENT}`;
    this.head = shadow.querySelector('.head');
    this.toggleButton = shadow.querySelector('.toggle');

    this.toggleButton.addEventListener('click', () => this.toggle());
    // 見出しの行はどこを押しても開け閉めできる。ただし操作ボタンや、
    // 見出しに並べた入力欄（部屋の階数・部屋名）はそのまま使えるようにする。
    this.head.addEventListener('click', (event) => {
      if (isInteractive(event, this.head)) return;
      this.toggle();
    });
    shadow
      .querySelector('slot[name="title"]')
      .addEventListener('slotchange', () => this.syncLabel());
  }

  connectedCallback() {
    this.sync();
  }

  attributeChangedCallback() {
    this.sync();
  }

  /** 開いているか。 */
  get open() {
    return !this.hasAttribute('collapsed');
  }

  set open(value) {
    if (value) {
      this.removeAttribute('collapsed');
    } else {
      this.setAttribute('collapsed', '');
    }
  }

  toggle() {
    this.open = !this.open;
    // 開け閉めを外から拾えるようにする（自動スクロールの調整など）。
    this.dispatchEvent(
      new CustomEvent('section-toggle', { bubbles: true, detail: { open: this.open } })
    );
  }

  sync() {
    this.toggleButton.setAttribute('aria-expanded', String(this.open));
    this.syncLabel();
  }

  /**
   * つまみの読み上げ名。見出しは light DOM にあって aria-labelledby では
   * 参照できないので、見出しの文字（または label 属性）を写しておく。
   */
  syncLabel() {
    const text = titleTextOf(this);
    this.toggleButton.setAttribute('aria-label', text ? `${text}（開閉）` : 'セクションの開閉');
  }
}

if (!customElements.get(TAG)) customElements.define(TAG, PortalSection);

/** root の中のセクションをすべて開く／閉じる。 */
export function setSectionsOpen(root, open) {
  root.querySelectorAll(TAG).forEach((section) => {
    section.open = open;
  });
}

/**
 * その要素が見えるように、囲んでいるセクションを（入れ子も含めて）開く。
 * 入力漏れの案内やフォーカス移動が、折り畳んだ中を指してしまうのを防ぐ。
 */
export function revealSection(node) {
  let section = node && node.closest ? node.closest(TAG) : null;
  while (section) {
    section.open = true;
    section = section.parentElement ? section.parentElement.closest(TAG) : null;
  }
}
