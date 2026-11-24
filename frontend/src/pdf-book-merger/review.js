// 確認の画面に出すもの（頁ごとの指摘・一覧の並び・まとめ）を組み立てる。
//
// 頁番号の並び（ordering.js）、スキャンの検査（image-checks.js）、文字情報の
// 有無を、頁ごとの「確認が要ること」にまとめる。DOM には触らない。

import { branchLayout } from './ordering.js';
import { formatNumber, pathText } from './page-numbers.js';
import { TEXT_QUALITY_MESSAGE } from './text-quality.js';

/** 番号の決まり方の見出し（頁の下に小さく出す）。 */
export const STATUS_LABEL = {
  detected: '読取',
  inferred: '推定',
  manual: '手入力',
  conflict: '要確認',
  uncertain: '要確認',
  unknown: '不明',
  unplaced: '不明',
  cover: '',
  listed: '',
};

/** 頁の見出し（一覧・拡大表示）。 */
export function displayLabel(entry) {
  // 一覧の位置で置いた、表紙と分からない頁（本文の無い結合・付録など）。
  if (entry.status === 'listed') return '番号なし';
  if (entry.role === 'front') return '表紙';
  if (entry.role === 'back') return '裏表紙';
  if (entry.number === null) return '番号不明';
  return `${partPrefix(entry)}${formatNumber(entry.number, entry.branch, entry.prefix)} 頁`;
}

/**
 * 振り直しを推定して部に分けたときの頁の見出しの頭（「第 2 部 」）。頁番号の前に刷られた
 * 部・編などの番号で分かる部（2-21 頁）には付けない。
 *
 * @param {{partLabel?:string}} item 頁か抜けの札
 */
export function partPrefix(item) {
  return item.partLabel ? `${item.partLabel} ` : '';
}

/**
 * 頁ごとの「確認が要ること」をまとめる。
 *
 * @param {ReturnType<import('./ordering.js').arrangeBook>['order']} order
 * @param {ReturnType<import('./ordering.js').checkSequence>} problems
 * @param {Map<string, {kind:string, level:string, message:string}[]>} scanIssues
 * @param {Set<string>} textless 文字情報の無い頁の key（本の他の頁にはある場合）
 * @returns {Map<string, {kind:string, level:'error'|'warn'|'info', message:string}[]>}
 */
export function pageIssues(order, problems, scanIssues, textless = new Set()) {
  const issues = new Map();
  const add = (key, issue) => {
    if (!issues.has(key)) issues.set(key, []);
    issues.get(key).push(issue);
  };

  for (const entry of order) {
    if (entry.status === 'conflict') {
      add(entry.pageKey, {
        kind: 'conflict',
        level: 'warn',
        message: `読み取った番号（${pathText(entry.read.path)}）が前後の並びと合いません`,
      });
    } else if (entry.status === 'uncertain') {
      add(entry.pageKey, {
        kind: 'uncertain',
        level: 'warn',
        message: '番号の飛びの境目にあり、位置を決めきれません',
      });
    } else if (entry.status === 'unknown') {
      add(entry.pageKey, { kind: 'unknown', level: 'error', message: '頁番号を決められません' });
    } else if (entry.status === 'unplaced' && entry.number !== null) {
      // 前の段（部・編などの番号）の無い頁で、前後の部から置き場所を決められなかった（ordering.js）。
      add(entry.pageKey, {
        kind: 'section-unplaced',
        level: 'error',
        message: '部・編などの番号が無く、前後の部の並びが食い違うので置き場所を決められません',
      });
    } else if (entry.status === 'unplaced') {
      add(entry.pageKey, {
        kind: 'unplaced',
        level: 'error',
        message: '番号が無く、本文のファイルの間にあるので置き場所を決められません',
      });
    }
  }

  // 本全体の指摘のうち、特定の頁に結び付くもの（頁の下には短く出す）。
  const SHORT = {
    duplicate: { level: 'error', message: '同じ番号の頁が他にもあります' },
    'sheet-start': { level: 'warn', message: '最初の頁が偶数です（その表が無い）' },
    'sheet-end': { level: 'warn', message: '最後の頁が奇数です（その裏が無い）' },
    listed: { level: 'warn', message: '頁番号を読めず、一覧の位置で置いています' },
    'cover-numbers': { level: 'warn', message: '名前から表紙と見ましたが、本文の頁かもしれません' },
  };
  for (const problem of problems) {
    const short = SHORT[problem.kind];
    if (!short) continue;
    for (const key of problem.pageKeys) add(key, { kind: problem.kind, ...short });
  }

  for (const [key, list] of scanIssues) list.forEach((issue) => add(key, issue));
  for (const key of textless) {
    add(key, { kind: 'textless', level: 'info', message: '文字情報がありません（この頁は検索できません）' });
  }
  return issues;
}

