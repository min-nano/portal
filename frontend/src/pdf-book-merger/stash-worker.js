// 保存領域（OPFS）へ書く worker（stash.js から使う）。
//
// OPFS のファイルへ書く手段のうち、iPhone・iPad の Safari（15.2 から）でも使える
// のは、worker の中だけで使える同期の書き口（createSyncAccessHandle）なので、
// 書くのはここで行う。読むのは画面の側で行う（getFile。どのブラウザでも使える）。
//
// この worker に話しかけられるのは、作った画面だけ（専用の worker）。

/** 開いている書き口（ディレクトリ名/ファイル名 → {access, at}）。 */
const open = new Map();

async function directoryOf(root, dir) {
  const base = await root.getDirectoryHandle('pdf-merger', { create: true });
  return base.getDirectoryHandle(dir, { create: true });
}

/**
 * 1 つの頼みを行う。
 *
 * open   ファイルを作り直し（空にして）、書き口を開く
 * append 続きに書く
 * close  書き終えて、書き口を閉じる
 *
 * @param {FileSystemDirectoryHandle} root OPFS のいちばん上
 * @param {{op:string, dir:string, name:string, bytes?:Uint8Array}} message
 */
export async function run(root, { op, dir, name, bytes }) {
  const key = `${dir}/${name}`;
  if (op === 'open') {
    const directory = await directoryOf(root, dir);
    const file = await directory.getFileHandle(name, { create: true });
    const access = await file.createSyncAccessHandle();
    access.truncate(0);
    open.set(key, { access, at: 0 });
    return;
  }
  const writing = open.get(key);
  if (!writing) throw new Error(`「${name}」は書き口が開いていません。`);
  if (op === 'append') {
    writing.at += writing.access.write(bytes, { at: writing.at });
    return;
  }
  if (op === 'close') {
    open.delete(key);
    writing.access.flush();
    writing.access.close();
    return;
  }
  throw new Error(`知らない頼み（${op}）です。`);
}

self.onmessage = async ({ data }) => {
  try {
    await run(await navigator.storage.getDirectory(), data);
    self.postMessage({ id: data.id });
  } catch (error) {
    self.postMessage({ id: data.id, error: error.message });
  }
};
