// 部（頁番号の振り直し）の推定。
//
// 1 冊の中で、部が変わるところで頁番号が振り直されている本がある（第 1 部が
// 1〜120 頁、第 2 部が 1〜80 頁、など）。奇数頁の束・偶数頁の束は部をまたいで
// スキャンするので、1 つのファイルの中で番号が戻ることも、同じ番号を含む束が
// いくつもあることもある。ここでは、本文の頁ごとに何部目かを決める。
//
// 束の種類（奇数頁・偶数頁・両面）ごとに、束を本の順につないでいく。
//
//   1. ファイルの中で番号が最初に戻ったところは、次の部の始まり
//   2. いまの束の最後の番号の次から始まる束を、続きとしてつなぐ（候補が
//      いくつもあれば、柱の文字が続いているもの、一覧で近いものを選ぶ）。
//      ただし、本の順でその間に番号が部の最初まで戻る束があれば、候補はその
//      次の部の続きと見て、つながない
//   3. 続きが無ければ、残りでいちばん小さい番号から始まる束へ移る（同じ番号
//      なら本の順で前のもの。一覧で上のもの、逆順の束は下のもの）。番号が最初に
//      戻っていれば次の部、途中に戻っただけなら撮り直し（重なり）。ただし次の部へ
//      移る前に、本の順でその間にある、いまの部の後ろの番号から始まる束（入れ忘れた
//      束の先）があれば、そちらを同じ部に置く
//
// 奇数頁と偶数頁の束で部の数が揃わないとき（同じ束を最初から 2 度入れた、
// など）は、部には分けない（重なりとして指摘される）。DOM には触らない。
//
// 頁番号の前に部・編などの番号を刷った本（2-21。page-numbers.js の階層）は、
// 刷られた前の段ごとに分けてから、それぞれの中で上のように振り直しを探す
// （前の段は刷られたとおりに並べ、振り直しは推定する）。前の段の無い頁（部の番号を
// 刷っていない巻など）は、本の順で前後にある部から置き場所を決める（placeSections）。

import { comparePaths, pageNumberText, prefixKey, sideOf, stripPageNumber } from './page-numbers.js';

/**
 * @param {{key:string, pages:{key:string, heads?:string[],
 *          signature?:{length:number, hash:string}}[]}[]} files
 *   番号の付いた本文のファイル（一覧の順）
 * @param {Map<string, {step:number|null, pages:{number:number|null, branch?:number[], prefix?:number[]}[]}>} numberings
 * @returns {{partOf: Map<string, number>, count: number, mismatch: boolean, names: string[],
 *   sections: Set<number>, unplaced: Set<string>}}
 *   partOf: 頁の key → 何部目か（0 から）。count: 部の数。
 *   mismatch: 奇数頁と偶数頁の束で部の数が揃わず、分けるのをやめた（前の段のどれかで）。
 *   names: 部ごとの呼び名（「第 2 部」「「5-」の後」）。刷られた前の段だけで分かる部
 *   （頁番号の 2-21 で分かる）は ''。
 *   sections: 前の段の無い頁を、前後の部から置いた部（placeSections）。
 *   unplaced: 前後の部から置き場所を決められなかった頁の key
 */
export function assignParts(files, numberings) {
  const segments = splitSegments(files, numberings);
  markCopies(segments);
  placeSections(segments);

  // 刷られた前の段ごと（と、前の段の無い頁を置いたところごと）に、振り直しを探す。
  const groups = new Map();
  for (const segment of segments) {
    const { key } = segment.place;
    if (!groups.has(key)) groups.set(key, { ...segment.place, segments: [] });
    groups.get(key).segments.push(segment);
  }
  const ordered = [...groups.values()].sort((a, b) => comparePaths(a.sort, b.sort));
  const printed = segments.some((segment) => segment.prefix);
  let mismatch = false;
  const names = [];
  const sections = new Set();
  for (const group of ordered) {
    const result = renumbered(group.segments);
    mismatch ||= result.mismatch;
    const first = names.length;
    for (let sub = 0; sub < result.count; sub++) {
      if (group.kind !== 'printed' && printed) sections.add(names.length);
      names.push(partLabel(group, sub, result.count, printed));
    }
    for (const segment of group.segments) segment.part = first + segment.part;
  }

  const partOf = new Map();
  const unplaced = new Set();
  for (const segment of segments) {
    const part = segment.copyOf ? segment.copyOf.part : segment.part;
    for (const index of segment.pages) {
      const { key } = segment.file.pages[index];
      partOf.set(key, part);
      if (segment.place.kind === 'unplaced') unplaced.add(key);
    }
  }
  return { partOf, count: names.length, mismatch, names, sections, unplaced };
}

