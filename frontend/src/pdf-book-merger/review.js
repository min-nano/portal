// 確認の画面に出すもの（頁ごとの指摘・一覧の並び・まとめ）を組み立てる。
//
// 頁番号の並び（ordering.js）、スキャンの検査（image-checks.js）、文字情報の
// 有無を、頁ごとの「確認が要ること」にまとめる。DOM には触らない。

import { formatNumber } from './page-numbers.js';

/** 番号の決まり方の見出し（頁の下に小さく出す）。 */
export const STATUS_LABEL = {
  detected: '読取',
  inferred: '推定',
  manual: '手入力',
  conflict: '要確認',
  uncertain: '要確認',
  unknown: '不明',
  cover: '',
};

/** 頁の見出し（一覧・拡大表示）。 */
export function displayLabel(entry) {
  if (entry.role === 'front') return '表紙';
  if (entry.role === 'back') return '裏表紙';
  return entry.number === null ? '番号不明' : `${formatNumber(entry.number)} 頁`;
}

/**
 * 頁ごとの「確認が要ること」をまとめる。
 *
 * @param {ReturnType<import('./ordering.js').buildBookOrder>} order
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
        message: `読み取った番号（${entry.read?.value}）が前後の並びと合いません`,
      });
    } else if (entry.status === 'uncertain') {
      add(entry.pageKey, {
        kind: 'uncertain',
        level: 'warn',
        message: '番号の飛びの境目にあり、位置を決めきれません',
      });
    } else if (entry.status === 'unknown') {
      add(entry.pageKey, { kind: 'unknown', level: 'error', message: '頁番号を決められません' });
    }
  }

  // 本全体の指摘のうち、特定の頁に結び付くもの（頁の下には短く出す）。
  const SHORT = {
    duplicate: { level: 'error', message: '同じ番号の頁が他にもあります' },
    'sheet-start': { level: 'warn', message: '最初の頁が偶数です（その表が無い）' },
    'sheet-end': { level: 'warn', message: '最後の頁が奇数です（その裏が無い）' },
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

/** これより長く抜けていたら、1 枚の札にまとめて出す。 */
const MAX_MISSING_CARDS = 6;

/**
 * 一覧に並べるもの。頁のほかに、抜けている頁の札を、あるべき位置に挟む。
 *
 * @param {ReturnType<import('./ordering.js').buildBookOrder>} order
 * @returns {({type:'page', entry:object} | {type:'missing', from:number, to:number})[]}
 */
export function gridItems(order) {
  const items = [];
  let previous = null;
  for (const entry of order) {
    const n = entry.role === 'body' && Number.isInteger(entry.number) ? entry.number : null;
    if (n !== null && previous !== null && n > previous + 1) {
      const from = previous + 1;
      const to = n - 1;
      if (to - from + 1 > MAX_MISSING_CARDS) {
        items.push({ type: 'missing', from, to });
      } else {
        for (let m = from; m <= to; m++) items.push({ type: 'missing', from: m, to: m });
      }
    }
    if (n !== null) previous = n;
    items.push({ type: 'page', entry });
  }
  return items;
}

/**
 * 文字情報の有無。
 *
 * 本のどこかに文字情報があるのに、ある頁だけ無ければ、その頁を指摘する
 * （OCR を掛け忘れた束が混ざっている、など）。どこにも無ければ、本全体の
 * 指摘として 1 つだけ返す。
 *
 * @param {ReturnType<import('./ordering.js').buildBookOrder>} order
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
