// @vitest-environment jsdom
//
// 書籍スキャン PDF 結合ツール: ページが落ちても記録を残すところ（crash-log.js）。
// ページ（タブ）ごとに残し、持ち主が開いている記録は取らないこと、localStorage を
// 使えない・壊れているときにも処理を止めないことを縛る。

import { describe, expect, it } from 'vitest';
import { createCrashLog } from '../src/pdf-book-merger/crash-log.js';

function fakeWindow(storage) {
  const listeners = {};
  return {
    get localStorage() {
      if (storage === 'throws') throw new Error('SecurityError');
      return storage;
    },
    addEventListener: (type, listener) => (listeners[type] = listener),
    fire: (type) => listeners[type]?.(),
  };
}

function memoryStorage() {
  const items = new Map();
  return {
    items,
    get length() {
      return items.size;
    },
    key: (i) => [...items.keys()][i] ?? null,
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: (key) => items.delete(key),
  };
}

/** Web Locks の偽物。持っている名前を覚える（ページが落ちたら release で手放す）。 */
function fakeLocks() {
  const held = new Set();
  return {
    held,
    request(name, options, callback) {
      if (typeof options === 'function') {
        held.add(name);
        return options({ name });
      }
      const free = !held.has(name);
      return Promise.resolve(callback(free ? { name } : null));
    },
  };
}

describe('createCrashLog', () => {
  it('落ちたページの記録の終わり 200 行を、次に開いたページが取り出す（取り出したら消す）', async () => {
    const storage = memoryStorage();
    const locks = fakeLocks();
    const crashed = createCrashLog(fakeWindow(storage), { locks, id: 'a' });
    crashed.record(Array.from({ length: 250 }, (_, i) => `line ${i}`));
    locks.held.delete('pdf-book-merger:log:a'); // ページが落ちて、ロックが外れた

    const next = createCrashLog(fakeWindow(storage), { locks, id: 'b' });
    const previous = await next.takePrevious();
    expect(previous).toHaveLength(200);
    expect(previous[0]).toBe('line 50');
    expect(await next.takePrevious()).toEqual([]);
  });

  it('ほかのタブが処理している最中の記録は取らない。いくつも残っていれば新しいものを出す', async () => {
    const storage = memoryStorage();
    const locks = fakeLocks();
    createCrashLog(fakeWindow(storage), { locks, id: 'live' }).record(['live']);
    storage.setItem('pdf-book-merger:log:old', JSON.stringify({ at: 1, lines: ['old'] }));
    storage.setItem('pdf-book-merger:log:new', JSON.stringify({ at: 2, lines: ['new'] }));
    storage.setItem('pdf-book-merger:log', JSON.stringify(['legacy'])); // 前の版の残し方
    storage.setItem('unrelated', 'x');

    const log = createCrashLog(fakeWindow(storage), { locks, id: 'me' });
    expect(await log.takePrevious()).toEqual(['new']);
    expect([...storage.items.keys()].sort()).toEqual(['pdf-book-merger:log:live', 'unrelated']);
  });

  it('前の版が残した記録も取り出す', async () => {
    const storage = memoryStorage();
    storage.setItem('pdf-book-merger:log', JSON.stringify(['legacy']));

    expect(await createCrashLog(fakeWindow(storage), { locks: fakeLocks(), id: 'me' }).takePrevious()).toEqual(['legacy']);
  });

  it('Web Locks の無いブラウザでは、ほかのページの記録をすべて前回のものとみなす', async () => {
    const storage = memoryStorage();
    createCrashLog(fakeWindow(storage), { locks: null, id: 'a' }).record(['a']);

    expect(await createCrashLog(fakeWindow(storage), { locks: null, id: 'b' }).takePrevious()).toEqual(['a']);
  });

  it('処理を終えたとき・普通に閉じたとき（pagehide）は、自分の記録だけを消す', () => {
    const storage = memoryStorage();
    const win = fakeWindow(storage);
    const locks = fakeLocks();
    const other = createCrashLog(win, { locks, id: 'other' });
    other.record(['other']);
    const log = createCrashLog(win, { locks, id: 'me' });
    log.clearOnLeave();
    log.record(['a']);
    log.clear();
    expect([...storage.items.keys()]).toEqual(['pdf-book-merger:log:other']);

    log.record(['a']);
    win.fire('pagehide');
    expect([...storage.items.keys()]).toEqual(['pdf-book-merger:log:other']);
  });

  it('localStorage や Web Locks を使えない・壊れていても、失敗にしない', async () => {
    const unavailable = createCrashLog(fakeWindow('throws'), { locks: null });
    unavailable.record(['a']);
    unavailable.clear();
    expect(await unavailable.takePrevious()).toEqual([]);

    const broken = memoryStorage();
    broken.setItem('pdf-book-merger:log:x', '{not json');
    expect(await createCrashLog(fakeWindow(broken), { locks: null }).takePrevious()).toEqual([]);
    broken.setItem('pdf-book-merger:log:y', '{"a":1}');
    expect(await createCrashLog(fakeWindow(broken), { locks: null }).takePrevious()).toEqual([]);

    const full = memoryStorage();
    full.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    full.removeItem = () => {
      throw new Error('SecurityError');
    };
    const win = fakeWindow(full);
    const log = createCrashLog(win, { locks: { request: () => Promise.reject(new Error('denied')) } });
    log.record(['a']);
    log.clearOnLeave();
    expect(() => win.fire('pagehide')).not.toThrow();
  });

  it('既定では、このページの window と Web Locks を使う', async () => {
    const log = createCrashLog();
    log.record(['x']);
    expect(Object.keys(localStorage).some((key) => key.startsWith('pdf-book-merger:log:'))).toBe(true);
    log.clear();
    expect(Object.keys(localStorage).some((key) => key.startsWith('pdf-book-merger:log:'))).toBe(false);
  });
});