/**
 * 部の呼び名。
 *
 *   刷られた前の段で分かる部               ''（振り直しで分けたなら「「2-」の第 2 部」）
 *   前の段の無い本の、振り直しで分けた部   「第 2 部」
 *   前の段の無い頁を、「5-」の部の後に置いた「「5-」の後」（振り直しで分けたなら「（2 つ目）」を添える）
 *   前の段の無い頁を、本の先頭に置いた     ''（振り直しで分けたなら「前付け（2 つ目）」）
 *   置き場所を決められなかった             「置き場所不明」
 */
function partLabel(group, sub, count, printed) {
  const nth = count === 1 ? '' : `（${sub + 1} つ目）`;
  if (group.kind === 'after') return `「${prefixKey(group.prefix)}-」の後${nth}`;
  if (group.kind === 'unplaced') return `置き場所不明${nth}`;
  if (count === 1) return '';
  if (group.kind === 'printed') return `「${prefixKey(group.prefix)}-」の第 ${sub + 1} 部`;
  return printed ? `前付け${nth}` : `第 ${sub + 1} 部`;
}

/**
 * 区間の置き場所（segment.place）を決める。
 *
 * 前の段（部・編などの番号）のある区間は、その前の段の部に置く。前の段の無い区間（部の番号を
 * 刷っていない巻・目次など）は、ファイルを部の区切りとはみなさず（束は部をまたいでスキャン
 * するので）、本の順で前後にある前の段のある頁から置き場所を決める。前後は、同じファイルの
 * 中の前後の区間を先に見て、無ければ一覧で前後のファイル（いちばん近いもの）を見る。
 *
 *   前に「5-」の頁があり、後ろの頁が「5-」より後の部か、無い  → 「5-」の部の後に、新しいまとまりとして
 *   前に前の段のある頁が無い                                  → 本の先頭（前付け）
 *   前に「5-」、後ろに「5-」以前の部の頁がある                → 置き場所を決められない（本文の最後に）
 *
 * 前の段の無い本では、すべての区間を 1 つのまとまりにする（これまでどおり）。
 */
function placeSections(segments) {
  const printed = segments.some((segment) => segment.prefix);
  // 一覧の位置を本の順に揃える（裏返した偶数頁の束は、一覧で下にあるほど本の前）。束の種類
  // （奇数頁・偶数頁・両面）ごとに揃えるので、前後のファイルは同じ種類の束から探す。
  const kinds = new Map();
  for (const segment of segments) {
    if (segment.kind === null) continue;
    if (!kinds.has(segment.kind)) kinds.set(segment.kind, []);
    kinds.get(segment.kind).push(segment);
  }
  for (const list of kinds.values()) rankByBookOrder(list);
  for (const segment of segments) {
    if (segment.prefix) {
      segment.place = { key: segment.prefixKey, kind: 'printed', prefix: segment.prefix, sort: [...segment.prefix, 0] };
      continue;
    }
    const before = printed ? nearPrefix(segment, segments, -1) : null;
    const after = before ? nearPrefix(segment, segments, 1) : null;
    if (!before) {
      segment.place = { key: '', kind: 'front', prefix: null, sort: [] };
    } else if (after && comparePaths(after, before) <= 0) {
      segment.place = { key: 'unplaced', kind: 'unplaced', prefix: null, sort: [Infinity] };
    } else {
      const key = `after:${prefixKey(before)}`;
      segment.place = { key, kind: 'after', prefix: before, sort: [...before, 1] };
    }
  }
}

