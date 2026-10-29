// 選んだファイルを 1 冊の並びにし、並びの抜け・重なりを確かめる。
//
// ファイルには役割がある。
//
//   body    本文。頁番号で並べる（奇数頁の束・偶数頁の束・両面の束）
//   front   先頭に置く（表紙・見返しなど）
//   back    末尾に置く（裏表紙など）
//   split   前半を先頭・後半を末尾に置く（表紙と裏表紙を 1 回でスキャンしたとき）
//   exclude 結合しない
//
// 本文の頁の番号は page-numbers.js が決め、ここでは並べて確かめるだけにする。
// 手で直した番号（頁ごと・ファイルごと）は、読み取った番号より優先する。

import { inferFileNumbers, manualFileNumbers, STEPS } from './page-numbers.js';

export const ROLES = {
  body: '本文（頁番号で並べる）',
  front: '先頭に置く（表紙など）',
  back: '末尾に置く（裏表紙など）',
  split: '前半を先頭・後半を末尾（表紙と裏表紙）',
  exclude: '結合しない',
};

const BOTH_NAME = /表紙.*裏表紙|表裏|表紙.*表[4４]|cover.*back/i;
const BACK_NAME = /裏表紙|表[4４]|back[\s_-]*cover|ura[\s_-]*byoshi/i;
const FRONT_NAME = /表紙|表[1１]|cover|カバー|hyoshi/i;

/**
 * ファイル名から分かる役割（表紙・裏表紙）。手掛かりが無ければ null。
 *
 * 名前で表紙と分かるファイルは、頁番号を画像から読む手間を掛けない。
 *
 * @param {string} name ファイル名
 */
export function roleFromName(name) {
  if (BOTH_NAME.test(name)) return 'split';
  if (BACK_NAME.test(name)) return 'back';
  if (FRONT_NAME.test(name)) return 'front';
  return null;
}

/**
 * ファイルの役割の初期値を決める（頁番号を読み終えてから）。
 *
 * ファイル名に「表紙」「裏表紙」とあればそれに従う。名前に手掛かりが無く、
 * 頁番号も 1 つも読めない数頁だけのファイルは、表紙と裏表紙として扱う
 * （本文の束なら、どこかの頁で番号が読めるはずなので）。決め打ちが外れても
 * 画面で役割を選び直せる。
 *
 * @param {string} name ファイル名
 * @param {{candidates:object[]}[]} pages
 */
export function guessRole(name, pages) {
  const named = roleFromName(name);
  if (named === 'split') return pages.length >= 2 ? 'split' : 'front';
  if (named) return named;
  const numbered = pages.filter((page) => page.candidates.length > 0).length;
  if (numbered === 0 && pages.length <= 4) return pages.length >= 2 ? 'split' : 'front';
  return 'body';
}

/**
 * 本文のファイルごとに、頁の番号を決める。
 *
 * 番号が 1 つしか読めず歩幅を決められないファイルは、他の本文のファイルで
 * いちばん多い歩幅を借りる（奇数頁の束が何回かに分かれていれば、どれも同じ
 * 歩幅のはずなので）。
 *
 * @param {{key:string, role:string, manual:?{start:number,step:number},
 *          pages:{candidates:object[]}[]}[]} files
 * @returns {Map<string, ReturnType<typeof inferFileNumbers>>}
 */
export function numberFiles(files) {
  const result = new Map();
  const body = files.filter((file) => file.role === 'body');
  for (const file of body) {
    result.set(
      file.key,
      file.manual
        ? manualFileNumbers(file.pages.length, file.manual.start, file.manual.step)
        : inferFileNumbers(file.pages.map((page) => page.candidates))
    );
  }

  const weights = new Map(STEPS.map((step) => [step, 0]));
  for (const numbering of result.values()) {
    if (numbering.step === null) continue;
    const known = numbering.pages.filter((page) => page.number !== null).length;
    weights.set(numbering.step, weights.get(numbering.step) + known);
  }
  let prior = null;
  for (const [step, weight] of weights) {
    if (weight > 0 && (prior === null || weight > weights.get(prior))) prior = step;
  }

  if (prior !== null) {
    for (const file of body) {
      if (file.manual || result.get(file.key).step !== null) continue;
      result.set(file.key, inferFileNumbers(file.pages.map((page) => page.candidates), { step: prior }));
    }
  }
  return result;
}

