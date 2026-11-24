// 本の構造（部・章・節などの階層）と、分ける位置。
//
// 正解（学習データに付けた階層構造。単位とその部品——扉・概要・終わり——を、id と親で
// 木にしたもの）から、頁ごとに「頭からどの深さの単位が始まるか」「途中からどの深さの単位が
// 始まるか」を求める（page-model.js が学ぶ目標）。分ける位置は、この 2 つから、分け方の
// 方針（上限に収まれば分けない。超えれば上の階層の単位の境目で分け、まだ超える単位だけを
// 次の階層で分ける。章などの扉・概要は最初の子に付ける）で求める。どこで切るか・部品を
// どのファイルに付けるかは方針の側で決めるので、正解には含めない。
//
// DOM には触らない（テストと学習のスクリプトで使うため）。

/** 学ぶ階層の深さ（これより深い単位は、この深さとして数える）。 */
export const MAX_DEPTH = 3;

/**
 * 頁ごとの目標。top[p] は頁 p の頭から始まる単位のいちばん浅い深さ、mid[p] は頁 p の途中から
 * 始まる単位のいちばん浅い深さ（どちらも無ければ 0。MAX_DEPTH より深ければ MAX_DEPTH）。
 * 扉・概要・終わりなどの部品は数えない（単位そのもの——kind が body——だけ）。
 *
 * @param {{page:number, depth:number, kind:string, at:string}[]} units 正解の単位
 * @param {number} count 頁の数
 * @returns {{top:number[], mid:number[]}}
 */
export function pageTargets(units, count) {
  const top = new Array(count).fill(0);
  const mid = new Array(count).fill(0);
  for (const unit of units) {
    if (unit.kind !== 'body') continue;
    const depth = Math.min(unit.depth, MAX_DEPTH);
    const target = unit.at === 'top' ? top : mid;
    target[unit.page] = target[unit.page] ? Math.min(target[unit.page], depth) : depth;
  }
  return { top, mid };
}

/**
 * 分ける位置（新しいファイルを始める頁の位置。小さい順）。本の全体が上限に収まれば分けない。
 * 収まらなければ、頭から始まる深さ 1 の単位の境目で分け、まだ上限を超える区間だけを、その
 * 中の深さ 2 の単位の境目で分ける（以下同じ）。区間の頭（親の単位の始まり）から最初の子の
 * 前までに、単位が 1 つも始まっていなければ（扉・概要だけなら）、最初の子の前では切らない。
 * 区間の頭が親の単位の始まりでなければ（本全体の前付けなど）、最初の子の前でも切る。どの
 * 深さでも分けられず上限を超える区間は、そのまま返す（呼ぶ側が大きさで分ける）。
 *
 * @param {number[]} top pageTargets の top（または予測）
 * @param {number[]} mid pageTargets の mid（または予測）
 * @param {number[]} sizes 頁の大きさ（バイト）
 * @param {number} limit 1 ファイルの上限（バイト）
 */
export function structureCuts(top, mid, sizes, limit) {
  const sums = [0];
  for (const size of sizes) sums.push(sums.at(-1) + size);
  const fits = (a, b) => sums[b] - sums[a] <= limit;
  const split = (a, b, depth) => {
    if (fits(a, b) || depth > MAX_DEPTH) return [];
    const kids = [];
    for (let p = a + 1; p < b; p++) if (top[p] === depth) kids.push(p);
    if (!kids.length) return split(a, b, depth + 1);
    // 区間の頭が親の単位の始まりで、最初の子の前に単位が始まっていなければ、扉・概要は
    // 最初の子に付ける。
    if (top[a] > 0 && top[a] < depth) {
      let started = mid[a] >= depth;
      for (let p = a + 1; p < kids[0]; p++) started ||= top[p] >= depth || mid[p] >= depth;
      if (!started) kids.shift();
    }
    const bounds = [a, ...kids, b];
    const cuts = [];
    for (let k = 0; k + 1 < bounds.length; k++) {
      if (k > 0) cuts.push(bounds[k]);
      cuts.push(...split(bounds[k], bounds[k + 1], depth + 1));
    }
    return cuts;
  };
  return split(0, sizes.length, 1);
}