/**
 * 区間の前（direction -1）か後ろ（1）で、いちばん近い前の段のある頁の前の段。同じファイルの
 * 中の区間を先に見て、無ければ本の順でいちばん近い、前の段のある頁を含むファイルの前の段
 * （前なら最も後の部、後ろなら最も前の部）。本の順は、同じ種類の束の中で、一覧の位置を
 * 本の順に揃えたもの（rank。歩幅の分からない区間は一覧の位置）。無ければ null。
 */
function nearPrefix(segment, segments, direction) {
  for (let other = direction < 0 ? segment.prev : segment.next; other; other = direction < 0 ? other.prev : other.next) {
    if (other.prefix) return other.prefix;
  }
  const at = (other) => (segment.kind === null ? other.order : other.rank);
  const others = segments.filter(
    (other) =>
      other.prefix &&
      (segment.kind === null || other.kind === segment.kind) &&
      Math.sign(at(other) - at(segment)) === direction
  );
  if (others.length === 0) return null;
  const nearest = direction < 0 ? Math.max(...others.map(at)) : Math.min(...others.map(at));
  const prefixes = others.filter((other) => at(other) === nearest).map((other) => other.prefix).sort(comparePaths);
  return direction < 0 ? prefixes.at(-1) : prefixes[0];
}

/**
 * 刷られた前の段が同じ区間（前の段の無い本では、すべての区間）を、振り直しのところで
 * 部に分ける。segment.part に、その中で何部目か（0 から）を付ける。
 *
 * @returns {{count:number, mismatch:boolean}}
 */
function renumbered(segments) {
  const classes = new Map();
  for (const segment of segments) {
    if (segment.copyOf || segment.kind === null) continue;
    if (!classes.has(segment.kind)) classes.set(segment.kind, []);
    classes.get(segment.kind).push(segment);
  }
  for (const list of classes.values()) rankByBookOrder(list);
  // 歩幅の分からない（番号が 1 つだけ読めた）ファイルは、ほかに歩幅の分かる束が
  // 無いとき（番号を借りられないとき）だけなので、部は 1 つしか無い。
  for (const segment of segments) if (segment.kind === null) segment.part = 0;
  const counts = new Map([...classes].map(([kind, list]) => [kind, walk(list)]));
  const count = Math.max(1, ...counts.values());
  // 奇数頁と偶数頁の束は同じ紙の表裏なので、部の数は揃うはず。両面の束は、前付けだけ・
  // 1 部だけのことも、両面でスキャンした本の一部の紙だけを片面ずつ撮り直すこともあるので比べない。
  const mismatch = counts.has('odd') && counts.has('even') && counts.get('odd') !== counts.get('even');
  if (mismatch) for (const segment of segments) segment.part = 0;
  return { count: mismatch ? 1 : count, mismatch };
}

/**
 * 区間に、一覧の位置を本の順に揃えた値（rank）を付ける。逆順の束（裏返してスキャン
 * した）は、一覧で下にあるほど本の前のほう（束を裏返すと、最後の束から順にスキャン
 * する）。向きが分かるのは番号の読めた（手で入れた）頁が 2 つ以上あるファイルだけで、
 * 1 頁のファイルなど（歩幅を借りている）は、同じ種類の束の多いほうの向きに揃える。
 */
function rankByBookOrder(list) {
  const known = list.filter((segment) => segment.file.known >= 2);
  const reversed = known.filter((segment) => segment.step < 0).length;
  const classSign = reversed * 2 > known.length ? -1 : 1;
  for (const segment of list) {
    const sign = segment.file.known >= 2 ? Math.sign(segment.step) : classSign;
    segment.rank = sign * segment.order;
  }
}

/**
 * ファイルを、本の順（逆順のファイルは最後の頁から）に読んで、番号が戻る
 * ところと、刷られた前の段（部・編などの番号）が変わるところで切る。切ったひと続きを
 * 「区間」と呼ぶ。
 */