// 並べたときに同じ番号が並んだら、確かなものを先に置く。
const STATUS_RANK = { manual: 0, detected: 0, inferred: 1, conflict: 1, uncertain: 2, unknown: 3 };

/**
 * 1 冊の並びを作る。
 *
 * 先頭・末尾に置く頁は、本文と同じく「先頭の頁の番号」（coverStart）と
 * 「進み方」（coverStep。1 つずつか 1 つずつ逆順）から決まる番号の順に並べる。
 * この番号は先頭・末尾の中での順番を決めるだけで、本文の頁番号とは比べない。
 * 番号を入れていないファイルの頁は、番号を入れたものの後ろに、画面の順
 * （追加した順）で並べる。逆順のファイル（給紙の都合で最後の頁から並んだ
 * もの）は、番号を入れていなくても最後の頁から置く。
 *
 * @param {{key:string, role:string, coverStart?:number|null, coverStep?:1|-1,
 *          pages:object[]}[]} files 画面の順
 * @param {Map<string, object>} numberings numberFiles の結果
 * @param {Map<string, number>} overrides 頁ごとに手で決めた番号（頁の key → 番号）
 * @returns {{
 *   fileKey:string, pageIndex:number, pageKey:string, role:'front'|'body'|'back',
 *   number:number|null, status:string, read:object|null,
 * }[]}
 */
export function buildBookOrder(files, numberings, overrides = new Map()) {
  const front = [];
  const body = [];
  const back = [];
  // pageIndex はファイルの中の位置（逆順に置いた頁も、結合で引くのは元の頁）。
  const entry = (file, page, index, role, extra = {}) => ({
    fileKey: file.key,
    pageIndex: index,
    pageKey: page.key,
    role,
    number: null,
    status: role === 'body' ? 'unknown' : 'cover',
    read: null,
    ...extra,
  });

  files.forEach((file, fileOrder) => {
    // 先頭・末尾の頁は、番号の小さい順（逆順なら最後の頁から）に並べてから振り分ける。
    // place は並べ順（番号を入れていなければ null）。
    const step = file.coverStep === -1 ? -1 : 1;
    const pages = file.pages.map((page, index) => ({
      page,
      index,
      place: Number.isInteger(file.coverStart) ? file.coverStart + step * index : null,
    }));
    if (step === -1) pages.reverse();
    const cover = ({ page, index, place }, role) =>
      (role === 'front' ? front : back).push(entry(file, page, index, role, { place }));
    if (file.role === 'front') pages.forEach((p) => cover(p, 'front'));
    if (file.role === 'back') pages.forEach((p) => cover(p, 'back'));
    if (file.role === 'split') {
      const half = Math.ceil(pages.length / 2);
      pages.forEach((p, i) => cover(p, i < half ? 'front' : 'back'));
    }
    if (file.role !== 'body') return;
    const numbering = numberings.get(file.key);
    file.pages.forEach((page, index) => {
      const inferred = numbering?.pages[index] ?? { number: null, status: 'unknown', read: null };
      const manual = overrides.get(page.key);
      body.push(
        entry(file, page, index, 'body', {
          number: Number.isFinite(manual) ? manual : inferred.number,
          status: Number.isFinite(manual) ? 'manual' : inferred.status,
          read: inferred.read,
          fileOrder,
        })
      );
    });
  });

  body.sort((a, b) => {
    // 番号の決まらない頁は本文の最後に（並べようが無いので、目立つところへ）。
    if (a.number === null || b.number === null) {
      if (a.number !== b.number) return a.number === null ? 1 : -1;
    } else if (a.number !== b.number) {
      return a.number - b.number;
    }
    return (
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      a.fileOrder - b.fileOrder ||
      a.pageIndex - b.pageIndex
    );
  });
  body.forEach((item) => delete item.fileOrder);
  // 番号の同じ頁・番号の無い頁は、入れた順のまま（sort は安定）。
  for (const covers of [front, back]) {
    // 番号の無い頁どうしは Infinity - Infinity が NaN になるので 0 にする。
    covers.sort((a, b) => (a.place ?? Infinity) - (b.place ?? Infinity) || 0);
    covers.forEach((item) => delete item.place);
  }
  return [...front, ...body, ...back];
}

