// ファイルの読み込み（Drive からの転送・この端末のファイルの読み出し）を、
// いくつか並べて進める。
//
// 読み込みは調べるのを待たずに先へ進めるが、1 つずつ順に読むと、小さなファイルを
// たくさん選んだときに、ファイルごとの待ち（サーバーへの問い合わせ・Drive の
// 応答）が積み重なって、調べるほうが追いついて止まる（調べ終えるたびに、次の
// ファイルの読み込みを待つ）。そこで、何個かを並べて読む。
//
// ただし、読み込みの間は中身をまるごとメモリに持つ（保存領域へ写すまで）ので、
// 並べて読むのは、合わせた大きさが budget に収まる間だけにする。数百 MB の本は
// これまでどおり 1 つずつ読む（iPhone・iPad でメモリが尽きないように）。
// 始める順も、大きさを確かめて読み進める順も、足した順のまま（先に調べる
// ファイルを、後のファイルが追い越して待たせないように）。

/**
 * @param {{limit:number, budget:number}} options limit は同時に読む数、budget は
 *   同時に読む中身の大きさの合計（バイト）。1 つで budget を超えるファイルも、
 *   ほかに読んでいるものが無ければ読む
 * @returns {{run: <T>(task: (reserve: (size:number) => Promise<void>) => Promise<T>) => Promise<T>}}
 *   run は、空きができたら task を始める。task は中身の大きさが分かったら、
 *   それを入れる場所を作る前に reserve(size) を待つ。予約は task が終わったら返す
 */
export function createDownloadPool({ limit, budget }) {
  let running = 0;
  let reserved = 0;
  /** 始めるのを待っている task（足した順）。 */
  const starting = [];
  /** 大きさの予約を待っているもの（頼んだ順）。 */
  const reserving = [];

  const fits = (size) => reserved === 0 || reserved + size <= budget;

  /** 空きのあるだけ、待っているものを先頭から進める（先頭が入らなければ、後ろも待たせる）。 */
  const pump = () => {
    while (reserving.length > 0 && fits(reserving[0].size)) {
      const { size, resolve } = reserving.shift();
      reserved += size;
      resolve();
    }
    while (starting.length > 0 && running < limit) {
      running++;
      starting.shift()();
    }
  };

  const run = async (task) => {
    await new Promise((resolve) => {
      starting.push(resolve);
      pump();
    });
    let held = 0;
    // 予約は 1 つの task で 1 度（読んでいる間に差し替えられて大きさが変わっても、
    // 頼み直さない。まれなうえ、差は小さい）。
    const reserve = async (size) => {
      await new Promise((resolve) => {
        reserving.push({ size, resolve });
        pump();
      });
      held = size;
    };
    try {
      return await task(reserve);
    } finally {
      reserved -= held;
      running--;
      pump();
    }
  };

  return { run };
}