function splitSegments(files, numberings) {
  const segments = [];
  files.forEach((file, order) => {
    const { step, pages } = numberings.get(file.key);
    file = { ...file, known: pages.filter((page) => KNOWN.has(page.status)).length };
    const indices = pages.map((_, index) => index);
    if (step < 0) indices.reverse();
    let segment = null;
    let previous = null;
    for (const index of indices) {
      // ファイルごとに番号を入れたファイルで、頁ごとに入れた番号（その頁だけを変える）は、
      // ファイルごとの番号で見る（ordering.js）。前の段（部・編などの番号）は入れたとおり。
      const { base } = pages[index];
      const page = base ? { ...base, prefix: pages[index].prefix } : pages[index];
      const { number, branch = null } = page;
      const position = number === null ? null : slotOf(number, branch, step);
      const key = number === null ? null : prefixKey(page.prefix);
      const turns =
        position !== null &&
        ((previous !== null && position < previous) || (segment?.prefixKey != null && key !== segment.prefixKey));
      if (segment === null || turns) {
        const next = {
          id: segments.length,
          file,
          order,
          step,
          pages: [], // ファイルの中の頁の位置（本の順）
          labels: [], // pages と同じ順の頁の番号（number・branch・prefix。番号の無い頁は number が null）
          numbers: [], // 番号のある頁の、並びの上の位置（slotOf）
          keys: [], // 番号のある頁の番号（2-57-1 の形。重なりを数える）
          prefixKey: null, // 刷られた前の段（prefixKey。前の段の無い頁は ''）
          prefix: null,
          prev: segment,
          next: null,
          part: null,
          copyOf: null,
        };
        if (segment) segment.next = next;
        segment = next;
        segments.push(segment);
      }
      segment.pages.push(index);
      segment.labels.push(page);
      if (number !== null) {
        segment.prefixKey ??= key;
        segment.prefix ??= page.prefix ?? null;
        segment.numbers.push(position);
        segment.keys.push(pageNumberText(page));
        segment.last = { number, branch };
        segment.firstPage ??= { number, branch };
        previous = position;
      }
    }
  });

  for (const segment of segments) {
    const d = segment.step === null ? null : Math.abs(segment.step);
    segment.d = d;
    // つながりと部の始まりは、並びの上の位置（枝番の頁は、同じ側の元の頁の位置）で見る。
    segment.start = Math.min(...segment.numbers);
    segment.end = Math.max(...segment.numbers);
    // 奇数頁の束か偶数頁の束かは、頁の位置の偶奇の多いほう（手で直した 1 頁や、余白の読み違いに
    // 引きずられない）。同じ数なら、いちばん小さい位置の偶奇。
    const odd = segment.numbers.filter((n) => sideOf(n) === 'odd').length;
    const even = segment.numbers.length - odd;
    const side = odd === even ? sideOf(segment.start) : odd > even ? 'odd' : 'even';
    segment.kind = d === 2 ? side : d === 1 ? 'one' : null;
    const heads = segment.pages
      .map((index, i) =>
        (segment.file.pages[index].heads ?? []).map((head) => stripPageNumber(head, segment.labels[i]))
      )
      .filter((list) => list.length);
    segment.firstHeads = heads[0] ?? [];
    segment.lastHeads = heads.at(-1) ?? [];
  }
  return segments;
}

/** 番号の決まり方のうち、その頁で番号を読めた（手で入れた）もの。 */
const KNOWN = new Set(['detected', 'manual']);

/** 2 度入れたと見るのに要る、頁の文字の数。 */
const COPY_TEXT = 20;

/**
 * 同じ頁を 2 度入れた区間（文字情報が、同じ番号の頁と 1 字も違わない）。
 * 部の始まりと取り違えないよう、もとの区間と同じ部に入れる（重なりとして
 * 指摘される）。文字情報の無い頁では見分けられない。
 */