/**
 * 並びを確かめる（抜け・重なり・番号の決まらない頁）。
 *
 * 片面ずつの束（歩幅 ±2）を組み合わせたときは、紙 1 枚の表と裏が
 * 揃っているかも見る。本は表（奇数頁）から始まるので、最初の頁が偶数なら
 * その表が、最後の頁が奇数ならその裏が無い（白紙でも、スキャンしていれば
 * 番号が補われてここに並ぶはず）。
 *
 * @param {ReturnType<typeof buildBookOrder>} order
 * @param {{sheets?:boolean}} [options] sheets: 片面ずつの束を組み合わせたか
 * @returns {{level:'error'|'warn'|'info', kind:string, message:string, pageKeys:string[]}[]}
 */
export function checkSequence(order, { sheets = false } = {}) {
  const problems = [];
  const body = order.filter((item) => item.role === 'body');
  if (body.length === 0) {
    problems.push({
      level: 'error',
      kind: 'no-body',
      message: '本文のファイルがありません。ファイルの役割を確かめてください。',
      pageKeys: [],
    });
    return problems;
  }

  const unknown = body.filter((item) => item.number === null);
  if (unknown.length) {
    problems.push({
      level: 'error',
      kind: 'unknown',
      message: `頁番号を決められない頁が ${unknown.length} 頁あります（本文の最後に並べてあります）。ファイルの「先頭の番号」を入れるか、頁ごとに番号を直してください。`,
      pageKeys: unknown.map((item) => item.pageKey),
    });
  }

  const byNumber = new Map();
  for (const item of body) {
    if (item.number === null || !Number.isInteger(item.number)) continue;
    if (!byNumber.has(item.number)) byNumber.set(item.number, []);
    byNumber.get(item.number).push(item);
  }

  for (const [number, items] of byNumber) {
    if (items.length < 2) continue;
    problems.push({
      level: 'error',
      kind: 'duplicate',
      message: `${number} 頁が ${items.length} 回あります（同じ束を 2 度スキャンした・番号の読み違い）。`,
      pageKeys: items.map((item) => item.pageKey),
    });
  }

  const numbers = [...byNumber.keys()].sort((a, b) => a - b);
  if (numbers.length) {
    const missing = [];
    for (let n = numbers[0]; n <= numbers[numbers.length - 1]; n++) {
      if (!byNumber.has(n)) missing.push(n);
    }
    if (missing.length) {
      problems.push({
        level: 'error',
        kind: 'missing',
        message: `${compressRanges(missing)} 頁が見つかりません（計 ${missing.length} 頁）。束の入れ忘れ・重送の可能性があります。`,
        pageKeys: [],
        numbers: missing,
      });
    }

    if (sheets) {
      const first = numbers[0];
      const last = numbers[numbers.length - 1];
      if (first % 2 === 0) {
        problems.push({
          level: 'warn',
          kind: 'sheet-start',
          message: `最初の頁が偶数（${first} 頁）です。その表（${first - 1} 頁）が欠けていないか確かめてください。`,
          pageKeys: byNumber.get(first).map((item) => item.pageKey),
        });
      }
      if (last % 2 !== 0) {
        problems.push({
          level: 'warn',
          kind: 'sheet-end',
          message: `最後の頁が奇数（${last} 頁）です。その裏（${last + 1} 頁）が欠けていないか確かめてください（裏が白紙でスキャンしていない場合は問題ありません）。`,
          pageKeys: byNumber.get(last).map((item) => item.pageKey),
        });
      }
    }
  }

  const conflicts = body.filter((item) => item.status === 'conflict');
  if (conflicts.length) {
    problems.push({
      level: 'warn',
      kind: 'conflict',
      message: `読み取った番号が前後の並びと合わない頁が ${conflicts.length} 頁あります（並びから推定した番号で並べています）。`,
      pageKeys: conflicts.map((item) => item.pageKey),
    });
  }
  const uncertain = body.filter((item) => item.status === 'uncertain');
  if (uncertain.length) {
    problems.push({
      level: 'warn',
      kind: 'uncertain',
      message: `番号の飛びの境目にあって、位置を決めきれない頁が ${uncertain.length} 頁あります。`,
      pageKeys: uncertain.map((item) => item.pageKey),
    });
  }
  return problems;
}