/** 頁に付いた指摘のうち、いちばん重いもの（一覧の枠の色に使う）。 */
export function worstLevel(list) {
  if (!list || list.length === 0) return null;
  if (list.some((issue) => issue.level === 'error')) return 'error';
  if (list.some((issue) => issue.level === 'warn')) return 'warn';
  return 'info';
}

/** スキャンの検査など、頁ごとに付く指摘を、種類ごとの項目にまとめるときの言い方。 */
const PAGE_KIND_TEXT = {
  skew: ['warn', '傾いている頁'],
  shift: ['warn', '中身の位置がずれている頁'],
  size: ['warn', '大きさが他と違う頁'],
  orientation: ['warn', '向きが他と違う頁'],
  streak: ['warn', 'すじが入っている頁'],
  blank: ['info', '白紙の頁'],
  text: ['warn', '文字情報（OCR の結果）が文字化けしている・文として読めない頁'],
  textless: ['info', '文字情報の無い頁'],
};

const LEVEL_RANK = { error: 0, warn: 1, info: 2 };

/**
 * 確認の画面の上に並べる項目。本全体の指摘（抜け・重なり・番号の食い違いなど）と、
 * 頁ごとの指摘（スキャンの傾き・すじなど）を種類ごとに数えたものを、重いものから
 * 並べる。項目ごとに、該当する頁の key を本の順で持つ（開くとその頁だけを並べる）。
 *
 * @param {ReturnType<import('./ordering.js').arrangeBook>['order']} order
 * @param {{level:string, kind:string, message:string, pageKeys:string[], number?:number}[]} problems
 * @param {Map<string, {kind:string}[]>} issues pageIssues の結果
 * @returns {{key:string, level:'error'|'warn'|'info', message:string, pageKeys:string[]}[]}
 */
export function issueGroups(order, problems, issues) {
  // 項目の key は、頁を直しても変わらないものにする（開閉を key で覚えるので）。
  // 番号ごとに出る指摘（重なり、枝番の頁の抜け・差し替え）は、その番号で分ける。
  // 同じ頁の重なりは、本全体の指摘には組ごとに後ろの頁しか挙がっていないので、
  // 開いたときに見比べられるよう、重なっている頁をすべて（本の順に）並べる。
  const samePages = order
    .filter((entry) => (issues.get(entry.pageKey) || []).some((issue) => issue.kind === 'same-page'))
    .map((entry) => entry.pageKey);
  const groups = problems.map((problem) => ({
    key: problem.number === undefined ? problem.kind : `${problem.kind}:${problem.number}`,
    level: problem.level,
    message: problem.message,
    pageKeys: problem.kind === 'same-page' ? samePages : problem.pageKeys,
  }));
  const byKind = new Map(Object.keys(PAGE_KIND_TEXT).map((kind) => [kind, new Set()]));
  for (const entry of order) {
    for (const issue of issues.get(entry.pageKey) || []) byKind.get(issue.kind)?.add(entry.pageKey);
  }
  for (const [kind, keys] of byKind) {
    if (keys.size === 0) continue;
    const [level, text] = PAGE_KIND_TEXT[kind];
    groups.push({ key: kind, level, message: `${text}が ${keys.size} 頁あります。`, pageKeys: [...keys] });
  }
  // 重いものを上に（sort は安定なので、同じ重さの中では、もとの順のまま）。
  return groups.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
}