function markCopies(segments) {
  const seen = new Map();
  for (const segment of segments) {
    const texts = [];
    segment.pages.forEach((index, i) => {
      const { signature } = segment.file.pages[index];
      const label = segment.labels[i];
      const key = label.number === null ? null : pageNumberText(label);
      // 番号だけの白紙のような短い文字は、別の部の同じ番号の頁とも一致しうるので見ない。
      if (signature?.length >= COPY_TEXT && key !== null) texts.push(`${key}|${signature.hash}`);
    });
    const originals = texts.map((text) => seen.get(text));
    // 1 頁だけの一致は、別の部の同じ番号の頁が定型の文（白紙の断り書きなど）で同じことも
    // あるので、2 頁以上が同じときだけ 2 度入れたと見る。
    if (texts.length >= 2 && originals.every(Boolean)) {
      segment.copyOf = originals[0];
    } else {
      for (const text of texts) if (!seen.has(text)) seen.set(text, segment);
    }
  }
}

/**
 * 頁の、並びの上の位置。枝番の無い頁は番号のまま。片面ずつの束（歩幅 ±2）の枝番の頁
 * （加除式の本で、元の紙を差し替えたもの）は、同じ側（奇数側・偶数側）の元の頁の位置に置く。
 * 57-1・57-3（奇数側）は 57、57-2・57-4（偶数側）は 58、58-1（奇数側）は 59、58-2 は 58。
 * 束は 2 つずつ進むので、こうすると束のつながり（最後の番号 + 2）が枝番の頁をまたいでも合う。
 * 両面の束は表裏が交互に並ぶので、元の番号のまま（57-1, 57-2, 57-3 は 57 のまま進む）。
 *
 * @param {number} number
 * @param {number|null} branch
 * @param {number|null} step ファイルの歩幅
 */
function slotOf(number, branch, step) {
  if (!branch || Math.abs(step) !== 2 || sideOf(number) === sideOf(number, branch)) return number;
  return number + 1;
}

/**
 * 区間 to が、区間 from の最後の頁より後ろの頁から始まるか（並びの上の位置が同じでも）。
 * 枝番の頁のところで束が切れたとき、位置（slotOf）が同じになる: 57-1, 57-3 で終わる束の
 * 次の束が 57-5 から、…6 で終わる束の次の束が 6-2 から、58-1（位置は 59）で終わる束の
 * 次の束が 59 から始まる。
 */
function comesAfter(from, to) {
  const path = ({ number, branch }) => [number, ...(branch ?? [])];
  return comparePaths(path(to.firstPage), path(from.last)) > 0;
}

/**
 * 区間が、部の最初まで戻っているか（次の部の始まりか）。1 頁（偶数頁の束なら 2 頁）
 * 以前まで戻れば、次の部（次の部に前付けが無くても、1 頁から始まるので）。いまの部が
 * 1 頁より後から始まっていれば、その番号以前まで。それより後ろへ戻っただけなら撮り直し。
 */
function restarts(segment, low) {
  return segment.start <= Math.max(low, segment.kind === 'even' ? 2 : 1);
}

/** 柱の文字が続いているか（前の区間の最後の頁と、次の区間の最初の頁）。 */
function headsContinue(from, to) {
  return from.lastHeads.some((head) => to.firstHeads.includes(head));
}

/** 続きの候補から 1 つ選ぶ。柱の文字が続いているもの、一覧で近いもの、先にあるもの。 */
function pick(candidates, from) {
  const rank = (c) => [headsContinue(from, c) ? 0 : 1, Math.abs(c.order - from.order), c.id];
  return candidates.sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  })[0];
}

/**
 * 種類 1 つ分の区間を本の順につなぎ、部を決める。部の数を返す。
 *
 * 1 頁ずつのファイルが何百もあっても、つなぐたびに全部を見直さないよう、
 * 始まりの番号で引ける表と、始まりの番号の順に並べた列を使う。
 */
