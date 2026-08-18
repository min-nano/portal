// デザインシステム（src/styles/）にツールの名前は出てこない。
//
// 「色・余白・部品は土台が持ち、ツールは生の値を書かない」という決めごとは、
// 裏返すと「土台の CSS に、1 つのツールにしか出てこない名前は書かない」でも
// ある。守られているかは目で見ても分からない——`.wq-field`（必要壁量）と
// `.cert-field`（証明書）が同じ部品の 2 つの名前として土台に居座っていたのは、
// それが理由——ので、ここで数える。
//
// 判定は「その名前を使っているのが 1 つのツールだけか」。土台の部品・ページ
// 共通のコード・見本ページのどれかが使っていれば、それは土台の語彙。
// 2 つ以上のツールが使っていれば、それは寄せた甲斐のあったものとみなす。
//
// 落ちたときの直し方は 2 通り。名前を汎用のもの（.field / .card / .danger）に
// 直して土台に残すか、その見た目ごとツールの tool.css へ移すか。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FRONTEND = fileURLToPath(new URL('..', import.meta.url));

// 土台の側（ここが名前を出してよい範囲）。
const SHARED_DIRS = ['src', 'src/components', 'src/design-system', 'design'];

function filesIn(dir) {
  return readdirSync(FRONTEND + dir)
    .map((name) => `${dir}/${name}`)
    .filter((file) => statSync(FRONTEND + file).isFile() && /\.(js|html|css)$/.test(file));
}

function textOf(files) {
  return files.map((file) => readFileSync(FRONTEND + file, 'utf8')).join('\n');
}

/** その名前が単語として出てくるか（`.field` が `.field-row` に当たらないように）。 */
function mentions(text, name) {
  return new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(text);
}

/** ツール（= src/ の下の、土台ではないディレクトリ）の一覧。 */
function toolNames() {
  return readdirSync(FRONTEND + 'src').filter(
    (name) =>
      statSync(`${FRONTEND}src/${name}`).isDirectory() &&
      !['styles', 'components', 'design-system'].includes(name)
  );
}

/** 土台の CSS の選択子に出てくるクラス名・id 名。 */
function styleSelectorNames() {
  const styles = textOf(filesIn('src/styles'));
  // 宣言の中身（url(…) の中の記号や content: '…'）は選択子ではないので落とす。
  const selectors = styles.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{[^{}]*\}/g, '{}');
  return [...new Set([...selectors.matchAll(/[.#][A-Za-z][\w-]*/g)].map((match) => match[0]))];
}

describe('デザインシステムの語彙', () => {
  it('土台の CSS に、1 つのツールにしか出てこない名前は書かない', () => {
    const tools = toolNames();
    const shared = textOf(SHARED_DIRS.flatMap(filesIn));
    const byTool = new Map(tools.map((tool) => [tool, textOf(filesIn(`src/${tool}`))]));

    const leaked = styleSelectorNames()
      .map((name) => {
        const bare = name.slice(1);
        if (mentions(shared, bare)) return null;
        const owners = tools.filter((tool) => mentions(byTool.get(tool), bare));
        return owners.length === 1 ? `${name}（${owners[0]} だけ）` : null;
      })
      .filter(Boolean);

    expect(leaked).toEqual([]);
  });

  it('ツールは 2 つ以上ある（数え方そのものが成り立っていること）', () => {
    // ツールが 1 つになると「2 つ以上が使っている」が誰にも当てはまらなくなり、
    // 上の検査は素通りする。数える対象があることを確かめておく。
    expect(toolNames().length).toBeGreaterThan(1);
    expect(styleSelectorNames().length).toBeGreaterThan(20);
  });
});