/** これより長く抜けていたら、1 枚の札にまとめて出す。 */
const MAX_MISSING_CARDS = 6;

/**
 * 一覧に並べるもの。頁のほかに、抜けている頁の札を、あるべき位置に挟む
 * （部が変わったところでは、番号が戻るので挟まない）。
 *
 * 枝番の頁に差し替えられたとみなす番号（ordering.js の branchLayout。部ごと）には
 * 札を挟まない。枝番の抜け（57-1 と 57-3 の間の 57-2）には、枝番を付けた札を挟む
 * （入れ子の枝番 57-1-2 も段ごとに。下の段の枝番の頁に差し替えられた枝番の頁には挟まない）。
 *
 * @param {ReturnType<import('./ordering.js').arrangeBook>['order']} order
 * @returns {({type:'page', entry:object} |
 *   {type:'missing', from:number, to:number, branch?:number[], prefix?:number[], part:number|null,
 *    partLabel?:string})[]}
 */
export function gridItems(order) {
  const isNumbered = (entry) => entry.role === 'body' && Number.isInteger(entry.number);
  const byPart = new Map();
  for (const entry of order.filter(isNumbered)) {
    if (!byPart.has(entry.part)) byPart.set(entry.part, []);
    byPart.get(entry.part).push(entry);
  }
  const layouts = new Map([...byPart].map(([part, entries]) => [part, branchLayout(entries)]));
  const items = [];
  let previous = null;
  // 抜けの札の部（前の頁と同じ部）。
  const where = () => {
    const { part, prefix, partLabel } = previous;
    return { part, ...(prefix ? { prefix } : {}), ...(partLabel ? { partLabel } : {}) };
  };
  const missing = (from, to) => {
    if (to - from + 1 > MAX_MISSING_CARDS) {
      items.push({ type: 'missing', from, to, ...where() });
    } else {
      for (let m = from; m <= to; m++) items.push({ type: 'missing', from: m, to: m, ...where() });
    }
  };
  for (const entry of order) {
    if (!isNumbered(entry)) {
      items.push({ type: 'page', entry });
      continue;
    }
    // 部が変わったところでは、番号が戻るので比べない。
    if (previous !== null && previous.part === entry.part) {
      const { replaced, covered } = layouts.get(entry.part);
      let from = null;
      for (let m = previous.number + 1; m <= entry.number; m++) {
        const absent = m < entry.number && !replaced.has(m);
        if (absent && from === null) from = m;
        if (!absent && from !== null) {
          missing(from, m - 1);
          from = null;
        }
      }
      // 枝番の抜け。前の頁と同じところまでは比べず、違う段からは前の頁の次（前の頁に
      // その段が無ければ 1）から、それより下の段は 1 から数える。
      const before = [previous.number, ...(previous.branch ?? [])];
      const after = [entry.number, ...(entry.branch ?? [])];
      let same = 0;
      while (same < Math.min(before.length, after.length) && before[same] === after[same]) same++;
      for (let level = Math.max(same, 1); level < after.length; level++) {
        const first = level === same && level < before.length ? before[level] + 1 : 1;
        for (let b = first; b < after[level]; b++) {
          const path = [...after.slice(0, level), b];
          if (covered.has(pathText(path))) continue;
          items.push({ type: 'missing', from: entry.number, to: entry.number, branch: path.slice(1), ...where() });
        }
      }
    }
    previous = entry;
    items.push({ type: 'page', entry });
  }
  return items;
}