function walk(list) {
  const left = new Set(list);
  // ファイルの中で前の区間が残っているあいだは、その区間には移れない。
  const ready = (segment) => left.has(segment) && !left.has(segment.prev);
  const byStart = new Map();
  for (const segment of list) {
    if (!byStart.has(segment.start)) byStart.set(segment.start, []);
    byStart.get(segment.start).push(segment);
  }
  const queue = [...list].sort((a, b) => a.start - b.start || a.rank - b.rank || a.id - b.id);
  let first = 0; // queue のうち、ここより前は置き終えた
  let part = 0;
  let low = Infinity; // いまの部の最初の番号
  let current = null;
  const place = (segment) => {
    segment.part = part;
    left.delete(segment);
    low = Math.min(low, segment.start);
    current = segment;
  };
  const nextPart = () => {
    part++;
    low = Infinity;
  };
  // いまの区間より後の番号から始まり、本の順で from と head の間にある区間（いちばん
  // 小さい番号から始まるもの）。
  const gapAfter = (from, head) => {
    for (let i = first; i < queue.length; i++) {
      const segment = queue[i];
      if (segment.start > from.end && ready(segment) && segment.rank > from.rank && segment.rank < head.rank) {
        return segment;
      }
    }
    return null;
  };
  // いまの区間と続きの候補の間（本の順）に、番号が部の最初まで戻る区間があるか。
  // あれば、候補はその次の部の続き（部の境目が束の境目と重なるとき、番号だけ
  // では、続きがどちらの部か決められないので、一覧の順に従う）。
  const restartBetween = (from, to) => {
    // 部の最初まで戻る区間は、始まりの番号が小さいものだけ（列の頭だけを見る）。
    const limit = Math.min(from.end, Math.max(low, 2));
    for (let i = first; i < queue.length && queue[i].start <= limit; i++) {
      const h = queue[i];
      if (ready(h) && restarts(h, low) && h.rank > from.rank && h.rank < to.rank) return true;
    }
    return false;
  };

  while (left.size) {
    const forced = current && left.has(current.next) ? current.next : null;
    if (forced) {
      // 同じファイルの中で番号が戻った。最初まで戻れば次の部、途中なら撮り直し。
      if (restarts(forced, low)) nextPart();
      place(forced);
      continue;
    }
    const candidates = current
      ? [
          ...(byStart.get(current.end + current.d) ?? []),
          ...(byStart.get(current.end) ?? []).filter((c) => comesAfter(current, c)),
        ].filter((c) => ready(c) && !restartBetween(current, c))
      : [];
    if (candidates.length) {
      place(pick(candidates, current));
      continue;
    }
    while (!left.has(queue[first])) first++;
    let at = first;
    while (!ready(queue[at])) at++;
    const head = queue[at];
    // 部の最初へ戻る前に、本の順でその間にある、いまの部の抜けの先の束を置く
    // （束を入れ忘れて続きが見つからなくても、残りの束を次の部と取り違えない）。
    const gap = current && head.start <= current.end && restarts(head, low) ? gapAfter(current, head) : null;
    if (gap) {
      place(gap);
      continue;
    }
    if (current && head.start <= current.end) {
      if (!restarts(head, low)) {
        // 途中まで戻った（撮り直した束）。いちばん重なる部に入れ、つなぐ先は変えない。
        head.part = overlapPart(head, list);
        left.delete(head);
        continue;
      }
      nextPart();
    }
    place(head);
  }
  return part + 1;
}

/** 区間といちばん多く番号の重なる、置き終えた区間の部（重なりが同じなら一覧で近いもの）。 */
function overlapPart(segment, list) {
  // 枝番の頁は枝番まで同じものだけを重なりと数える（57-2 と 58 は別の頁）。
  const mine = new Set(segment.keys);
  let best = null;
  for (const other of list) {
    if (other === segment || other.part === null) continue;
    const overlap = other.keys.filter((key) => mine.has(key)).length;
    const distance = Math.abs(other.order - segment.order);
    if (!best || overlap > best.overlap || (overlap === best.overlap && distance < best.distance)) {
      best = { part: other.part, overlap, distance };
    }
  }
  return best.part;
}
