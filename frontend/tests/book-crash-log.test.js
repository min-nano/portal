// @vitest-environment jsdom
//
// 書籍スキャン PDF 結合ツール: ページが落ちても記録を残すところ（crash-log.js）。
// localStorage を使えない・壊れているときにも、処理を止めないことを縛る。

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
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, value),
    removeItem: (key) => items.delete(key),
  };
}

describe('createCrashLog', () => {
  it('残した記録の終わり 200 行を、次に取り出せる（取り出したら消す）', () => {
    const storage = memoryStorage();
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i}`);
    createCrashLog(fakeWindow(storage)).record(lines);

    const log = createCrashLog(fakeWindow(storage));
    const previous = log.takePrevious();
    expect(previous).toHaveLength(200);
    expect(previous[0]).toBe('line 50');
    expect(log.takePrevious()).toEqual([]);
  });

  it('普通に閉じたら（pagehide）消す', () => {
    const storage = memoryStorage();
    const win = fakeWindow(storage);
    const log = createCrashLog(win);
    log.clearOnLeave();
    log.record(['a']);

    win.fire('pagehide');
    expect(storage.items.size).toBe(0);
  });

  it('localStorage を使えない・壊れていても、失敗にしない', () => {
    const unavailable = createCrashLog(fakeWindow('throws'));
    unavailable.record(['a']);
    expect(unavailable.takePrevious()).toEqual([]);

    const broken = memoryStorage();
    broken.setItem('pdf-book-merger:log', '{not json');
    expect(createCrashLog(fakeWindow(broken)).takePrevious()).toEqual([]);
    broken.setItem('pdf-book-merger:log', '{"a":1}');
    expect(createCrashLog(fakeWindow(broken)).takePrevious()).toEqual([]);

    const full = memoryStorage();
    full.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    full.removeItem = () => {
      throw new Error('SecurityError');
    };
    const win = fakeWindow(full);
    const log = createCrashLog(win);
    log.record(['a']);
    log.clearOnLeave();
    expect(() => win.fire('pagehide')).not.toThrow();
  });

  it('既定では、このページの window を使う', () => {
    const log = createCrashLog();
    log.record(['x']);
    expect(createCrashLog(window).takePrevious()).toEqual(['x']);
  });
});
