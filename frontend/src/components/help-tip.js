// 「?」を押すと開く説明（ヘルプ）。長い説明を画面に出しっぱなしにせず、
// 見出しやボタンの横の「?」に畳んでおく。
//
// マークアップ（説明の文は、途中で改行すると空白が入って見えるので 1 行に書く）:
//
//   <… class="help-host">          説明を重ねて出す基準（見出し・ボタンの行など）
//     …
//     <span class="help">
//       <button type="button" class="help-btn" aria-label="〇〇の説明"
//               aria-expanded="false" aria-controls="helpXxx">?</button>
//       <span class="help-body" id="helpXxx">説明の文</span>
//     </span>
//   </…>
//
// 押すと説明を開き（もう一度押すか、外を押すか、Esc で閉じる）、マウスでは
// 載せている間だけ開く。どちらも同じ open の切り替えで表すので、見た目と
// aria-expanded が食い違わない。開くのはいつも 1 つだけ。見た目は
// styles/components.css の .help。

/** 「?」からマウスを外して、説明を閉じるまでの猶予（説明の文へ動かす間）。 */
const HELP_LEAVE_MS = 300;

/**
 * ページの中の「?」をすべて動くようにする（ページの準備で 1 度だけ呼ぶ）。
 *
 * @param {Document} [doc]
 */
export function connectHelpTips(doc = document) {
  const helps = [...doc.querySelectorAll('.help')];
  const setOpen = (help, open) => {
    help.classList.toggle('open', open);
    help.querySelector('.help-btn').setAttribute('aria-expanded', String(open));
  };
  const openOnly = (help) => helps.forEach((other) => setOpen(other, other === help));
  for (const help of helps) {
    // マウスを載せている間（説明の文へ動かす途中の隙間は少し待つ）。タッチの
    // pointerenter は押したのと同じなので、ここでは扱わない。
    let hovering = false;
    let leaving = 0;
    help.addEventListener('pointerenter', (event) => {
      if (event.pointerType !== 'mouse') return;
      clearTimeout(leaving);
      hovering = true;
      openOnly(help);
    });
    help.addEventListener('pointerleave', (event) => {
      if (event.pointerType !== 'mouse') return;
      hovering = false;
      leaving = setTimeout(() => setOpen(help, false), HELP_LEAVE_MS);
    });
    help.querySelector('.help-btn').addEventListener('click', () => {
      // 載せて開いているときに押しても閉じない（押した途端に消えて見えるので）。
      if (hovering || !help.classList.contains('open')) openOnly(help);
      else setOpen(help, false);
    });
    // 折り畳める節の見出しの中にあっても、説明の文を押して節を畳まない
    // （文を選んで読めるように）。
    help.querySelector('.help-body').addEventListener('click', (event) => event.stopPropagation());
  }
  doc.addEventListener('click', (event) => {
    for (const help of helps) if (!help.contains(event.target)) setOpen(help, false);
  });
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') helps.forEach((help) => setOpen(help, false));
  });
}
