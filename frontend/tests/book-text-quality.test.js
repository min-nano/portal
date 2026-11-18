// PDF 結合ツール: 文字情報（OCR の結果）の確かめ。
//
// ふつうの日本語・英語の文は指摘せず、文字化け・でたらめ・逆順・並びの乱れを
// 見つけること。文字が少ない頁は決めないこと。

import { describe, expect, it } from 'vitest';
import { TEXT_QUALITY_MESSAGE, textQuality } from '../src/pdf-book-merger/text-quality.js';

const JAPANESE =
  '吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。' +
  '吾輩はここで始めて人間というものを見た。しかもあとで聞くとそれは書生という人間中で一番獰悪な種族であったそうだ。' +
  'この書生というのは時々我々を捕えて煮て食うという話である。しかしその当時は何という考もなかったから別段恐しいとも思わなかった。' +
  'ただ彼の掌に載せられてスーと持ち上げられた時何だかフワフワした感じがあったばかりである。掌の上で少し落ちついて書生の顔を見たのがいわゆる人間というものの見始であろう。' +
  'この時妙なものだと思った感じが今でも残っている。第一毛をもって装飾されべきはずの顔がつるつるしてまるで薬缶だ。';

const ENGLISH =
  'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness, ' +
  'it was the epoch of belief, it was the epoch of incredulity, it was the season of Light, it was the season of Darkness, ' +
  'it was the spring of hope, it was the winter of despair, we had everything before us, we had nothing before us, ' +
  'we were all going direct to Heaven, we were all going direct the other way. In short, the period was so far like ' +
  'the present period, that some of its noisiest authorities insisted on its being received, for good or for evil, ' +
  'in the superlative degree of comparison only, and this is the story which follows from that.';

const reverse = (text) => [...text].reverse().join('');

