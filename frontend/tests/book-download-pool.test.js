// PDF 結合ツールの、ファイルの読み込みを並べて進める仕組み
// （src/pdf-book-merger/download-pool.js）。

import { describe, expect, it } from 'vitest';
import { createDownloadPool } from '../src/pdf-book-merger/download-pool.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 止めておける task。size を渡せば、始めたら予約する。 */
function held(log, name, size = null) {
  let finish;
  let fail;
  const task = async (reserve) => {
    log.push(`start ${name}`);
    if (size !== null) {
      await reserve(size);
      log.push(`reserved ${name}`);
    }
    await new Promise((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    return name;
  };
  return { task, finish: () => finish(), fail: (error) => fail(error) };
}

describe('createDownloadPool', () => {
  it('limit 個まで並べて始め、空いたら足した順に次を始める', async () => {
    const pool = createDownloadPool({ limit: 2, budget: 100 });
    const log = [];
    const [a, b, c] = ['a', 'b', 'c'].map((name) => held(log, name));
    const results = [a, b, c].map(({ task }) => pool.run(task));
    await flush();
    expect(log).toEqual(['start a', 'start b']);

    b.finish();
    await expect(results[1]).resolves.toBe('b');
    await flush();
    expect(log).toEqual(['start a', 'start b', 'start c']);
    a.finish();
    c.finish();
    await expect(Promise.all(results)).resolves.toEqual(['a', 'b', 'c']);
  });

  it('合わせた大きさが budget を超えるなら、先に読んでいるものが終わるまで待つ', async () => {
    const pool = createDownloadPool({ limit: 4, budget: 100 });
    const log = [];
    const a = held(log, 'a', 60);
    const b = held(log, 'b', 50);
    const c = held(log, 'c', 10);
    const results = [a, b, c].map(({ task }) => pool.run(task));
    await flush();
    // b は入らない。c は入るが、先に頼んだ b を追い越さない。
    expect(log).toEqual(['start a', 'start b', 'start c', 'reserved a']);

    a.finish();
    await flush();
    expect(log.slice(4)).toEqual(['reserved b', 'reserved c']);
    b.finish();
    c.finish();
    await expect(Promise.all(results)).resolves.toEqual(['a', 'b', 'c']);
  });

  it('1 つで budget を超えるものも、ほかに読んでいなければ読む', async () => {
    const pool = createDownloadPool({ limit: 4, budget: 100 });
    const log = [];
    const big = held(log, 'big', 500);
    const small = held(log, 'small', 1);
    const results = [big, small].map(({ task }) => pool.run(task));
    await flush();
    expect(log).toEqual(['start big', 'start small', 'reserved big']);
    big.finish();
    await flush();
    expect(log.at(-1)).toBe('reserved small');
    small.finish();
    await Promise.all(results);
  });

  it('失敗した task も、場所と予約を返す', async () => {
    const pool = createDownloadPool({ limit: 1, budget: 100 });
    const log = [];
    const a = held(log, 'a', 100);
    const b = held(log, 'b', 100);
    const first = pool.run(a.task);
    const second = pool.run(b.task);
    await flush();
    a.fail(new Error('読めない'));
    await expect(first).rejects.toThrow('読めない');
    await flush();
    expect(log).toEqual(['start a', 'reserved a', 'start b', 'reserved b']);
    b.finish();
    await expect(second).resolves.toBe('b');
  });

  it('予約しない task は、大きさの枠を使わない', async () => {
    const pool = createDownloadPool({ limit: 2, budget: 10 });
    const log = [];
    const a = held(log, 'a');
    const b = held(log, 'b', 10);
    const results = [a, b].map(({ task }) => pool.run(task));
    await flush();
    expect(log).toEqual(['start a', 'start b', 'reserved b']);
    a.finish();
    b.finish();
    await Promise.all(results);
  });
});
