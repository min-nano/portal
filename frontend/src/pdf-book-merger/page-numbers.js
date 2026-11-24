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
//
// ハイフンで区切った頁番号（57-1・2-21・2-2-21-3）は、区切った数字の列（path）として
// 読み、その何段目が頁番号かを本ごとに決める（階層）。区切りの前の段は部・編・章など
// の番号（prefix）、頁番号の後ろの段は枝番（branch）になる。
//
//   2-21     階層 0: 2 頁の枝番 21     階層 1: 「2-」の 21 頁（第 2 部の 21 頁など）
//   2-2-21-3 階層 1: 「2-」の 2 頁の枝番 21-3   階層 2: 「2-2-」の 21 頁の枝番 3
//
// 加除式の本には、差し替えで足された「枝番」の付いた頁（57-1, 57-2, …）がある。
// 部・編の番号を頁番号の前に置く本（2-1, 2-3, …）と、書き方だけでは見分けられない。
// そこで前後の頁との関係から決める（chooseDepth）。頁番号の段は、ファイルの中で
// 一定の歩幅で進み、前の段は部が変わるところでしか変わらない。枝番の頁は
// まばらにしか無く、その前後は枝番の無い頁になる。
//
// 枝番の頁は一定の歩幅の並びに乗らないので、読めた枝番をそのまま使い、
// 並びの推定からは外す（枝番の頁の前後で番号が飛んでもよいものとする）。
// 枝番は頁の branch（数字の列）に、前の段は prefix（数字の列）に持ち、無い頁には付けない。

/** 頁の上下の、頁番号を探す帯の高さ（頁の高さに対する割合）。 */
export const MARGIN_ZONE = 0.14;

/** 頁番号として受け付ける値の上限（年号などを拾わないため）。 */
const MAX_PAGE_NUMBER = 1999;

/** 歩幅の候補。片面ずつ（奇数・偶数の束）なら ±2、両面なら ±1。 */
export const STEPS = [2, -2, 1, -1];

/** ハイフンで区切った頁番号の段の数の上限（2-2-21-3 まで）。 */
export const MAX_LEVELS = 4;

// 区切り（ハイフンの類）。OCR がよく取り違えるものまで含めておく。
const DASH = '[\\-–—−‐‑‒－ー]';
// 頁番号のまわりの飾り（空白・記号）。柱と頁番号の間の区切りにも使う。
const DECOR = '[\\s　\\-–—−‐‑‒－ー~〜・.,()（）[\\]［］〔〕<>《》|｜]';
// ハイフンで区切った頁番号（57・57-1・2-21・2-2-21-3）。区切ったものは、どの段も 0 で始まらない
// （2024-05-01 のような日付や、03-1234 のような電話番号を拾わない）。
const LABEL = `(?:\\d{1,4}|[1-9]\\d{0,3}(?:\\s*${DASH}\\s*[1-9]\\d{0,3}){1,${MAX_LEVELS - 1}})`;
/**
 * 「番号だけが置かれている行」の形。前後の飾り（- 12 -、(12)、p.12、12頁）を許す。
 * ハイフンで区切った頁番号（57-1・2-21）は、まとめて 1 つ目の組に取る。
 */
const STANDALONE = new RegExp(
  `^${DECOR}*(?:p\\.?|P\\.?|page|ページ|頁)?\\s*(${LABEL})\\s*(?:頁|ページ)?${DECOR}*$`
);
const DASHES = new RegExp(DASH);

