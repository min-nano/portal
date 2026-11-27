// 分ける位置の判定（page-model.js）の重みを、手元の学習データと正解から学ぶ。
//
//   node scripts/train-split-model.mjs <一覧.json> [--write]
//
// 一覧.json は [{"book": "本の名前", "data": "学習データ.json", "labels": "正解.json"}, …]
// （パスは一覧からの相対）。同じ本の別のファイル（章ごとと結合版など）は、同じ book にする。
// 正解の unknown（[{page, end}]）の頁は、学ぶのにも頁ごとの当たり方にも数えない（分ける位置の当たり方は、
// その頁に深い単位が無いものとして正解から求めるので、目安）。
// 1 冊ずつ外して学び、外した本で確かめ（頁ごとの当たり方と、上限 40 MB で求めた分ける位置の
// 当たり方）、そのあと全部で学んだ重みを --write で src/pdf-book-merger/split-model.json に
// 書く。学習データ・正解は業務の資料を含むので、リポジトリには入れない（重みは数だけ）。

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { featureVectors, FEATURE_NAMES, trainSoftmax, predictSoftmax, argmax } from '../src/pdf-book-merger/page-model.js';
import { MAX_DEPTH, pageTargets, structureCuts } from '../src/pdf-book-merger/structure.js';

const LIMIT = 40 * 2 ** 20;
const [listPath, ...flags] = process.argv.slice(2);
if (!listPath) {
  console.error('使い方: node scripts/train-split-model.mjs <一覧.json> [--write]');
  process.exit(1);
}
const base = dirname(resolve(listPath));
const entries = JSON.parse(readFileSync(listPath, 'utf8')).map((entry) => {
  const data = JSON.parse(readFileSync(resolve(base, entry.data), 'utf8'));
  // 頁の文字のかたまり（items）は版 4 から。それより前のものは保存し直してもらう。
  if (!(data.version >= 4)) throw new Error(`${entry.data} は版 ${data.version} です。版 4 で保存し直してください`);
  const labels = JSON.parse(readFileSync(resolve(base, entry.labels), 'utf8'));
  const { top, mid } = pageTargets(labels.units, data.pages.length);
  // 正解の分からない頁（文字化けなどで、深い単位が始まるかが分からない頁）は、学ぶのにも確かめるのにも数えない。
  const known = data.pages.map(() => true);
  for (const range of labels.unknown ?? []) for (let p = range.page; p < range.end; p++) known[p] = false;
  return { book: entry.book, name: entry.data, pages: data.pages, rows: featureVectors(data.pages), top, mid, known };
});
const books = [...new Set(entries.map((entry) => entry.book))];
const classes = MAX_DEPTH + 1;

function train(set) {
  const pick = (key) => set.flatMap((entry) => entry[key].filter((_, p) => entry.known[p]));
  const rows = pick('rows');
  return { top: trainSoftmax(rows, pick('top'), classes), mid: trainSoftmax(rows, pick('mid'), classes) };
}

/** 当たり方を数える（頁ごと: 頭から始まる単位の有無と深さ。分ける位置: 正解から求めた位置との一致）。 */
function evaluate(model, entry) {
  const top = predictSoftmax(model.top, entry.rows).map(argmax);
  const mid = predictSoftmax(model.mid, entry.rows).map(argmax);
  const count = { tp: 0, fp: 0, fn: 0, depthOk: 0 };
  top.forEach((depth, p) => {
    if (!entry.known[p]) return;
    const truth = entry.top[p];
    if (depth && truth) {
      count.tp++;
      if (depth === truth) count.depthOk++;
    } else if (depth) count.fp++;
    else if (truth) count.fn++;
  });
  const sizes = entry.pages.map((page) => page.bytes);
  const want = new Set(structureCuts(entry.top, entry.mid, sizes, LIMIT));
  const got = structureCuts(top, mid, sizes, LIMIT);
  const hit = got.filter((p) => want.has(p)).length;
  return { ...count, cuts: { want: want.size, got: got.length, hit } };
}

const percent = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '-');
console.log(`本 ${books.length} 冊・ファイル ${entries.length}・頁 ${entries.reduce((s, e) => s + e.pages.length, 0)}`);
for (const book of books) {
  const model = train(entries.filter((entry) => entry.book !== book));
  for (const entry of entries.filter((entry) => entry.book === book)) {
    const r = evaluate(model, entry);
    console.log(
      `外した本で確かめる: ${entry.name}  頁の頭の単位 適合 ${percent(r.tp, r.tp + r.fp)}・再現 ${percent(r.tp, r.tp + r.fn)}` +
        `（深さも一致 ${percent(r.depthOk, r.tp)}）  分ける位置 ${r.cuts.hit} / 正解 ${r.cuts.want}（提案 ${r.cuts.got}）`
    );
  }
}
if (flags.includes('--write')) {
  const model = train(entries);
  const out = {
    version: 1,
    features: FEATURE_NAMES,
    classes,
    trainedOn: { books: books.length, files: entries.length, pages: entries.reduce((s, e) => s + e.pages.length, 0) },
    top: model.top,
    mid: model.mid,
  };
  const path = resolve(dirname(fileURLToPath(import.meta.url)), '../src/pdf-book-merger/split-model.json');
  writeFileSync(path, `${JSON.stringify(out)}\n`);
  console.log(`重みを書きました: ${path}`);
}