/** [1,2,3,7,9,10] → "1〜3・7・9〜10" */
export function compressRanges(numbers) {
  const parts = [];
  let start = null;
  let prev = null;
  for (const n of [...numbers].sort((a, b) => a - b)) {
    if (start === null) {
      start = prev = n;
    } else if (n === prev + 1) {
      prev = n;
    } else {
      parts.push(start === prev ? `${start}` : `${start}〜${prev}`);
      start = prev = n;
    }
  }
  if (start !== null) parts.push(start === prev ? `${start}` : `${start}〜${prev}`);
  return parts.join('・');
}

/**
 * 結合した PDF に付ける頁ラベル（ビューアーに出る頁番号）。
 *
 * PDF の頁の数え方（1 枚目から 1, 2, 3…）と本の頁番号は、表紙や前付けの
 * 分だけずれる。頁ラベルを付けておくと、ビューアーで「17」と入れたときに
 * 本の 17 頁が開く。
 *
 *   表紙       「表紙」（複数頁なら 表紙1, 表紙2…）
 *   前付け     i, ii, iii…（番号が 0 以下に推定された頁）
 *   本文       本の頁番号
 *   位置を決めきれない頁 「差込」
 *   裏表紙     「裏表紙」
 *
 * 同じ形で番号が 1 つずつ進むところは 1 つの範囲にまとめる。
 *
 * @param {ReturnType<typeof buildBookOrder>} order
 * @returns {{start:number, style:'D'|'r'|null, prefix:string, first:number}[]}
 */
export function pageLabelRanges(order) {
  const fronts = order.filter((item) => item.role === 'front').length;
  const backs = order.filter((item) => item.role === 'back').length;
  let frontMatter = 0;
  let frontSeen = 0;
  let backSeen = 0;

  const labels = order.map((item) => {
    if (item.role === 'front') {
      frontSeen++;
      return fronts > 1 ? { style: 'D', prefix: '表紙', number: frontSeen } : { style: null, prefix: '表紙', number: 0 };
    }
    if (item.role === 'back') {
      backSeen++;
      return backs > 1 ? { style: 'D', prefix: '裏表紙', number: backSeen } : { style: null, prefix: '裏表紙', number: 0 };
    }
    if (item.number === null || !Number.isInteger(item.number)) return { style: null, prefix: '差込', number: 0 };
    if (item.number <= 0) {
      frontMatter++;
      return { style: 'r', prefix: '', number: frontMatter };
    }
    return { style: 'D', prefix: '', number: item.number };
  });

  const ranges = [];
  labels.forEach((label, index) => {
    const current = ranges[ranges.length - 1];
    const continues =
      current &&
      current.style !== null &&
      current.style === label.style &&
      current.prefix === label.prefix &&
      label.number === current.first + (index - current.start);
    if (!continues) ranges.push({ start: index, style: label.style, prefix: label.prefix, first: label.number || 1 });
  });
  return ranges;
}

/** 小文字のローマ数字（頁ラベルの前付け。PDF の /r と同じ書き方）。 */
export function romanNumeral(number) {
  const table = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let rest = number;
  let text = '';
  for (const [value, letters] of table) {
    while (rest >= value) {
      text += letters;
      rest -= value;
    }
  }
  return text;
}

/**
 * 頁ラベルの範囲から、頁ごとのラベルの文字列を作る（ビューアーに出るもの）。
 *
 * 結合した PDF を読み直したときに、書き込んだとおりのラベルが付いているかを
 * 確かめるのに使う。
 *
 * @param {ReturnType<typeof pageLabelRanges>} ranges
 * @param {number} count 頁数
 */
export function pageLabelTexts(ranges, count) {
  const texts = [];
  let current = null;
  let next = 0;
  for (let index = 0; index < count; index++) {
    while (next < ranges.length && ranges[next].start <= index) current = ranges[next++];
    if (!current) {
      texts.push(String(index + 1));
      continue;
    }
    const number = current.first + (index - current.start);
    const body = current.style === 'D' ? String(number) : current.style === 'r' ? romanNumeral(number) : '';
    texts.push(`${current.prefix}${body}`);
  }
  return texts;
}

/**
 * 頁が奇数側か偶数側か（スキャンの位置のずれを、同じ側の頁どうしで比べるため）。
 *
 * @param {number|null} number
 * @returns {'odd'|'even'|null}
 */
export function sideOf(number) {
  if (number === null || !Number.isInteger(number)) return null;
  return Math.abs(number) % 2 === 1 ? 'odd' : 'even';
}
