// 頁の文字情報（サーチャブル PDF の OCR の結果）が、文として読めるかを確かめる。
//
// 結合しても文字情報はそのまま写るので、OCR の結果が壊れていれば、結合した
// PDF でも検索できない。読み込んだときに、頁ごとに次を見る。
//
//   文字化け   … 置き換え文字（U+FFFD）・私用領域・制御文字・康熙部首など、
//                ふつうの文に出ない文字が多い。UTF-8 を Shift_JIS や Latin-1
//                として読んだときの決まった形（「縺」「繧」「ã€」など）
//   でたらめ   … 記号ばかり・母音の無い英語の語ばかり（図や汚れを文字と読んだ）。
//                ひらがなの無い漢字の羅列（フォントの文字の対応が違う）
//   逆順       … 日本語のよくある 2 文字（「ます」「して」…）や英語のよくある語
//                （the・and…）が、逆向き（「すま」「eht」）にばかり現れる
//   並びの乱れ … 日本語のよくある 2 文字が、どちら向きにもほとんど現れない
//                （縦書きを横に読んだ・文字の順が崩れた）
//
// しきい値は、README（日本語の技術文書）を 400 字ずつに切ったもの、英語の
// 利用許諾の文を 1,500 字ずつに切ったものと、それを逆順・ばらばら・縦書きを
// 横に読んだ形・でたらめな英字にしたもので決めた（下の各値の注を参照）。
// 文字が少ない頁は、決めるだけの手掛かりが無いので見ない。
//
// pdf.js にも DOM にも触らない（テストで縛るため）。

/**
 * 日本語の文によく現れ、逆向きの並びはまず現れない 2 文字。
 *
 * README では、ふつうの向きでひらがなの数の 4% 以上（多くは 8% 以上）、
 * 逆向き・ばらばら・縦書きを横に読んだ形では 4% 未満だった。
 */
const JA_PAIRS = new Set(
  'ます です して する から した せん では って った いる れる ので その この ため とき まで られ ある よう こと には ても でき なる いう であ ると のは され にな とし'.split(
    ' '
  )
);
/** 日本語の並びを見るのに要る、ひらがなの数。 */
const JA_MIN_KANA = 60;
/** よくある 2 文字の数が、ひらがなの数に対してこれ未満なら、並びがおかしい。 */
const JA_MIN_PAIRS = 0.04;

/** 英語のよくある語と、その綴りを逆にしたもの（逆にしても英語にならないものだけ）。 */
const EN_WORDS = new Set('the and that for with this from which your will can'.split(' '));
const EN_REVERSED = new Set('eht dna taht rof htiw siht morf hcihw ruoy lliw nac'.split(' '));
/** 英語の並びを見るのに要る、2 文字以上の語の数。 */
const EN_MIN_WORDS = 30;
/**
 * 母音の無い語（大文字だけの略語・単位を除く）の割合がこれ以上なら、でたらめ。
 * 英語の文では多くて 14%、でたらめな英字では 29% 以上だった。
 */
const EN_MAX_ODD = 0.25;
const EN_SHORT_WORDS = new Set('mm cm km kg mg ml px pt pp vs st nd rd th dr mr mrs ms ltd'.split(' '));

/** 文字化けとみなす、ふつうの文に出ない文字の数と割合。 */
const MOJIBAKE_MIN = 3;
const MOJIBAKE_RATIO = 0.02;
/** 文字の種類を見るのに要る、空白を除いた文字の数。 */
const MIN_CHARS = 20;
/** 記号（文に使う句読点を除く）の割合がこれ以上なら、でたらめ。 */
const MAX_SYMBOLS = 0.2;
/** 漢字の羅列とみなす、日本語の文字の数とひらがな・カタカナの割合。 */
const KANJI_ONLY_MIN = 100;
const KANJI_ONLY_KANA = 0.02;

/**
 * ふつうの文に出ない文字。置き換え文字・私用領域・制御文字・康熙部首と
 * CJK 部首補助（フォントの文字の対応が無いときに出やすい）。
 */
