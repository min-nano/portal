// 大きな PDF を、端末のダウンロード（既定のダウンロードフォルダ）に保存するための
// Service Worker（save-file.js から使う）。
//
// iPhone・iPad の Safari は、ページの中で作った PDF を <a download> で渡しても
// 保存せずにタブで開き、ツールのページは閉じられる。blob: の URL は作ったページが
// 閉じると消えるので、開いた PDF を「ファイル」に保存しようとすると失敗する
// （WebKitBlobResource エラー 1）。共有シートに渡すと、Safari は中身をまるごと
// ページのメモリに読むので、615 MB の PDF ではページごと落ちた。
//
// Safari にダウンロードとして受け取らせるには、Content-Disposition: attachment を
// 付けた応答として渡す必要がある。ページから渡された PDF（File。中身は写さずに
// 参照だけが渡る）を覚えておき、その ID のアドレスが開かれたら、付けた名前と
// attachment を付けて返す。応えるのは、この Service Worker の範囲（pdf-download/）
// の中のアドレスだけで、ほかの読み込みには手を出さない。控えも作らない。

/** ID → { file, done }。開かれたら（か、待ちくたびれたら）忘れる。 */
const files = new Map();

/** 渡されてから開かれるまで待つ時間（ミリ秒）。過ぎたら手放す。 */
const KEEP_MS = 60 * 1000;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('message', (event) => {
  const { id, file } = event.data ?? {};
  if (!id || !file) return;
  // 開かれるまで（か KEEP_MS まで）止められないようにする。
  event.waitUntil(
    new Promise((done) => {
      files.set(id, { file, done });
      setTimeout(() => {
        files.delete(id);
        done();
      }, KEEP_MS);
    })
  );
  event.ports[0]?.postMessage('ready');
});

self.addEventListener('fetch', (event) => {
  const id = new URL(event.request.url).pathname.split('/').pop();
  const entry = files.get(id);
  files.delete(id);
  entry?.done();
  // 覚えていない（もう保存した・待ちくたびれた）ときは、何も返さない（204）。
  // エラーの頁を返すと、ツールのページがそれに置き換わってしまう。
  event.respondWith(entry ? attachment(entry.file) : new Response(null, { status: 204 }));
});

/** 付けた名前で保存させる応答。 */
function attachment(file) {
  return new Response(file, {
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'Content-Disposition': contentDisposition(file.name),
    },
  });
}

/**
 * Content-Disposition: attachment の値。日本語の名前は filename*（RFC 5987）で
 * 渡し、それを読めないブラウザ向けに、ASCII でない文字を _ にした filename も添える。
 */
function contentDisposition(name) {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
