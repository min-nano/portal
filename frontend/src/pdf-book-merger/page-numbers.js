// 頁番号の読み取りと、ファイルの中での並びの推定。
//
// 裁断した本をスキャンすると、1 冊が次のような複数のファイルになる。
//
//   奇数頁の束（1, 3, 5, …）を何回かに分けて   … 1 ファイルの中では 2 つずつ進む
//   偶数頁の束（2, 4, 6, …）を何回かに分けて   … 束を裏返すと逆順（…, 6, 4, 2）
//   表紙・裏表紙                               … 頁番号が無い
//
// 頁番号は、スキャンの文字情報（サーチャブル PDF の透明テキスト）か、画像の
// 余白を OCR した結果から「候補」として拾う。ここで決めるのは次の 2 つだけで、
// どちらも DOM にも pdf.js にも触らない（テストで縛るため）。
//
//   1. 1 頁ぶんの文字（位置つき）から、頁番号らしい数字の候補を挙げる
//   2. ファイルの中の頁の候補を並べて、頁ごとの番号を決める
//
// 2 は「1 頁ずつ読めた数字を信じる」のではなく、**ファイルの中では番号が
// 一定の歩幅で進む**ことを使って決める。章の扉のように番号が刷られていない
// 頁は前後から補い、読み違えた 1 頁は前後と合わないので外れ値として扱う。
// 前付けのように番号の無い頁がファイルの先頭にあっても、歩幅を延ばして
// 0 以下の番号が付くので、並べたときに 1 頁より前に来る。

/** 頁の上下の、頁番号を探す帯の高さ（頁の高さに対する割合）。 */
export const MARGIN_ZONE = 0.14;

/** 頁番号として受け付ける値の上限（年号などを拾わないため）。 */
const MAX_PAGE_NUMBER = 1999;

/** 歩幅の候補。片面ずつ（奇数・偶数の束）なら ±2、両面なら ±1。 */
export const STEPS = [2, -2, 1, -1];

/**
 * 「番号だけが置かれている行」の形。前後の飾り（- 12 -、(12)、p.12、12頁）を許す。
 * ハイフンの類は、OCR がよく取り違えるものまで含めておく。
 */
const STANDALONE = /^[\s\-–—−‐‑‒－ー~〜・.,()（）[\]［］〔〕<>《》|｜]*(?:p\.?|P\.?|page|ページ|頁)?\s*(\d{1,4})\s*(?:頁|ページ)?[\s\-–—−‐‑‒－ー~〜・.,()（）[\]［］〔〕<>《》|｜]*$/;

/** 行の先頭・末尾に付いた番号（柱に頁番号が並んでいる形）。 */
const LEADING = /^(\d{1,4})[\s　]+\S/;
const TRAILING = /\S[\s　]+(\d{1,4})$/;

/** 全角の数字を半角へ。OCR の結果も文字情報も、どちらも全角で来ることがある。 */
export function normalizeDigits(text) {
  return String(text ?? '').replace(/[０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  );
}

/**
 * 位置つきの文字の断片を、行にまとめる。
 *
 * item は { text, x0, x1, y, h }。座標は頁の幅・高さを 1 とした割合で、y は
 * 文字の基準線の高さ（上が 0）、h は文字の高さ。OCR の透明テキストは 1 文字
 * ずつの断片になっていることが多く、そのままでは「12」が「1」と「2」に
 * 分かれてしまうため、同じ高さに並んでいるものをつなげて読む。
 */
export function groupLines(items) {
  const sorted = items
    .filter((item) => item && String(item.text ?? '').trim())
    .slice()
    .sort((a, b) => a.y - b.y || a.x0 - b.x0);

  const lines = [];
  for (const item of sorted) {
    const tolerance = Math.max(item.h, 0.004) * 0.5;
    const line = lines.find(
      (candidate) => Math.abs(candidate.y - item.y) <= Math.max(tolerance, candidate.h * 0.5)
    );
    if (line) {
      line.items.push(item);
      line.h = Math.max(line.h, item.h);
    } else {
      lines.push({ y: item.y, h: item.h, items: [item] });
    }
  }

  return lines.map((line) => {
    const parts = line.items.slice().sort((a, b) => a.x0 - b.x0);
    let text = '';
    let right = null;
    for (const part of parts) {
      // 字の間が開いていれば区切る（柱の文字と頁番号をくっつけないため）。
      if (right !== null && part.x0 - right > Math.max(line.h, 0.004) * 0.6) text += ' ';
      text += String(part.text);
      right = part.x1;
    }
    return {
      text: normalizeDigits(text).replace(/\s+/g, ' ').trim(),
      x0: Math.min(...parts.map((part) => part.x0)),
      x1: Math.max(...parts.map((part) => part.x1)),
      y: line.y,
      h: line.h,
    };
  });
}

/** 頁番号の置き場所らしさ（上下の端・外側の角・中央）。 */
function placementScore(line) {
  let score = 0;
  // 端に近いほど頁番号らしい（本文の 1 行目・最終行より外側）。
  if (line.y < MARGIN_ZONE * 0.5 || line.y > 1 - MARGIN_ZONE * 0.5) score += 0.5;
  const center = (line.x0 + line.x1) / 2;
  if (center < 0.25 || center > 0.75 || Math.abs(center - 0.5) < 0.1) score += 0.5;
  return score;
}

/**
 * 1 頁ぶんの文字から、頁番号の候補を挙げる。
 *
 * 見るのは上下の余白の帯だけ。本文の中の数字（「第 3 章」「図 12」）は
 * 拾わない。番号だけが置かれた行は強い候補、柱の先頭・末尾に付いた番号は
 * 弱い候補とする（柱には章番号や年号が混ざることがあるので）。
 *
 * @param {{text:string,x0:number,x1:number,y:number,h:number}[]} items
 * @param {string} [source] 'text'（文字情報）か 'ocr'（画像から読み取り）
 * @returns {{value:number, score:number, source:string, zone:'top'|'bottom'}[]}
 */
export function pageNumberCandidates(items, source = 'text') {
  const found = new Map();
  for (const line of groupLines(items)) {
    const zone = line.y < MARGIN_ZONE ? 'top' : line.y > 1 - MARGIN_ZONE ? 'bottom' : null;
    if (!zone || line.text.length > 80) continue;

    const standalone = line.text.match(STANDALONE);
    const matches = standalone
      ? [{ value: standalone[1], score: 3 }]
      : [line.text.match(LEADING), line.text.match(TRAILING)]
          .filter(Boolean)
          .map((match) => ({ value: match[1], score: 1.5 }));

    for (const match of matches) {
      const value = Number(match.value);
      if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_NUMBER) continue;
      const score = match.score + placementScore(line);
      const previous = found.get(value);
      if (!previous || previous.score < score) found.set(value, { value, score, source, zone });
    }
  }
  return [...found.values()].sort((a, b) => b.score - a.score || a.value - b.value);
}

