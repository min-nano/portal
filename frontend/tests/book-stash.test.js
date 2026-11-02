// 書籍スキャン PDF 結合ツール: 保存領域（OPFS）に置くところ（stash.js・
// stash-worker.js）。OPFS はメモリの上の偽物にし、worker は stash-worker.js を
// そのまま動かす偽物にして、書く・読む・消す・後片付け・使えないときを縛る。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** OPFS のファイルの偽物。 */
class FakeFile {
  constructor() {
    this.data = new Uint8Array(0);
    this.syncFails = false;
  }

  async createSyncAccessHandle() {
    if (this.syncFails || FakeFile.noSync) throw new Error('createSyncAccessHandle is not supported');
    const file = this;
    return {
      truncate(size) {
        file.data = file.data.slice(0, size);
      },
      write(bytes, { at }) {
        const next = new Uint8Array(Math.max(file.data.length, at + bytes.length));
        next.set(file.data);
        next.set(bytes, at);
        file.data = next;
        return bytes.length;
      },
      flush() {},
      close() {},
    };
  }

  async getFile() {
    return new File([this.data], 'f');
  }
}

/** OPFS のディレクトリの偽物。 */
class FakeDirectory {
  constructor() {
    this.children = new Map();
  }

  async getDirectoryHandle(name, { create = false } = {}) {
    if (!this.children.has(name)) {
      if (!create) throw new DOMException('not found', 'NotFoundError');
      this.children.set(name, new FakeDirectory());
    }
    return this.children.get(name);
  }

  async getFileHandle(name, { create = false } = {}) {
    if (!this.children.has(name)) {
      if (!create) throw new DOMException('not found', 'NotFoundError');
      this.children.set(name, new FakeFile());
    }
    return this.children.get(name);
  }

  async removeEntry(name) {
    if (!this.children.delete(name)) throw new DOMException('not found', 'NotFoundError');
  }

  async *entries() {
    yield* [...this.children];
  }
}

let root;
let workerScope;

/** stash-worker.js をそのまま動かす偽の Worker。 */
class FakeWorker {
  static instances = [];

  constructor(url, options) {
    this.url = String(url);
    this.options = options;
    this.terminated = false;
    this.received = [];
    FakeWorker.instances.push(this);
  }

  async postMessage(data, transfer = []) {
    this.received.push({ data, transfer });
    if (this.crash) {
      this.onerror?.(new Event('error'));
      return;
    }
    await import('../src/pdf-book-merger/stash-worker.js');
    workerScope.postMessage = (reply) => setTimeout(() => this.onmessage?.({ data: reply }), 0);
    await workerScope.onmessage({ data });
  }

  terminate() {
    this.terminated = true;
  }
}

/** Web Locks の偽物。持っている名前を覚える。 */
function fakeLocks() {
  const held = new Set();
  return {
    held,
    async request(name, options, callback) {
      if (typeof options === 'function') {
        held.add(name);
        return options({ name });
      }
      const free = !held.has(name);
      if (free) held.add(name);
      try {
        return await callback(free ? { name } : null);
      } finally {
        if (free) held.delete(name);
      }
    },
  };
}

function nav({ locks = fakeLocks() } = {}) {
  return { storage: { getDirectory: async () => root }, locks };
}

let stashModule;