/** ハイフンで区切った頁番号を、数字の列にする（「2 - 21」→ [2, 21]）。 */
function splitLabel(text) {
  return text.split(DASHES).map((part) => Number(part.trim()));
}

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
    let last = null;
    for (const part of parts) {
      // 同じ文字を少しずらして重ね書きしたもの（太字に見せる刷り方。文字情報には 3 度入る）は
      // 1 度だけ読む（「3-14」が「3-143-143-14」にならないように）。
      if (last && String(part.text) === String(last.text) && part.x0 < (last.x0 + last.x1) / 2) continue;
      last = part;
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
 * 1 行の中の番号（頁番号か行番号らしいもの）。番号だけの行、行の先頭・末尾に
 * 付いた番号。left / right は番号の左端・右端（行の中の位置が分かる側だけ）。
 */
function numbersInLine(line) {
  const standalone = line.text.match(STANDALONE);
  if (standalone) {
    return [{ path: splitLabel(standalone[1]), score: 3, y: line.y, left: line.x0, right: line.x1 }];
  }
  const leading = line.text.match(LEADING);
  const trailing = line.text.match(TRAILING);
  return [
    ...(leading ? [{ path: [Number(leading[1])], score: 1.5, y: line.y, left: line.x0, right: null }] : []),
    ...(trailing ? [{ path: [Number(trailing[1])], score: 1.5, y: line.y, left: null, right: line.x1 }] : []),
  ];
}

/** 行番号の列とみなす、番号の端の位置のずれ（頁の幅に対する割合）。 */
const LINE_COLUMN = 0.02;

/**
 * 行番号らしいか。
 *
 * 法令の解説書などは、本文の脇に 5 行おきの行番号（5, 10, 15, …）を刷る。
 * 行番号は頁の下の帯にも来るので、番号だけの行として頁番号と取り違えやすい。
 * 行番号は同じ列（番号の端が揃う）に、上から 5 ずつ増えて並ぶ。そこで、
 * 5 の倍数で、同じ列のすぐ上に 5 小さい番号か、すぐ下に 5 大きい番号が
 * あるものを行番号とみなす（頁番号は、上の行番号から 5 増えたものには
 * まずならない）。
 */
function isLineNumber(number, numbers) {
  // ハイフンで区切った番号（57-1）は行番号ではない。
  if (number.path.length > 1 || number.path[0] % 5 !== 0) return false;
  const sameColumn = (other) =>
    (number.left !== null && other.left !== null && Math.abs(number.left - other.left) <= LINE_COLUMN) ||
    (number.right !== null && other.right !== null && Math.abs(number.right - other.right) <= LINE_COLUMN);
  return numbers.some(
    (other) =>
      sameColumn(other) &&
      ((other.path[0] === number.path[0] - 5 && other.y < number.y) ||
        (other.path[0] === number.path[0] + 5 && other.y > number.y))
  );
}

/**
 * 1 頁ぶんの文字から、頁番号の候補を挙げる。
 *
 * 見るのは上下の余白の帯だけ。本文の中の数字（「第 3 章」「図 12」）は
 * 拾わない。番号だけが置かれた行は強い候補、柱の先頭・末尾に付いた番号は
 * 弱い候補とする（柱には章番号や年号が混ざることがあるので）。本文の脇の
 * 行番号（isLineNumber）は、帯の中にあっても候補にしない。
 *
 * @param {{text:string,x0:number,x1:number,y:number,h:number}[]} items
 * @param {string} [source] 'text'（文字情報）か 'ocr'（画像から読み取り）
 * @returns {{path:number[], score:number, source:string, zone:'top'|'bottom'}[]}
 *   path はハイフンで区切った番号の列（57 は [57]、57-1・2-21 は [57, 1]・[2, 21]）。
 *   どの段が頁番号かは、本の頁を並べてから決める（interpret・chooseDepth）。
 */
export function pageNumberCandidates(items, source = 'text') {
  return candidatesOf(groupLines(items), source);
}

/**
 * 1 頁ぶんの文字の、頁番号の候補（pageNumberCandidates と同じ）と柱の文字（headsOf）。
 * 行にまとめる手間を 1 度で済ませる。
 *
 * @param {{text:string,x0:number,x1:number,y:number,h:number}[]} items
 * @param {string} [source]
 */
export function readMargin(items, source = 'text') {
  const lines = groupLines(items);
  return { candidates: candidatesOf(lines, source), heads: headsOf(lines) };
}

function candidatesOf(groupedLines, source) {
  const lines = groupedLines.map((line) => ({ line, numbers: numbersInLine(line) }));
  // 行番号の列は頁全体から見る（帯の中だけでは、続きの行番号が見えない）。
  const fives = lines
    .flatMap(({ numbers }) => numbers)
    .filter((number) => number.path.length === 1 && number.path[0] % 5 === 0);
  const found = new Map();
  for (const { line, numbers } of lines) {
    const zone = line.y < MARGIN_ZONE ? 'top' : line.y > 1 - MARGIN_ZONE ? 'bottom' : null;
    if (!zone || line.text.length > 80) continue;

    for (const number of numbers) {
      const { path } = number;
      if (path.some((value) => value < 1 || value > MAX_PAGE_NUMBER) || isLineNumber(number, fives)) continue;
      const score = number.score + placementScore(line);
      // 同じ番号でも、ハイフンの後ろが違えば別の候補。
      const key = path.join('-');
      const previous = found.get(key);
      if (!previous || previous.score < score) found.set(key, { path, score, source, zone });
    }
  }
  return [...found.values()].sort(byScore);
}

/**
 * 同じ頁の候補を 2 通りの読み（文字情報と OCR）から合わせる。同じ番号（ハイフンの
 * 後ろも同じ）は 1 つにし、点数の高いほうを残す。同点なら後の読み（OCR）を残し、
 * 画像からも読めた番号として数える（記録の「番号が読めた頁」）。
 *
 * @param {{path:number[], score:number}[]} first
 * @param {{path:number[], score:number}[]} second
 */
export function mergeCandidates(first, second) {
  const found = new Map();
  for (const candidate of [...first, ...second]) {
    const key = candidate.path.join('-');
    const previous = found.get(key);
    if (!previous || previous.score <= candidate.score) found.set(key, candidate);
  }
  return [...found.values()].sort(byScore);
}

/** 候補の順（点数の高いもの、同じなら番号の小さいもの）。 */
function byScore(a, b) {
  return b.score - a.score || comparePaths(a.path, b.path);
}

/** 数字の列を、頭から順に比べる（短いほうが先: 57 < 57-1 < 57-1-1 < 57-2 < 58）。 */
export function comparePaths(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined || b[i] === undefined) return a.length - b.length;
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * 文字情報の候補だけでは番号の決まらない頁（画像の余白を OCR して確かめる頁）。
 *
 * 候補が 1 つも無い頁のほか、候補はあっても並びに合わない頁（柱や表の中の
 * 数字だけが拾えた頁、読み違えた頁）も含める。スキャナーの付ける文字情報は、
 * 余白の頁番号を読み落としたり（枝番の頁）、読み違えたり（154 を 151、184-1 を
 * 「184ソ」）する。その頁を前後から補うと、枝番の頁を挟んで番号の並びが
 * 変わるところ（57-1 のあとの奇数頁の束に、58 が来る）で、正しく読めた頁まで
 * 食い違いにしてしまう。並びに合って読めた頁は OCR しない（柱に番号のある
 * 本で、全部の頁を読み直さないため）。
 *
 * ハイフンで区切った番号の階層は、本の残りの束を読む前なので、そのファイルだけから選ぶ。
 *
 * @param {{path:number[],score:number}[][]} candidates 頁ごとの候補（文字情報から）
 * @returns {Set<number>} 頁の位置
 */
export function unsettledPages(candidates) {
  const { depth } = chooseDepth([{ candidates }]);
  const { pages } = inferFileNumbers(candidates, { depth });
  return new Set(pages.flatMap((page, index) => (page.status === 'detected' ? [] : [index])));
}

// 「頁 / 総頁数」の形の頁番号（Page 16 of 200・p. 16 of 200・16 / 200 頁・p16/200）。
// 「12/25」のような日付と取り違えないよう、頁を表す語か of のあるものだけ。
const PAGE_OF = new RegExp(
  `^${DECOR}*(?:(?:pages?|p\\.?|ページ|頁)\\s*\\d{1,4}\\s*(?:of|[/／])|\\d{1,4}\\s*of)\\s*\\d{1,4}\\s*(?:pages?|ページ|頁)?${DECOR}*$|^${DECOR}*\\d{1,4}\\s*[/／]\\s*\\d{1,4}\\s*(?:pages?|ページ|頁)${DECOR}*$`,
  'i'
);
// 「Page16」「p16」のように、頁を表す語と番号だけのもの。
const PAGE_WORD = new RegExp(`^${DECOR}*(?:pages?|p\\.?)\\s*\\d{1,4}${DECOR}*$`, 'i');

/**
 * 頁番号だけの行か（番号だけの行・「Page 16 of 200」「16 / 200 頁」の形）。日付（2024/05/01・12/25）や
 * 「1.2」のような節の番号だけの柱は残す。
 */
function pageWordsOnly(text) {
  return STANDALONE.test(text) || PAGE_OF.test(text) || PAGE_WORD.test(text);
}

/**
 * 余白の行から、上下の余白の帯にある文字（柱。書名・部や章の名前）を拾う
 * （readMargin）。番号だけの行（頁番号）は除く。柱に付いた頁番号は、その頁の番号が
 * 決まってから落とす（stripPageNumber。「Part 2」の 2 のような番号は残すため）。
 *
 * @returns {string[]} 帯の行ごとの文字（重なりなし）
 */
function headsOf(lines) {
  const heads = new Set();
  for (const line of lines) {
    if (line.y >= MARGIN_ZONE && line.y <= 1 - MARGIN_ZONE) continue;
    // 頁番号だけの行（「- 12 -」「Page 16 of 200」「16 / 200 頁」）は、どの頁でも同じに
    // なるので柱にしない。
    if (pageWordsOnly(line.text)) continue;
    if (line.text.length >= 2 && line.text.length <= 80) heads.add(line.text);
  }
  return [...heads];
}


/**
 * 柱から、その頁の頁番号（先頭か末尾にあるもの。空白のほか「｜」「・」などで区切られて
 * いても）を落とし、空白も詰める。頁をまたいで柱を比べるため（parts.js）。
 *
 * @param {string} head readMargin の柱
 * @param {{number:number|null, branch?:number[], prefix?:number[]}|null} page その頁の番号
 *   （決まらなければ null。そのときは空白だけ詰める）。枝番・前の段のある頁なら、
 *   「2-57-1」をまとめて落とす。前の段を刷っていない頁（前後から補った）なら「57-1」を落とす
 */
export function stripPageNumber(head, page) {
  let text = head;
  // 整数の番号だけ（小数の「.」を正規表現に入れない）。
  if (page && Number.isInteger(page.number)) {
    const full = labelPath(page);
    for (const path of page.prefix ? [full, full.slice(page.prefix.length)] : [full]) {
      const [start, end] = numberPatterns(path);
      const stripped = text.replace(start, '').replace(end, '');
      if (stripped !== text) {
        text = stripped;
        break;
      }
    }
  }
  return text.replace(/\s+/g, '');
}

// 番号ごとの正規表現（頁ごと・描き直しのたびに作り直さない）。path は整数の列。
const patterns = new Map();
function numberPatterns(path) {
  const key = pathText(path);
  if (!patterns.has(key)) {
    const text = path.join(`\\s*${DASH}\\s*`);
    patterns.set(key, [new RegExp(`^${DECOR}*${text}${DECOR}+`), new RegExp(`${DECOR}+${text}${DECOR}*$`)]);
  }
  return patterns.get(key);
}

/**
 * ハイフンで区切った番号の列を、階層（前の段の数）に合わせて読む。
 *
 *   interpret([2, 21], 0)       → 2 頁の枝番 21（{prefix:null, value:2, branch:[21]}）
 *   interpret([2, 21], 1)       → 「2-」の 21 頁（{prefix:[2], value:21, branch:null}）
 *   interpret([2, 2, 21, 3], 2) → 「2-2-」の 21 頁の枝番 3
 *
 * 段の足りない番号（階層 1 の本で 21 だけ）は、前の段の分からない頁番号（prefix が
 * null）とし、並びの推定で前後の頁から前の段を補う。
 *
 * @param {number[]} path
 * @param {number} depth 階層（頁番号の前にある段の数）
 * @returns {{prefix:number[]|null, value:number, branch:number[]|null}}
 */
export function interpret(path, depth = 0) {
  if (path.length <= depth) return { prefix: null, value: path.at(-1), branch: null };
  return {
    prefix: depth > 0 ? path.slice(0, depth) : null,
    value: path[depth],
    branch: path.length > depth + 1 ? path.slice(depth + 1) : null,
  };
}

/** 読んだ番号（interpret の形）を、頁の番号の形（number・branch・prefix）にする。無い段は付けない。 */
function labelOf({ prefix, value, branch }) {
  return { number: value, ...(branch ? { branch } : {}), ...(prefix ? { prefix } : {}) };
}

/** 頁の番号を、ハイフンで区切った番号の列に戻す（2-57-1 → [2, 57, 1]）。 */
export function labelPath({ prefix, number, branch }) {
  return [...(prefix ?? []), number, ...(branch ?? [])];
}

/** 前の段を見分ける文字列（前の段の無い・分からない頁は ''）。 */
export function prefixKey(prefix) {
  return prefix ? pathText(prefix) : '';
}

/** 同じ数字の列か（どちらも無い・null も同じとみなす）。 */
function samePath(a, b) {
  return (a ?? null) === null ? (b ?? null) === null : (b ?? null) !== null && pathText(a) === pathText(b);
}

/** 読んだ番号の前の段が、並びの前の段に合うか（前の段の分からない番号はどこにでも合う）。 */
function fits(read, prefix) {
  return (read ?? null) === null || ((prefix ?? null) !== null && samePath(read, prefix));
}

/** 枝番の候補（あれば）。枝番は番号だけの行からしか取らないので、どれも強い候補。 */
function branchCandidate(list) {
  return list.find((c) => c.branch) || null;
}

/** 強い候補（番号だけの行）とみなす点数。外れたときに「食い違い」として出す。 */
export const STRONG_SCORE = 3;

// 番号の並び（ずれ）を切り替える費用。読み違えた 1 頁（点数 3〜4）のために
// 2 回切り替える（往復 2 × 5）よりは、その 1 頁を外れ値とみなすほうが安い。
// 2 頁以上続けてずれていれば（6〜8 点）、切り替えたほうが得になる。
const SWITCH_COST = 5;

/**
 * そのファイルの中で番号が進む歩幅を、近くの頁どうしの候補の差から多数決で選ぶ。
 * 前の段（部・編など）の違う番号どうしの差は数えない。
 *
 * @param {{value:number,score:number,prefix?:number[]|null}[][]} candidates 頁ごとの候補
 * @param {Set<number>} [breaks] 並びが切れる位置（枝番の頁を挟んだ直後の頁）。
 *   ここをまたぐ頁どうしの差は数えない
 * @returns {{step:number|null, votes:number}}
 */
export function detectStep(candidates, breaks = new Set()) {
  const votes = new Map(STEPS.map((step) => [step, 0]));
  const anchored = candidates
    .map((list, index) => ({ list, index }))
    .filter((page) => page.list.length > 0);
  const crosses = (from, to) => [...breaks].some((at) => at > from && at <= to);

  for (let a = 0; a < anchored.length; a++) {
    for (let b = a + 1; b < anchored.length && anchored[b].index - anchored[a].index <= 3; b++) {
      if (crosses(anchored[a].index, anchored[b].index)) continue;
      const distance = anchored[b].index - anchored[a].index;
      for (const first of anchored[a].list) {
        for (const second of anchored[b].list) {
          if (!fits(first.prefix, second.prefix) && !fits(second.prefix, first.prefix)) continue;
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
 * 番号 = ずれ + 歩幅 × 頁の位置、として、頁ごとに「ずれ」（と前の段）を選ぶ。ずれは
 * 基本的に一定で、変わる（番号の数えられない差し込みの図版がある、部が変わる、など）
 * には費用が掛かる、という条件で、候補の点数の合計がいちばん大きくなる
 * 選び方を求める（ビタビ法）。こうすると、
 *
 *   - 番号の刷られていない頁は、前後と同じずれで番号が決まる（推定）
 *   - 読み違えた 1 頁は、前後と合わないので無視される（食い違い）
 *   - 本当に番号が飛んでいるところでは、ずれが切り替わる
 *   - 前の段（部・編など）を刷っていない頁は、前後の頁の前の段になる
 *
 * ずれが切り替わる境目にある、番号の読めなかった頁は、どちらに属すか
 * 決められないので「要確認」にする。
 *
 * 枝番の読めた頁（57-1）は、読めたとおりの番号にして、この並びからは外す。
 * 枝番の頁を挟んだところでは、ずれを費用なしで切り替えてよい。
 *
 * 頁ごとに手で入れた番号（fixed）は確かなものとして、並びが必ずそこを通るように
 * する（読み取った候補より優先する）。読み取りがうまくいかなかったファイルでも、
 * 何頁かに番号を入れれば、残りの頁は歩幅に沿ってそこから決まる。手で入れた
 * 枝番の頁（57-1）と間に挟む頁（12.5）は、読めた枝番の頁と同じく並びから外す
 * （枝番の頁を挟んだところでは番号が飛んでもよい。間に挟む頁は飛ばさない）。
 *
 * @param {{path:number[],score:number,source:string}[][]} candidates 頁ごとの候補
 * @param {{step?:number, depth?:number, fixed?:({path:number[]}|null|undefined)[]}} [options]
 *   step: 歩幅が分かっているとき（他のファイルから）。
 *   depth: ハイフンで区切った番号の階層（interpret。既定は 0 で、57-1 を枝番と読む）。
 *   fixed: 頁ごとに手で入れた番号（parsePageNumber の形。入れていない頁は null）
 * @returns {{
 *   step: number|null,
 *   pages: {number:number|null, branch?:number[], prefix?:number[], status:string, read:object|null}[],
 * }}
 *   status は detected（読めた番号どおり）/ inferred（前後から推定）/
 *   conflict（読めた番号が前後と食い違う）/ uncertain（ずれの境目で決められない）/
 *   unknown（ファイルの中に手掛かりが無い）/ manual（手で入れた番号）。
 *   read は読めた候補（interpret した value・branch・prefix と、読んだとおりの path）
 */
export function inferFileNumbers(candidates, options = {}) {
  const depth = options.depth ?? 0;
  const lists = candidates.map((list) => list.map((c) => ({ ...c, ...interpret(c.path, depth) })));
  const fixed = candidates.map((_, index) => {
    const manual = options.fixed?.[index];
    return manual ? interpret(manual.path, depth) : null;
  });
  // 枝番の頁は読めた番号のまま置き、残りの頁だけで並びを推定する。枝番の頁を
  // 挟んだところでは、番号が飛んでもよい（差し替えで元の頁が抜けているので）。
  const pages = lists.map((list, index) => {
    const manual = fixed[index];
    if (manual) {
      if (!manual.branch && Number.isInteger(manual.value)) return null;
      return { ...labelOf(manual), status: 'manual', read: matchingRead(list, manual) };
    }
    const read = branchCandidate(list);
    return read ? { ...labelOf(read), status: 'detected', read } : null;
  });
  const mainIndex = [];
  const breaks = new Set();
  pages.forEach((page, index) => {
    if (page?.branch) breaks.add(mainIndex.length);
    else if (!page) mainIndex.push(index);
  });
  const main = inferSequence(
    mainIndex.map((index) =>
      fixed[index] ? [{ ...fixed[index], score: MANUAL_SCORE, source: 'manual' }] : lists[index]
    ),
    options.step,
    breaks,
    mainIndex.map((index) => fixed[index] !== null)
  );
  const outside = pages.map((page) => page !== null);
  mainIndex.forEach((index, k) => {
    const manual = fixed[index];
    pages[index] = manual ? { ...main.pages[k], status: 'manual', read: matchingRead(lists[index], manual) } : main.pages[k];
  });
  // 並びから外した頁（枝番・間に挟む頁）で前の段の分からないものは、前後の頁の前の段にする。
  if (depth > 0) {
    pages.forEach((page, index) => {
      if (!outside[index] || page.prefix) return;
      const near = [...pages.slice(0, index)].reverse().find((other) => other.prefix) ?? pages.slice(index + 1).find((other) => other.prefix);
      if (near) page.prefix = near.prefix;
    });
  }
  return { step: main.step, pages };
}

/** 手で入れた番号と同じに読めていた候補（読み取りの内訳で「読めた頁」に数える）。無ければ null。 */
function matchingRead(list, { prefix, value, branch }) {
  return list.find((c) => c.value === value && samePath(c.branch, branch) && fits(prefix, c.prefix)) ?? null;
}

/**
 * 手で入れた番号の点数。歩幅を多数決で選ぶとき、読み取った候補より重く数える
 * （手で入れた 2 頁から歩幅が決まるように）。並びは点数によらずその番号を通す。
 */
const MANUAL_SCORE = 10;

/** 枝番の頁を除いた並びの、頁ごとの番号（inferFileNumbers の本体）。 */
function inferSequence(candidates, knownStep, breaks, fixed) {
  const count = candidates.length;
  const step = knownStep ?? detectStep(candidates, breaks).step;
  const unknown = () => ({
    step: step ?? null,
    pages: candidates.map(() => ({ number: null, status: 'unknown', read: null })),
  });
  if (step === null || step === undefined) return unknownOrSingle(candidates, unknown);

  // 状態 = 前の段とずれ。候補が示すものだけを状態にする。
  const found = new Map();
  candidates.forEach((list, index) => {
    for (const c of list) {
      const offset = c.value - step * index;
      const key = `${prefixKey(c.prefix)}|${offset}`;
      if (!found.has(key)) found.set(key, { prefix: c.prefix ?? null, offset });
    }
  });
  const states = [...found.values()];
  if (states.length === 0) return unknown();

  // 手で入れた頁は、その番号に合わないずれを取れない。
  const hitOf = (index, state) =>
    candidates[index].find((c) => c.value - step * index === state.offset && fits(c.prefix, state.prefix));
  const emission = (index, state) => {
    const hit = hitOf(index, state);
    if (hit) return hit.score;
    return fixed[index] ? -Infinity : 0;
  };

  // score[k] = 頁 i までを見て、頁 i の状態が states[k] のときの最大点。
  let score = states.map((state) => emission(0, state));
  const back = [states.map((_, k) => k)];
  for (let i = 1; i < count; i++) {
    let bestPrev = 0;
    for (let k = 1; k < states.length; k++) if (score[k] > score[bestPrev]) bestPrev = k;
    const next = [];
    const from = [];
    for (let k = 0; k < states.length; k++) {
      const stay = score[k];
      const jump = score[bestPrev] - (breaks.has(i) ? 0 : SWITCH_COST);
      if (stay >= jump) {
        next.push(stay + emission(i, states[k]));
        from.push(k);
      } else {
        next.push(jump + emission(i, states[k]));
        from.push(bestPrev);
      }
    }
    score = next;
    back.push(from);
  }

  let last = 0;
  for (let k = 1; k < states.length; k++) if (score[k] > score[last]) last = k;
  const chosen = new Array(count);
  chosen[count - 1] = last;
  for (let i = count - 1; i > 0; i--) chosen[i - 1] = back[i][chosen[i]];

  const pages = candidates.map((list, index) => {
    const state = states[chosen[index]];
    const number = state.offset + step * index;
    const prefix = state.prefix ? { prefix: state.prefix } : {};
    const hit = hitOf(index, state) || null;
    if (hit) return { number, ...prefix, status: 'detected', read: hit };
    const strong = list.find((c) => c.score >= STRONG_SCORE) || null;
    return { number, ...prefix, status: strong ? 'conflict' : 'inferred', read: strong };
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
    if (strong) result.pages[index] = { ...labelOf(strong), status: 'detected', read: strong };
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

/** 階層を選ぶときの、枝番の頁の重み（頁番号の段で並びに合った頁の半分に数える）。 */
const BRANCH_WEIGHT = 0.5;
/**
 * 階層を選ぶときの、段の足りない番号の重み。2-21 の形の本（階層 1）で 21 だけの頁が
 * 並びに合っても、その階層の書き方とは食い違うものとして引く。枝番の頁の重み（0.5）と
 * 合わせると、ハイフンで区切った頁が段の足りない頁の 3 倍より多いときに深いほうを選ぶ
 * （前付けだけ番号に部の番号の無い本は深く、枝番の頁が 10 頁続く加除式の本は浅く読める）。
 */
const SHORT_WEIGHT = -0.5;

/**
 * ハイフンで区切った頁番号の、何段目を頁番号と見るか（階層。頁番号の前にある段の数）を
 * 本ごとに選ぶ。
 *
 * 「2-21」は、2 頁の枝番 21 とも、第 2 部（編・章）の 21 頁とも読める。書き方だけでは
 * 決められないので、階層ごとにファイルの頁の番号を推定し（inferFileNumbers）、前後の頁と
 * どれだけ合うかを点にして比べる。
 *
 *   - 頁番号の段は、ファイルの中で一定の歩幅で進む（2-19, 2-21, 2-23 の束を枝番と
 *     読むと、2 頁に枝番が並ぶだけで歩幅に乗らない）。並びに合った頁は読みの点のまま数える
 *     （歩幅の決まらないファイルの頁は、並びに合ったとは言えないので枝番の頁と同じに数える）
 *   - 枝番の頁はまばらなので、半分に数える（どの頁も枝番と読む読み方を選ばない）
 *   - 段の足りない番号（55, 57-1, 57-3, 59 の 55・59）は、その階層とは食い違うので引く
 *     （加除式の本で、枝番の頁の続く束を部の頁と取り違えない）
 *
 * 点が同じなら、浅いほう（枝番と読むほう）を選ぶ。ハイフンで区切った番号が無ければ 0（点は数えない）。
 *
 * @param {{candidates:{path:number[], score:number}[][], fixed?:({path:number[]}|null|undefined)[]}[]} files
 *   本文のファイルごとの、頁の候補と手で入れた番号
 * @returns {{depth:number, scores:number[]}} scores は階層ごとの点
 */
export function chooseDepth(files) {
  let longest = 1;
  for (const { candidates, fixed = [] } of files) {
    for (const list of candidates) for (const c of list) longest = Math.max(longest, c.path.length);
    for (const manual of fixed) if (manual) longest = Math.max(longest, manual.path.length);
  }
  // ハイフンで区切った番号が無ければ、読み方は 1 つしか無い（並びを推定し直さない）。
  if (longest === 1) return { depth: 0, scores: [] };
  const scores = [];
  for (let depth = 0; depth < longest; depth++) {
    scores.push(files.reduce((sum, file) => sum + depthScore(file, depth), 0));
  }
  let depth = 0;
  scores.forEach((score, d) => {
    if (score > scores[depth]) depth = d;
  });
  return { depth, scores };
}

/** 階層 depth で読んだときの、ファイルの頁の番号の合い方（chooseDepth）。 */
function depthScore({ candidates, fixed = [] }, depth) {
  const { step, pages } = inferFileNumbers(candidates, { fixed, depth });
  let score = 0;
  pages.forEach((page, index) => {
    const read =
      page.status === 'manual'
        ? { path: fixed[index].path, score: MANUAL_SCORE }
        : page.status === 'detected'
          ? page.read
          : null;
    if (!read) return;
    const weight = read.path.length <= depth ? SHORT_WEIGHT : page.branch || step === null ? BRANCH_WEIGHT : 1;
    score += weight * read.score;
  });
  return score;
}

/**
 * 番号を手で決めたファイル（先頭の番号と歩幅）。
 *
 * @param {number} count 頁数
 * @param {number} start 1 頁目の番号
 * @param {number} step 歩幅
 * @param {number[]|null} [prefix] 前の段（部・編などの番号。無ければ null）
 */
export function manualFileNumbers(count, start, step, prefix = null) {
  return {
    step,
    pages: Array.from({ length: count }, (_, index) => ({
      number: start + step * index,
      ...(prefix ? { prefix } : {}),
      status: 'manual',
      read: null,
    })),
  };
}

/**
 * 番号の付き方を、ファイルの頁の順に番号を並べて言い表す（ファイルの一覧の
 * 見出しに出す）。長い並びは、はじめの 3 つと終わりの 2 つだけを出して間を
 * 「...」で詰める。番号が飛んでいるところは詰めずに、飛んだ先から並べ直す
 * （「...」の中に飛びが隠れないように）。
 *
 *   前付けから始まる奇数頁の束 → -11, -9, -7...13, 15
 *   裏返した偶数頁の束         → 8, 6, 4, 2
 *   途中で飛ぶ                 → 1, 3, 5...17, 19, 31, 33, 35...47, 49
 *   枝番の頁を挟む             → 51, 53, 55, 57-1, 57-3, 59, 61
 *   部の番号の付いた頁         → 1-77, 1-79, 2-1, 2-3, 2-5
 *
 * @param {{step:number|null, pages:{number:number|null, branch?:number[], prefix?:number[]}[]}} numbering
 */
export function numberingSequence(numbering) {
  const { step, pages } = numbering;
  // 歩幅をほかの束から借りても、番号の候補が 1 つも無ければ番号は決まらない。
  if (step === null || step === undefined || pages.every((page) => page.number === null)) {
    return '?';
  }
  // 枝番の頁は、それだけで 1 つの並びにする（前後の番号とは続けない）。前の段が変われば並べ直す。
  const runs = [];
  for (const page of pages) {
    const { number, branch } = page;
    const key = prefixKey(page.prefix);
    const label = pageNumberText(page);
    const run = runs.at(-1);
    if (!branch && run && run.key === key && number === run.last + step) {
      run.labels.push(label);
      run.last = number;
    } else {
      runs.push({ key, labels: [label], last: branch ? NaN : number });
    }
  }
  return runs
    .map(({ labels }) =>
      labels.length <= 5
        ? labels.join(', ')
        : `${labels.slice(0, 3).join(', ')}...${labels.slice(-2).join(', ')}`
    )
    .join(', ');
}

/**
 * 頁番号の表示。前付け（0 以下）は「前付」と分かるようにする（前の段のある 0 頁は 2-0 のまま）。
 * 枝番は 57-1、前の段のある頁は 2-21・2-57-1 の形。
 *
 * @param {number|null} number
 * @param {number[]|null} [branch]
 * @param {number[]|null} [prefix]
 */
export function formatNumber(number, branch = null, prefix = null) {
  if (number === null || number === undefined) return '?';
  const head = prefix ? `${pathText(prefix)}-` : '';
  if (branch) return `${head}${pathText([number, ...branch])}`;
  if (!Number.isInteger(number)) return `${head}${Math.floor(number)}と${head}${Math.ceil(number)}の間`;
  // 前の段のある 0 頁（目次の 0-0、部の扉の 2-0）は、そのまま書く。
  if (number === 0 && prefix) return `${head}0`;
  return number <= 0 ? `${head}前付(${number})` : `${head}${number}`;
}

/** 手で入れるハイフンで区切った番号（57-1・2-21・2-2-21-3）。 */
const LABEL_INPUT = new RegExp(`^${LABEL}$`);

/**
 * 手で入れた頁番号を読む。読めなければ null。12、前付けの -3、間に挟む 12.5、
 * ハイフンで区切った 57-1・2-21 の形。ハイフンのどの段が頁番号かは、本の階層で
 * 決める（interpret）。
 *
 * @param {string} text
 * @returns {{path:number[]}|null}
 */
export function parsePageNumber(text) {
  const value = normalizeDigits(text).trim();
  if (!value) return null;
  if (LABEL_INPUT.test(value)) return { path: splitLabel(value) };
  const number = Number(value);
  return Number.isFinite(number) ? { path: [number] } : null;
}

/** 数字の列を、ハイフンで区切って書く（parsePageNumber で読める形。入力欄に出す）。 */
export function pathText(path) {
  return path.join('-');
}

/** 頁の番号を、ハイフンで区切って書く（2-57-1。前付けや小数も数字のまま）。 */
export function pageNumberText(page) {
  return pathText(labelPath(page));
}

/**
 * 頁が奇数側か偶数側か（スキャンの位置のずれを、同じ側の頁どうしで比べるため）。
 *
 * 枝番の頁は、差し替えの紙の表（57-1, 57-3, …）が奇数側、裏（57-2, 57-4, …）が
 * 偶数側になる（入れ子の枝番 57-1-2 は、いちばん後ろの段で見る）。
 *
 * @param {number|null} number
 * @param {number[]|null} [branch] 枝番
 * @returns {'odd'|'even'|null}
 */
export function sideOf(number, branch = null) {
  if (number === null || !Number.isInteger(number)) return null;
  return Math.abs(branch ? branch.at(-1) : number) % 2 === 1 ? 'odd' : 'even';
}
