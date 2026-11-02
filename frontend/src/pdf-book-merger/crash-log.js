// ページが落ちても、処理の記録を次に開いたときに見られるようにする。
//
// iPhone・iPad では、メモリが足りなくなるとページごと落ちて読み込み直され、
// 処理の記録（ログ）も消える。どこまで進んで落ちたのかが分からないと直せない
// ので、処理している間は、記録の終わりのほうを localStorage にも書いておく。
//
// 記録はページ（タブ）ごとに別の名前で残し、開いている間はその名前で Web Locks
// のロックを持つ。次に開いたときは、ロックの無い（持ち主のページが閉じたか
// 落ちた）記録だけを「前回の記録」として取り出す。別のタブで処理している最中の
// 記録は取らない。処理を終えたとき・普通に閉じたとき（pagehide）は消すので、
// 残っているのは処理の途中で終わったものだけになる。
//
// localStorage を使えない（プライベートブラウズの一部など）ときは、何もしない。
// Web Locks の無いブラウザでは、ほかのページの記録をすべて前回のものとみなす。

const PREFIX = 'pdf-book-merger:log';
/** 残す行の数（書くたびにまるごと書き直すので、多くしない）。 */
export const CRASH_LOG_LINES = 200;

function storageOf(win) {
  try {
    return win.localStorage;
  } catch {
    return null;
  }
}

/** localStorage の、記録の名前（自分の分を除く）。 */
function logKeys(storage, own) {
  const keys = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== own && (key === PREFIX || key.startsWith(`${PREFIX}:`))) keys.push(key);
  }
  return keys;
}

/**
 * @param {Window} [win]
 * @param {{locks?: LockManager|null, id?: string}} [options]
 */
export function createCrashLog(
  win = globalThis.window,
  { locks = win?.navigator?.locks ?? null, id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}` } = {}
) {
  const storage = storageOf(win);
  const key = `${PREFIX}:${id}`;
  // 開いている間はロックを持つ（返さない）。ほかのページが、この記録を取らないように。
  locks?.request(key, () => new Promise(() => {})).catch(() => {});

  const clear = () => {
    try {
      storage?.removeItem(key);
    } catch {
      // 消せなくても困らない（次に開いたときに出るだけ）。
    }
  };

  return {
    /**
     * 前回落ちたページの記録を取り出して消す（無ければ空）。持ち主が開いている
     * 記録は取らない。いくつもあれば、いちばん新しいもの。
     */
    async takePrevious() {
      try {
        let latest = null;
        for (const name of logKeys(storage, key)) {
          const orphaned = locks
            ? await locks.request(name, { ifAvailable: true }, (lock) => lock !== null)
            : true;
          if (!orphaned) continue;
          const value = JSON.parse(storage.getItem(name));
          storage.removeItem(name);
          // 前の版は、行の並びをそのまま残していた。
          const record = Array.isArray(value) ? { at: 0, lines: value } : value;
          if (Array.isArray(record?.lines) && (!latest || record.at > latest.at)) latest = record;
        }
        return latest?.lines ?? [];
      } catch {
        return [];
      }
    },
    /** いまの記録の終わりのほうを残す。 */
    record(lines) {
      try {
        storage?.setItem(key, JSON.stringify({ at: Date.now(), lines: lines.slice(-CRASH_LOG_LINES) }));
      } catch {
        // 容量の上限など。残せなくても、処理は続ける。
      }
    },
    /** 残した記録を消す（処理を終えたとき）。 */
    clear,
    /** 普通に閉じたら消す（残っていれば、次に開いたときに「落ちた」と分かる）。 */
    clearOnLeave() {
      win?.addEventListener?.('pagehide', clear);
    },
  };
}