beforeEach(async () => {
  vi.resetModules();
  root = new FakeDirectory();
  FakeFile.noSync = false;
  FakeWorker.instances = [];
  workerScope = {};
  vi.stubGlobal('self', workerScope);
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  stashModule = await import('../src/pdf-book-merger/stash.js');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const open = (options = {}) => stashModule.openStash({ nav: nav(options), WorkerClass: FakeWorker, now: 1_000_000_000, ...options });

describe('保存領域（OPFS）', () => {
  it('書いた中身を読め、ファイルとして渡せ、消せる（渡した中身は手元に残る）', async () => {
    const stash = await open();
    expect(FakeWorker.instances[0].url).toContain('stash-worker.js');
    expect(FakeWorker.instances[0].options).toEqual({ type: 'module' });

    const bytes = new Uint8Array([1, 2, 3, 4]);
    await stash.put('a.pdf', bytes);
    expect([...bytes]).toEqual([1, 2, 3, 4]);
    expect([...(await stash.read('a.pdf'))]).toEqual([1, 2, 3, 4]);
    expect((await stash.file('a.pdf')).size).toBe(4);

    // 置き場所は pdf-merger/<開いたページごとの名前>。確かめに書いたものは残さない。
    const [dir] = [...(await root.getDirectoryHandle('pdf-merger')).children.keys()];
    expect(dir).toMatch(/^1000000000-/);
    const directory = await (await root.getDirectoryHandle('pdf-merger')).getDirectoryHandle(dir);
    expect([...directory.children.keys()]).toEqual(['a.pdf']);

    await stash.remove('a.pdf');
    await stash.remove('a.pdf'); // 無くても失敗しない
    await expect(stash.read('a.pdf')).rejects.toThrow('not found');
  });

  it('少しずつ書くときは、書く分を手放して渡す（ほかの ArrayBuffer の一部なら写してから）', async () => {
    const stash = await open();
    const writer = await stash.writer('merged.pdf');
    const whole = new Uint8Array([1, 2]);
    const part = new Uint8Array([9, 3, 4, 9]).subarray(1, 3);
    await writer.write(whole);
    await writer.write(part);
    const file = await writer.close();

    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3, 4]);
    const appends = FakeWorker.instances[0].received.filter(({ data }) => data.op === 'append' && data.name === 'merged.pdf');
    expect(appends.map(({ transfer }) => transfer.length)).toEqual([1, 1]);
    expect(appends[0].transfer[0]).toBe(whole.buffer);
    expect(appends[1].transfer[0]).not.toBe(part.buffer);
    expect([...part]).toEqual([3, 4]);
  });

  it('閉じたか落ちたページの置き場所は消し、開いているページの置き場所は残す', async () => {
    const base = await root.getDirectoryHandle('pdf-merger', { create: true });
    await base.getDirectoryHandle('1-closed', { create: true });
    await base.getDirectoryHandle('2-open', { create: true });
    const locks = fakeLocks();
    locks.held.add('pdf-merger:2-open');

    await open({ locks });
    await vi.waitFor(() => expect(base.children.has('1-closed')).toBe(false));
    expect(base.children.has('2-open')).toBe(true);
    // 自分の置き場所は、開いている間ロックを持つ。
    const own = [...base.children.keys()].find((name) => name.startsWith('1000000000-'));
    expect(locks.held.has(`pdf-merger:${own}`)).toBe(true);
  });

  it('後片付けに失敗しても、使うのはやめない', async () => {
    const base = await root.getDirectoryHandle('pdf-merger', { create: true });
    await base.getDirectoryHandle('1-closed', { create: true });
    base.removeEntry = async () => {
      throw new Error('busy');
    };
    expect(await open()).not.toBeNull();

    base.entries = async function* entries() {
      throw new Error('denied');
    };
    expect(await open()).not.toBeNull();
  });

  it('ロックを使えないブラウザでは、1 日より古い置き場所だけを消す', async () => {
    const base = await root.getDirectoryHandle('pdf-merger', { create: true });
    await base.getDirectoryHandle('1-old', { create: true });
    await base.getDirectoryHandle('999999999-recent', { create: true });

    await open({ locks: null });
    await vi.waitFor(() => expect(base.children.has('1-old')).toBe(false));
    expect(base.children.has('999999999-recent')).toBe(true);
  });

  it('OPFS か worker が無ければ、その理由で使わない', async () => {
    await expect(stashModule.openStash({ nav: {}, WorkerClass: FakeWorker })).rejects.toThrow('OPFS がありません');
    await expect(stashModule.openStash({ nav: nav(), WorkerClass: undefined })).rejects.toThrow('worker を使えません');
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('同期の書き口を使えなければ、その理由で使わず、worker も止める', async () => {
    FakeFile.noSync = true;

    await expect(open()).rejects.toThrow('createSyncAccessHandle is not supported');
    expect(FakeWorker.instances[0].terminated).toBe(true);
  });

  it('既定では、このページの navigator と Worker を使う', async () => {
    vi.stubGlobal('Worker', FakeWorker);

    expect(await stashModule.openStash()).not.toBeNull();
  });

  it('worker が止まったら、待っていた頼みもそのあとの頼みも失敗にする', async () => {
    const stash = await open();
    const [worker] = FakeWorker.instances;
    worker.crash = true;

    await expect(stash.put('a.pdf', new Uint8Array([1]))).rejects.toThrow('worker が止まりました（理由不明）');
    await expect(stash.writer('b.pdf')).rejects.toThrow('worker が止まりました');

    // 理由が分かれば添える。
    const again = await open();
    FakeWorker.instances.at(-1).postMessage = function postMessage() {
      this.onerror({ message: 'SyntaxError: Unexpected token' });
    };
    await expect(again.put('a.pdf', new Uint8Array([1]))).rejects.toThrow('（SyntaxError: Unexpected token）');
  });
});

describe('stash-worker（書く側）', () => {
  it('開いていないファイルには書かず、知らない頼みは断る', async () => {
    const { run } = await import('../src/pdf-book-merger/stash-worker.js');

    await expect(run(root, { op: 'append', dir: 'd', name: 'x', bytes: new Uint8Array(1) })).rejects.toThrow(
      '書き口が開いていません'
    );
    await run(root, { op: 'open', dir: 'd', name: 'x' });
    await expect(run(root, { op: 'rename', dir: 'd', name: 'x' })).rejects.toThrow('知らない頼み（rename）');
  });

  it('開き直すと空から書き直す', async () => {
    const { run } = await import('../src/pdf-book-merger/stash-worker.js');
    for (const bytes of [new Uint8Array([1, 2, 3]), new Uint8Array([7])]) {
      await run(root, { op: 'open', dir: 'd', name: 'x' });
      await run(root, { op: 'append', dir: 'd', name: 'x', bytes });
      await run(root, { op: 'close', dir: 'd', name: 'x' });
    }
    const file = await (await (await root.getDirectoryHandle('pdf-merger')).getDirectoryHandle('d')).getFileHandle('x');

    expect([...file.data]).toEqual([7]);
  });

  it('ほかのところからの知らせは受けない', async () => {
    await import('../src/pdf-book-merger/stash-worker.js');
    workerScope.location = { origin: 'https://portal.example' };
    const replies = [];
    workerScope.postMessage = (reply) => replies.push(reply);

    await workerScope.onmessage({ data: { id: 1, op: 'open', dir: 'd', name: 'x' }, origin: 'https://evil.example' });
    expect(replies).toEqual([]);
    expect(root.children.size).toBe(0);

    await workerScope.onmessage({ data: { id: 2, op: 'open', dir: 'd', name: 'x' }, origin: 'https://portal.example' });
    expect(replies).toEqual([{ id: 2 }]);
  });

  it('失敗は、頼んだ画面へ知らせる', async () => {
    await import('../src/pdf-book-merger/stash-worker.js');
    const replies = [];
    workerScope.postMessage = (reply) => replies.push(reply);

    await workerScope.onmessage({ data: { id: 7, op: 'close', dir: 'd', name: 'nothing' } });

    expect(replies).toEqual([{ id: 7, error: '「nothing」は書き口が開いていません。' }]);
  });
});
