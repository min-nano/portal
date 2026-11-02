// 読み込んだ PDF と結合した PDF を、ブラウザの保存領域（OPFS）に置く。
//
// 1 頁のファイルを 200 個（計 214 MB）結合しようとすると、iPhone 13 mini では
// ページごと落ちた。元のファイルをすべてメモリに持ったまま結合し、結合した PDF も
// メモリに組み立てていたため。ここに置けば、メモリに持つのは使っている間だけで
// 済む。端末のファイルでも実体がクラウドにあることがあるので、元のファイルを
// 読み直すことはせず、読み込んだ中身をここへ写す。
//
// 置き場所は「pdf-merger/<開いたページごとの名前>」。同じツールを別のタブで
// 開いていても混ざらない。開いている間はその名前でロック（Web Locks）を持ち、
// 次に開いたときに、ロックの無い（閉じたか落ちたページの）置き場所を消す。
//
// 書くのは worker（stash-worker.js）、読むのは画面の側。使えない環境（古い
// ブラウザ・プライベートブラウズなど）では openStash がその理由で失敗し、画面は
// 代わりに blobStash を使う。

/**
 * 保存領域を使えないときの置き場所。中身を Blob にして持つ。
 *
 * iPhone の Safari では、保存領域を使えないことがある（「Context not access
 * storage」。プライベートブラウズやアプリの中のブラウザなど）。Blob の中身は、
 * ブラウザがページとは別のところ（Safari ではネットワークのプロセス、Chromium
 * ではブラウザのプロセスかディスク）に持つので、Blob にしておけば、ページの
 * メモリからは外せる。ページが落ちるのは、ページのメモリが上限に届いたとき。
 */
export function blobStash() {
  const blobs = new Map();
  return {
    kind: 'blob',
    async put(name, bytes) {
      blobs.set(name, new Blob([bytes]));
    },
    async writer(name) {
      // 少しずつ Blob にしていく（つなげた中身をページのメモリに組み立てない）。
      const parts = [];
      return {
        write: async (chunk) => {
          parts.push(new Blob([chunk]));
        },
        close: async () => {
          blobs.set(name, new Blob(parts));
          return blobs.get(name);
        },
      };
    },
    async read(name) {
      return new Uint8Array(await blobs.get(name).arrayBuffer());
    },
    async file(name) {
      return blobs.get(name);
    },
    async remove(name) {
      blobs.delete(name);
    },
  };
}

/** 開いたページの置き場所の名前の頭（ロックの名前にも使う）。 */
const LOCK_PREFIX = 'pdf-merger:';
/** ロックを使えないブラウザで、残っている置き場所を消すまでの時間。 */
const STALE_MS = 24 * 60 * 60 * 1000;

/** 渡すと手放してよいバイト列（ArrayBuffer をまるごと使っている写し）。 */
function transferable(bytes) {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
}

/** ほかのページの置き場所のうち、もう使われていないものを消す。 */
async function removeStale(base, own, nav, now) {
  for await (const [name] of base.entries()) {
    if (name === own) continue;
    let stale;
    if (nav.locks) {
      stale = await nav.locks.request(`${LOCK_PREFIX}${name}`, { ifAvailable: true }, (lock) => lock !== null);
    } else {
      stale = now - Number(name.split('-')[0]) > STALE_MS;
    }
    if (stale) await base.removeEntry(name, { recursive: true }).catch(() => {});
  }
}

/**
 * 保存領域を使えるようにする。使えなければ、その理由で失敗する（画面は
 * メモリに持ち、理由を処理の記録に出す）。
 *
 * @param {{nav?: Navigator, WorkerClass?: typeof Worker, now?: number}} [options]
 */
export async function openStash({ nav = globalThis.navigator, WorkerClass = globalThis.Worker, now = Date.now() } = {}) {
  if (typeof nav?.storage?.getDirectory !== 'function') throw new Error('このブラウザには OPFS がありません');
  if (typeof WorkerClass !== 'function') throw new Error('このブラウザでは worker を使えません');
  let worker = null;
  try {
    const root = await nav.storage.getDirectory();
    const base = await root.getDirectoryHandle('pdf-merger', { create: true });
    const dir = `${now}-${Math.random().toString(36).slice(2, 10)}`;
    const directory = await base.getDirectoryHandle(dir, { create: true });
    // 開いている間はロックを持つ（返さない）。
    nav.locks?.request(`${LOCK_PREFIX}${dir}`, () => new Promise(() => {}));
    removeStale(base, dir, nav, now).catch(() => {});

    worker = new WorkerClass(new URL('./stash-worker.js', import.meta.url), { type: 'module' });
    const stash = createStash(worker, dir, directory);
    // 書けることを確かめておく（同期の書き口が使えない・容量が無いなど）。
    await stash.put('probe', new Uint8Array([1]));
    await stash.remove('probe');
    return stash;
  } catch (error) {
    worker?.terminate();
    throw error;
  }
}

function createStash(worker, dir, directory) {
  let nextId = 1;
  let broken = null;
  const pending = new Map();
  worker.onmessage = ({ data }) => {
    // 返事は、頼んだ id にだけ来る（worker が止まったら、もう返事は来ない）。
    const job = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) job.reject(new Error(data.error));
    else job.resolve();
  };
  worker.onerror = (event) => {
    broken = new Error(`保存領域へ書く worker が止まりました（${event.message || '理由不明'}）`);
    for (const job of pending.values()) job.reject(broken);
    pending.clear();
  };

  const call = (op, name, bytes, transfer = []) => {
    if (broken) return Promise.reject(broken);
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, op, dir, name, bytes }, transfer);
    });
  };

  const fileOf = async (name) => (await directory.getFileHandle(name)).getFile();

  return {
    kind: 'opfs',
    /**
     * 中身を書く（写して渡すので、bytes は手元に残る。書けなかったときに
     * メモリに持ち続けられるように）。
     */
    async put(name, bytes) {
      await call('open', name);
      await call('append', name, bytes);
      await call('close', name);
    },
    /** 少しずつ書く。書く分は渡して手放す。close で、書いたファイルを返す。 */
    async writer(name) {
      await call('open', name);
      return {
        write: (chunk) => {
          const bytes = transferable(chunk);
          return call('append', name, bytes, [bytes.buffer]);
        },
        close: async () => {
          await call('close', name);
          return fileOf(name);
        },
      };
    },
    /** 中身を読む。 */
    async read(name) {
      return new Uint8Array(await (await fileOf(name)).arrayBuffer());
    },
    /** 置いてあるファイル（中身は保存領域にあり、メモリには読まない）。 */
    file: fileOf,
    /** 消す（無ければ何もしない）。 */
    async remove(name) {
      await directory.removeEntry(name).catch(() => {});
    },
  };
}
