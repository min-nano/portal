// ページが落ちても、処理の記録を次に開いたときに見られるようにする。
//
// iPhone・iPad では、メモリが足りなくなるとページごと落ちて読み込み直され、
// 処理の記録（ログ）も消える。どこまで進んで落ちたのかが分からないと直せない
// ので、記録の終わりのほうを localStorage にも書いておく。ページを普通に閉じた・
// 開き直したとき（pagehide）は消すので、次に開いたときに残っていれば、前回は
// 途中で落ちたということになる。
//
// localStorage を使えない（プライベートブラウズの一部など）ときは、何もしない。

const KEY = 'pdf-book-merger:log';
/** 残す行の数（書くたびにまるごと書き直すので、多くしない）。 */
const KEEP = 200;

function storageOf(win) {
  try {
    return win.localStorage;
  } catch {
    return null;
  }
}

/**
 * @param {Window} [win]
 */
export function createCrashLog(win = globalThis.window) {
  const storage = storageOf(win);
  return {
    /** 前回落ちる前に残した記録を取り出して消す（無ければ空）。 */
    takePrevious() {
      try {
        const lines = JSON.parse(storage?.getItem(KEY) ?? '[]');
        storage?.removeItem(KEY);
        return Array.isArray(lines) ? lines : [];
      } catch {
        return [];
      }
    },
    /** いまの記録の終わりのほうを残す。 */
    record(lines) {
      try {
        storage?.setItem(KEY, JSON.stringify(lines.slice(-KEEP)));
      } catch {
        // 容量の上限など。残せなくても、処理は続ける。
      }
    },
    /** 普通に閉じたら消す（残っていれば、次に開いたときに「落ちた」と分かる）。 */
    clearOnLeave() {
      win?.addEventListener?.('pagehide', () => {
        try {
          storage?.removeItem(KEY);
        } catch {
          // 消せなくても困らない（次に開いたときに出るだけ）。
        }
      });
    },
  };
}