/** 強い候補（番号だけの行）とみなす点数。外れたときに「食い違い」として出す。 */
export const STRONG_SCORE = 3;

// 番号の並び（ずれ）を切り替える費用。読み違えた 1 頁（点数 3〜4）のために
// 2 回切り替える（往復 2 × 5）よりは、その 1 頁を外れ値とみなすほうが安い。
// 2 頁以上続けてずれていれば（6〜8 点）、切り替えたほうが得になる。
const SWITCH_COST = 5;

/**
 * そのファイルの中で番号が進む歩幅を、近くの頁どうしの候補の差から多数決で選ぶ。
 *
 * @param {{value:number,score:number}[][]} candidates 頁ごとの候補
 * @returns {{step:number|null, votes:number}}
 */
export function detectStep(candidates) {
  const votes = new Map(STEPS.map((step) => [step, 0]));
  const anchored = candidates
    .map((list, index) => ({ list, index }))
    .filter((page) => page.list.length > 0);

  for (let a = 0; a < anchored.length; a++) {
    for (let b = a + 1; b < anchored.length && anchored[b].index - anchored[a].index <= 3; b++) {
      const distance = anchored[b].index - anchored[a].index;
      for (const first of anchored[a].list) {
        for (const second of anchored[b].list) {
          const step = (second.value - first.value) / distance;
          if (votes.has(step)) {
            votes.set(step, votes.get(step) + Math.min(first.score, second.score));
          }
        }
      }
    }
  }

  let best = { step: null, votes: 0 };
  for (const [step, count] of votes) {
    if (count > best.votes) best = { step, votes: count };
  }
  return best;
}

/**
 * ファイルの中の頁ごとの番号を決める。
 *
 * 番号 = ずれ + 歩幅 × 頁の位置、として、頁ごとに「ずれ」を選ぶ。ずれは
 * 基本的に一定で、変わる（番号の数えられない差し込みの図版がある、など）
 * には費用が掛かる、という条件で、候補の点数の合計がいちばん大きくなる
 * 選び方を求める（ビタビ法）。こうすると、
 *
 *   - 番号の刷られていない頁は、前後と同じずれで番号が決まる（推定）
 *   - 読み違えた 1 頁は、前後と合わないので無視される（食い違い）
 *   - 本当に番号が飛んでいるところでは、ずれが切り替わる
 *
 * ずれが切り替わる境目にある、番号の読めなかった頁は、どちらに属すか
 * 決められないので「要確認」にする。
 *
 * @param {{value:number,score:number,source:string}[][]} candidates 頁ごとの候補
 * @param {{step?:number}} [options] 歩幅が分かっているとき（他のファイルから）
 * @returns {{
 *   step: number|null,
 *   pages: {number:number|null, status:string, read:object|null}[],
 * }}
 *   status は detected（読めた番号どおり）/ inferred（前後から推定）/
 *   conflict（読めた番号が前後と食い違う）/ uncertain（ずれの境目で決められない）/
 *   unknown（ファイルの中に手掛かりが無い）
 */