/**
 * 抜けている頁の札の見出し（58 頁・60〜70 頁・57-2 頁。振り直しで部に分けていれば
 * 「第 2 部 58 頁」、前の段のある頁は「2-58 頁」「2-60〜2-70 頁」）。
 */
export function missingLabel(item) {
  const part = partPrefix(item);
  const head = item.prefix ? `${pathText(item.prefix)}-` : '';
  if (item.branch) return `${part}${head}${pathText([item.from, ...item.branch])} 頁`;
  return `${part}${item.from === item.to ? `${head}${item.from} 頁` : `${head}${item.from}〜${head}${item.to} 頁`}`;
}

/**
 * 文字情報の有無。
 *
 * 本のどこかに文字情報があるのに、ある頁だけ無ければ、その頁を指摘する
 * （OCR を掛け忘れた束が混ざっている、など）。どこにも無ければ、本全体の
 * 指摘として 1 つだけ返す。
 *
 * @param {ReturnType<import('./ordering.js').arrangeBook>['order']} order
 * @param {(entry:object) => {signature:{length:number}}} pageOf
 * @returns {{textless:Set<string>, problem:object|null}}
 */
export function textCoverage(order, pageOf) {
  const body = order.filter((entry) => entry.role === 'body');
  const without = body.filter((entry) => pageOf(entry).signature.length === 0);
  if (body.length > 0 && without.length === body.length) {
    return {
      textless: new Set(),
      problem: {
        level: 'warn',
        kind: 'no-text',
        message:
          '本文に文字情報（OCR の結果）が 1 頁もありません。サーチャブル PDF でないため、結合しても検索はできません。',
        pageKeys: [],
      },
    };
  }
  return { textless: new Set(without.map((entry) => entry.pageKey)), problem: null };
}

/**
 * 文字情報（OCR の結果）の確かめ（text-quality.js）を、頁ごとの指摘にする。
 *
 * @param {ReturnType<import('./ordering.js').arrangeBook>['order']} order
 * @param {(entry:object) => {textCheck?:{kind:string, sample:string}|null}} pageOf
 * @returns {Map<string, {kind:'text', level:'warn', message:string}[]>}
 */
export function textIssues(order, pageOf) {
  const issues = new Map();
  for (const entry of order) {
    const check = pageOf(entry).textCheck;
    if (!check) continue;
    issues.set(entry.pageKey, [
      { kind: 'text', level: 'warn', message: `${TEXT_QUALITY_MESSAGE[check.kind]}（「${check.sample}」）` },
    ]);
  }
  return issues;
}

/** 頁ごとの指摘をいくつか、1 つにまとめる（同じ頁の指摘は、渡した順に並べる）。 */
export function mergeIssues(...maps) {
  const merged = new Map();
  for (const map of maps) {
    for (const [key, list] of map) merged.set(key, [...(merged.get(key) ?? []), ...list]);
  }
  return merged;
}

/**
 * ファイル名から、結合した PDF の名前を考える。
 *
 * 「吾輩は猫である_奇数1.pdf」「吾輩は猫である_偶数1.pdf」「吾輩は猫である_表紙.pdf」
 * なら「吾輩は猫である.pdf」。共通する頭から、束の番号や「奇数」「表紙」などを落とす。
 *
 * @param {string[]} names
 */
export function suggestBookName(names) {
  const stems = names.map((name) => String(name).replace(/\.pdf$/i, '')).filter(Boolean);
  if (stems.length === 0) return '';
  let prefix = stems[0];
  for (const stem of stems.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < stem.length && prefix[i] === stem[i]) i++;
    prefix = prefix.slice(0, i);
  }
  const TRAIL = /[\s_\-－ー‐・.,、（）()[\]［］0-9０-９]+$|(?:奇数|偶数|表紙|裏表紙|本文|odd|even|cover)$/i;
  let name = prefix;
  for (let previous = null; previous !== name; ) {
    previous = name;
    name = name.replace(TRAIL, '');
  }
  return name ? `${name}.pdf` : '';
}