const UNUSUAL = /[\uFFFD\uE000-\uF8FF\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2E80-\u2FDF]/gu;
/** UTF-8 の日本語を Shift_JIS として読んだときに、よく現れる字。 */
const SJIS_MOJIBAKE = /[縺繧繝]/g;
/** UTF-8 を Latin-1（Windows-1252）として読んだときの形（「ã‚」「â€œ」「Ã©」など）。 */
const LATIN1_MOJIBAKE = /[ÃÂâã][\u0080-\u00BF\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02DC\u2013-\u2122]/g;
/** 文に使う句読点・括弧を除いた、ASCII の記号。 */
const SYMBOLS = /[|~^`\\{}<>_=*#@$%&+]/g;

const count = (text, pattern) => text.match(pattern)?.length ?? 0;

/** 指摘に添える、文字情報の頭（短く）。 */
function sampleOf(text, at = 0) {
  const start = Math.max(0, at - 4);
  const sample = text.slice(start, start + 16);
  return start + 16 < text.length ? `${sample}…` : sample;
}

/** 正規表現が最初に当たった位置（数えて当たると分かっているものだけに使う）。 */
function firstMatch(text, pattern) {
  return text.search(pattern);
}

/**
 * 日本語の並び。よくある 2 文字を、ふつうの向きと逆向きで数える。
 *
 * @returns {'reversed'|'jumbled'|null}
 */
function japaneseOrder(compact) {
  let kana = 0;
  let forward = 0;
  let backward = 0;
  for (let i = 0; i < compact.length; i++) {
    const c = compact[i];
    if (c >= '\u3041' && c <= '\u309F') kana++;
    if (i + 1 < compact.length) {
      if (JA_PAIRS.has(c + compact[i + 1])) forward++;
      if (JA_PAIRS.has(compact[i + 1] + c)) backward++;
    }
  }
  if (kana < JA_MIN_KANA) return null;
  if (backward > 2 * forward && backward >= JA_MIN_PAIRS * kana) return 'reversed';
  if (forward < JA_MIN_PAIRS * kana || forward < 2 * backward) return 'jumbled';
  return null;
}

/**
 * 英語の並び。母音の無い語の割合と、よくある語の向きを見る。
 *
 * @returns {'reversed'|'garbled'|null}
 */
function englishOrder(text) {
  // 英字が半分以上ある頁だけを渡すので、語は必ずある。
  const words = text.match(/[A-Za-z]+/g);
  let forward = 0;
  let backward = 0;
  let long = 0;
  let odd = 0;
  for (const word of words) {
    const lower = word.toLowerCase();
    if (EN_WORDS.has(lower)) forward++;
    if (EN_REVERSED.has(lower)) backward++;
    if (word.length < 2) continue;
    long++;
    const acronym = word === word.toUpperCase() && word.length <= 5;
    if (!/[aeiouy]/i.test(word) && !acronym && !EN_SHORT_WORDS.has(lower)) odd++;
  }
  if (long < EN_MIN_WORDS) return null;
  if (backward >= 3 && backward > forward) return 'reversed';
  if (odd >= EN_MAX_ODD * long) return 'garbled';
  return null;
}

/**
 * 1 頁の文字情報を確かめる。
 *
 * @param {string} text 頁の文字情報（getTextContent() の断片をつなげたもの）
 * @returns {{kind:'mojibake'|'garbled'|'reversed'|'jumbled', sample:string}|null}
 *   問題が無いか、決めるだけの文字が無ければ null。sample は指摘に添える文字情報の一部
 */
export function textQuality(text) {
  const compact = String(text ?? '').replace(/\s+/g, '');
  if (compact.length < MIN_CHARS) return null;
  const finding = (kind, at = 0) => ({ kind, sample: sampleOf(compact, at) });

  const unusual = count(compact, UNUSUAL);
  if (unusual >= MOJIBAKE_MIN && unusual >= MOJIBAKE_RATIO * compact.length) {
    return finding('mojibake', firstMatch(compact, UNUSUAL));
  }
  const kanji = count(compact, /[\u3400-\u9FFF]/g);
  const sjis = count(compact, SJIS_MOJIBAKE);
  if (sjis >= MOJIBAKE_MIN && sjis >= 0.05 * kanji) return finding('mojibake', firstMatch(compact, SJIS_MOJIBAKE));
  if (count(compact, LATIN1_MOJIBAKE) >= MOJIBAKE_MIN) return finding('mojibake', firstMatch(compact, LATIN1_MOJIBAKE));

  if (count(compact, SYMBOLS) >= MAX_SYMBOLS * compact.length) return finding('garbled', firstMatch(compact, SYMBOLS));
  const kana = count(compact, /[\u3041-\u30FF]/g);
  if (kanji + kana >= KANJI_ONLY_MIN && kana < KANJI_ONLY_KANA * (kanji + kana)) return finding('garbled');

  // 英語の並びは、英字が文字情報の半分以上を占める頁だけで見る（日本語の技術書の
  // 頁に混じる「pdf」「js」のような語を、でたらめと数えないように）。
  const latin = count(compact, /[A-Za-z]/g);
  const order = japaneseOrder(compact) ?? (latin * 2 >= compact.length ? englishOrder(String(text)) : null);
  return order ? finding(order) : null;
}

/** 指摘の文言（頁の下に出す短いもの）。 */
export const TEXT_QUALITY_MESSAGE = {
  mojibake: '文字情報が文字化けしているようです',
  garbled: '文字情報が文になっていません（図や汚れを文字と読んだ・フォントの対応違い）',
  reversed: '文字情報の並びが逆順になっているようです',
  jumbled: '文字情報の並びが乱れています（縦書きを横に読んだ・文字の順が崩れた）',
};