export function inferFileNumbers(candidates, options = {}) {
  const count = candidates.length;
  const step = options.step ?? detectStep(candidates).step;
  const unknown = () => ({
    step: step ?? null,
    pages: candidates.map(() => ({ number: null, status: 'unknown', read: null })),
  });
  if (step === null || step === undefined) return unknownOrSingle(candidates, unknown);

  // 状態 = ずれ。候補が示すずれだけを状態にする。
  const offsets = [
    ...new Set(candidates.flatMap((list, index) => list.map((c) => c.value - step * index))),
  ];
  if (offsets.length === 0) return unknown();

  const emission = (index, offset) => {
    const hit = candidates[index].find((c) => c.value - step * index === offset);
    return hit ? hit.score : 0;
  };

  // score[k] = 頁 i までを見て、頁 i のずれが offsets[k] のときの最大点。
  let score = offsets.map((offset) => emission(0, offset));
  const back = [offsets.map((_, k) => k)];
  for (let i = 1; i < count; i++) {
    let bestPrev = 0;
    for (let k = 1; k < offsets.length; k++) if (score[k] > score[bestPrev]) bestPrev = k;
    const next = [];
    const from = [];
    for (let k = 0; k < offsets.length; k++) {
      const stay = score[k];
      const jump = score[bestPrev] - SWITCH_COST;
      if (stay >= jump) {
        next.push(stay + emission(i, offsets[k]));
        from.push(k);
      } else {
        next.push(jump + emission(i, offsets[k]));
        from.push(bestPrev);
      }
    }
    score = next;
    back.push(from);
  }

  let last = 0;
  for (let k = 1; k < offsets.length; k++) if (score[k] > score[last]) last = k;
  const chosen = new Array(count);
  chosen[count - 1] = last;
  for (let i = count - 1; i > 0; i--) chosen[i - 1] = back[i][chosen[i]];

  const pages = candidates.map((list, index) => {
    const number = offsets[chosen[index]] + step * index;
    const hit = list.find((c) => c.value === number) || null;
    if (hit) return { number, status: 'detected', read: hit };
    const strong = list.find((c) => c.score >= STRONG_SCORE) || null;
    return { number, status: strong ? 'conflict' : 'inferred', read: strong };
  });

  markUncertainGaps(pages, chosen);
  return { step, pages };
}

/**
 * 歩幅が決められない（番号の読めた頁が 1 つ以下の）ファイル。
 *
 * 読めた頁が 1 つだけなら、その頁にだけ番号を付ける（並べる手掛かりには
 * なるが、残りの頁は決められない）。
 */
function unknownOrSingle(candidates, unknown) {
  const result = unknown();
  candidates.forEach((list, index) => {
    const strong = list.find((c) => c.score >= STRONG_SCORE);
    if (strong) result.pages[index] = { number: strong.value, status: 'detected', read: strong };
  });
  return result;
}

/** ずれが切り替わる境目の、番号の読めなかった頁に「要確認」を付ける。 */
function markUncertainGaps(pages, chosen) {
  let lastAnchor = -1;
  for (let i = 0; i < pages.length; i++) {
    if (pages[i].status !== 'detected') continue;
    if (lastAnchor >= 0 && chosen[i] !== chosen[lastAnchor]) {
      for (let j = lastAnchor + 1; j < i; j++) {
        if (pages[j].status === 'inferred') pages[j].status = 'uncertain';
      }
    }
    lastAnchor = i;
  }
}

/**
 * 番号を手で決めたファイル（先頭の番号と歩幅）。
 *
 * @param {number} count 頁数
 * @param {number} start 1 頁目の番号
 * @param {number} step 歩幅
 */
export function manualFileNumbers(count, start, step) {
  return {
    step,
    pages: Array.from({ length: count }, (_, index) => ({
      number: start + step * index,
      status: 'manual',
      read: null,
    })),
  };
}

/**
 * 番号の付き方を 1 行で言い表す（ファイルの一覧に出す）。
 *
 * @param {{step:number|null, pages:{number:number|null}[]}} numbering
 */
export function describeNumbering(numbering) {
  const numbers = numbering.pages.map((page) => page.number).filter((n) => n !== null);
  if (numbers.length === 0) return '頁番号を読み取れませんでした';
  const first = numbers[0];
  const last = numbers[numbers.length - 1];
  const step = numbering.step;
  const kind =
    step === 2 || step === -2
      ? first % 2 === 0
        ? '偶数頁'
        : '奇数頁'
      : step === 1 || step === -1
        ? '連続した頁'
        : '頁';
  const order = step < 0 ? '（逆順）' : '';
  return `${kind}${order} ${formatNumber(first)}〜${formatNumber(last)}`;
}

/** 頁番号の表示。前付け（0 以下）は「前付」と分かるようにする。 */
export function formatNumber(number) {
  if (number === null || number === undefined) return '?';
  if (!Number.isInteger(number)) return `${Math.floor(number)}と${Math.ceil(number)}の間`;
  return number <= 0 ? `前付(${number})` : String(number);
}