describe('textQuality', () => {
  it('ふつうの日本語・英語の文は指摘しない', () => {
    expect(textQuality(JAPANESE)).toBeNull();
    expect(textQuality(ENGLISH)).toBeNull();
    // 日本語の技術書の頁に混じる英語の語（母音の無い「pdf」「js」など）は数えない。
    const technical =
      'pdf.js は PDF を描く。canvas の大きさは CSS px で決め、JPEG は js で展開しない。' +
      'npm で pdf-lib を入れ、std の関数と Rust の wasm を使う。'.repeat(3);
    expect(textQuality(technical)).toBeNull();
    // 大文字だけの略語・単位は、母音が無くても英語の語とみなす。
    expect(textQuality(`${ENGLISH} HTML CSS PDF mm cm kg px pp vs st nd`)).toBeNull();
  });

  it('文字が少ない頁は決めない（空・見出しだけの頁）', () => {
    expect(textQuality('')).toBeNull();
    expect(textQuality(null)).toBeNull();
    expect(textQuality(undefined)).toBeNull();
    expect(textQuality('第 1 章 はじめに')).toBeNull();
    // 置き換え文字があっても、文字が少なければ決めない。
    expect(textQuality('\uFFFD\uFFFD\uFFFD')).toBeNull();
    // ひらがなが少ない日本語、語が少ない英語は、並びを見ない。
    expect(textQuality(reverse('吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。'))).toBeNull();
    expect(textQuality(reverse('it was the best of times, it was the worst of times'))).toBeNull();
  });

  it('ふつうの文に出ない文字が多ければ、文字化けとする', () => {
    const replaced = JAPANESE.slice(0, 40).replace(/[のはが]/g, '\uFFFD');
    expect(textQuality(replaced)).toEqual({ kind: 'mojibake', sample: expect.any(String) });
    // 私用領域・制御文字・康熙部首（フォントの文字の対応が無いときに出る）。
    expect(textQuality(`${'\uE001\uE002\u0001'.repeat(3)}${JAPANESE.slice(0, 30)}`)?.kind).toBe('mojibake');
    expect(textQuality(`${JAPANESE.slice(0, 30)}⼈⼝⼤⽇`)?.kind).toBe('mojibake');
    // 1 つだけなら（特殊な記号の写し損ねなど）、文字化けとはしない。
    expect(textQuality(`${JAPANESE}\uFFFD`)).toBeNull();
    // 「縺」は「縺れる（もつれる）」の字でもある。漢字の多い文に数回あるだけなら、文字化けとしない。
    expect(textQuality(`${JAPANESE}糸が縺れる。縺れた糸。縺れ合う。`)).toBeNull();
  });

  it('UTF-8 を Shift_JIS・Latin-1 として読んだ形は、文字化けとする', () => {
    const utf8 = new TextEncoder().encode(JAPANESE.slice(0, 80));
    const sjis = new TextDecoder('shift_jis').decode(utf8);
    expect(textQuality(sjis)?.kind).toBe('mojibake');
    // 置き換え文字の無い形（「こんにちは、世界」を Shift_JIS として読んだもの）。
    expect(textQuality('縺薙ｓ縺ｫ縺｡縺ｯ縲∽ｸ也阜'.repeat(3))).toEqual({ kind: 'mojibake', sample: '縺薙ｓ縺ｫ縺｡縺ｯ縲∽ｸ也阜縺薙…' });
    const latin1 = new TextDecoder('windows-1252').decode(utf8);
    expect(textQuality(latin1)?.kind).toBe('mojibake');
    // 英語の文の引用符だけが化けたものも。
    const quotes = new TextDecoder('windows-1252').decode(
      new TextEncoder().encode(`“${ENGLISH.slice(0, 60)}” and “${ENGLISH.slice(60, 120)}”`)
    );
    expect(textQuality(quotes)?.kind).toBe('mojibake');
  });

  it('指摘には、おかしな文字のあたりを短く添える', () => {
    const text = `${JAPANESE.slice(0, 30)}\uFFFD\uFFFD\uFFFD${JAPANESE.slice(30, 60)}`;
    const { sample } = textQuality(text);
    expect(sample).toBe(`${JAPANESE.slice(26, 30)}\uFFFD\uFFFD\uFFFD${JAPANESE.slice(30, 39)}…`);
    // 文字情報が短ければ、そのまま。
    expect(textQuality(`${'\uFFFD'.repeat(3)}${JAPANESE.slice(0, 17)}`).sample).toBe(
      `${'\uFFFD'.repeat(3)}${JAPANESE.slice(0, 13)}…`
    );
    expect(textQuality(`${JAPANESE.slice(0, 10)}${'\uFFFD'.repeat(10)}`).sample).toBe(
      `${JAPANESE.slice(6, 10)}${'\uFFFD'.repeat(10)}`
    );
  });

  it('記号ばかり・ひらがなの無い漢字の羅列・母音の無い英語の語ばかりは、でたらめとする', () => {
    expect(textQuality('|||~~ ;; __ == ** ## lIl | | ~ ^ ``` \\\\ {} <> ||| %%% &&& +++')?.kind).toBe('garbled');
    // フォントの文字の対応が違うと、ありそうもない漢字が並ぶ。
    const kanji = '亜唖娃阿哀愛挨姶逢葵茜穐悪握渥旭葦芦鯵梓圧斡扱宛姐虻飴絢綾鮎或粟袷安庵按暗案闇鞍杏以伊位依偉囲夷委威尉惟意慰易椅為畏異移維緯胃萎衣謂違遺医井亥域育郁磯一壱溢逸稲茨芋鰯允印咽員因姻引飲淫胤蔭院陰隠韻吋右宇烏羽迂雨卯鵜窺丑碓臼渦嘘唄欝蔚鰻姥厩浦瓜閏噂云運雲';
    expect(textQuality(kanji)).toEqual({ kind: 'garbled', sample: `${kanji.slice(0, 16)}…` });
    // 図や汚れを英字と読んだもの（母音の無い語ばかり）。
    const noise = 'lll rnrn Iltt ll1l wrt xkcd mnbv qwrt zxcv lkjh pqrst bcdfg hjkl mnpq rstv wxyz '.repeat(3);
    expect(textQuality(noise)?.kind).toBe('garbled');
  });

  it('よくある 2 文字・語が逆向きにばかり現れれば、逆順とする', () => {
    expect(textQuality(reverse(JAPANESE))?.kind).toBe('reversed');
    expect(textQuality(reverse(ENGLISH))?.kind).toBe('reversed');
  });

  it('日本語のよくある 2 文字がどちら向きにもほとんど無ければ、並びの乱れとする（縦書きを横に読んだ）', () => {
    // 20 字ずつの列を、行ごとに横へ読んだ形。
    const columns = [];
    for (let i = 0; i < JAPANESE.length; i += 20) columns.push(JAPANESE.slice(i, i + 20));
    let rows = '';
    for (let r = 0; r < 20; r++) for (const column of columns) rows += column[r] ?? '';
    expect(textQuality(rows)?.kind).toBe('jumbled');
  });

  it('指摘の文言', () => {
    expect(Object.keys(TEXT_QUALITY_MESSAGE).sort()).toEqual(['garbled', 'jumbled', 'mojibake', 'reversed']);
  });
});
