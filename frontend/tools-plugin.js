// ツールをポータルへ組み込む受け口（Vite プラグイン）。
//
// ポータルはツールの名前を 1 つも知らない。知っているのは「載せるツールの
// 一覧」（tools.config.js）だけで、そこから先はツールが自分で名乗った
// マニフェスト（src/<id>/tool.js）から決まる。
//
//   マニフェスト ─┬─→ tools/<id>/index.html  ビルドの入口（= /tools/<id>/）
//                 ├─→ tools/<id>/entry.js    ツールの入口を読み込むだけの 1 行
//                 ├─→ tools/tools.css        全ツールの CSS（見本ページ用）
//                 └─→ トップページのツール一覧
//
// 組み立て先の tools/ はビルドの成果物なのでコミットしない（.gitignore）。
// ページの外枠は tool-frame.html にあり、ツールが書くのはその中身だけ。
//
// なぜ HTML を組み立てるのか: ヘッダー・読み込み中の表示・サインインゲートは
// 並び順と id にまで意味があり、ツールごとのページへ写して回ると必ずずれる。
// ツールが増えても外枠が 1 つであることを、構造として守るため。
//
// 詳細は docs/plugin-architecture.md §4.1。

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

/** 組み立て先。/tools/<id>/ という URL は、この位置から決まる。 */
const STAGE_DIR = 'tools';

/** トップページの中の、ツール一覧を差し込む目印。 */
const TOOL_LIST_MARKER = '<!--PORTAL_TOOL_LIST-->';

/** 説明文（マニフェストの description）の字下げを落として 1 つの塊にする。 */
function trimDescription(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

/** HTML の中に文字列として置くための最小限の逃がし。 */
function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** 字下げをそろえる（外枠の中に入れたときに読める HTML にする）。 */
function indent(text, spaces) {
  const prefix = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.trim() ? prefix + line : line))
    .join('\n');
}

/**
 * マニフェストの相対指定を、実際のファイルの位置に直す。
 *
 * dir はマニフェスト自身の場所なので、ツールが portal の中にあっても
 * node_modules の中にあっても同じように解ける。
 */
function toolFile(tool, name) {
  return resolve(tool.dir, name);
}

/** 外枠に 1 つずつ置く目印。 */
const SLOTS = ['%TOOL_TITLE%', '%TOOL_PAGE%', '%TOOL_OVERLAY%'];

/**
 * 外枠を読んで、配る形（ページそのもの）にして返す。
 *
 * tool-frame.html の先頭には、組み立てるしくみの覚え書きがコメントで
 * 書いてある。これはページの一部ではないので、配るものには入れない。
 *
 * 落とし方は「コメントらしきものを消す」ではなく、**先頭から順に読み飛ばして
 * <html> に行き当たるまで進む**。覚え書きの中に <html> や目印（%TOOL_PAGE%
 * など）が文字として出てきても、境目を取り違えないようにするため
 * （実際、この外枠の覚え書きにはどちらも出てくる）。
 *
 * DOCTYPE は外枠から拾わずここで付け直す。覚え書きと DOCTYPE のどちらが先に
 * 書いてあっても同じ結果になる。
 */
function readFrame(root) {
  let rest = readFileSync(resolve(root, 'tool-frame.html'), 'utf8').trimStart();

  // <html> より前にあってよいのは、覚え書き（コメント）と DOCTYPE だけ。
  // 1 つずつ丸ごと読み飛ばすので、その中に何が書いてあっても影響しない。
  for (;;) {
    if (rest.startsWith('<!--')) {
      const end = rest.indexOf('-->');
      if (end < 0) throw new Error('tool-frame.html のコメントが閉じていません。');
      rest = rest.slice(end + '-->'.length).trimStart();
    } else if (rest.slice(0, '<!doctype'.length).toLowerCase() === '<!doctype') {
      const end = rest.indexOf('>');
      if (end < 0) throw new Error('tool-frame.html の DOCTYPE が閉じていません。');
      rest = rest.slice(end + 1).trimStart();
    } else {
      break;
    }
  }

  if (!rest.startsWith('<html')) {
    throw new Error('tool-frame.html に <html> がありません。');
  }

  const frame = `<!DOCTYPE html>\n${rest}`;
  checkSlots(frame);
  return frame;
}

/**
 * 目印が、ちょうど 1 つずつあることを確かめる。
 *
 * 0 個なら差し込む場所が無く、2 個以上なら「どちらに入るか」が書いた順で
 * 決まってしまい、壊れたページが黙って出来上がる。組み立てる前に落とす。
 */
function checkSlots(frame) {
  for (const slot of SLOTS) {
    const count = frame.split(slot).length - 1;
    if (count !== 1) {
      throw new Error(
        `tool-frame.html の ${slot} は 1 つでなければなりません（${count} 個ありました）。`
      );
    }
  }
}

/**
 * ツール 1 つ分のページ（index.html と entry.js）を組み立てる。
 *
 * @returns {string} 組み立てた index.html の絶対パス（ビルドの入口になる）
 */
function stageTool(tool, { root, frame }) {
  const outDir = resolve(root, STAGE_DIR, tool.id);
  mkdirSync(outDir, { recursive: true });

  const page = readFileSync(toolFile(tool, tool.page), 'utf8').trimEnd();
  const overlay = tool.overlay
    ? readFileSync(toolFile(tool, tool.overlay), 'utf8').trimEnd()
    : '';

  // 置き換えは関数で渡す。文字列で渡すと $& や $' が特別扱いされ、そういう
  // 文字を含むページが黙って壊れるため。
  const html = frame
    .replace('%TOOL_TITLE%', () => escapeHtml(tool.title ?? tool.name))
    .replace('%TOOL_PAGE%', () => indent(page, 4))
    .replace('%TOOL_OVERLAY%', () => indent(overlay, 2));

  const indexPath = resolve(outDir, 'index.html');
  writeFileSync(indexPath, `${html}\n`);

  // 入口は「ツールの main.js を読み込むだけ」の 1 行。HTML の src に
  // ツールの位置を直接書かず、ここを 1 枚挟むのは、パッケージとして
  // 入ってきたツール（node_modules の中）でも同じ形で解けるようにするため。
  const entry = relative(outDir, toolFile(tool, tool.entry)).replaceAll('\\', '/');
  writeFileSync(
    resolve(outDir, 'entry.js'),
    `// ${tool.name} の入口（tools-plugin.js が組み立てたもの。編集しない）。\n` +
      `import '${entry.startsWith('.') ? entry : `./${entry}`}';\n`
  );

  return indexPath;
}

/**
 * 全ツールの CSS を 1 枚にまとめる（デザインシステムの見本ページ用）。
 *
 * 見本ページは「実物と同じ CSS を読み込んで並べる」ことで実物とのずれを
 * 防いでいる（src/design-system/main.js）。ツールの CSS がツール側へ移った
 * あとも同じでいられるよう、載っているツールの分だけをここで束ねる。
 */
function stageToolStyles(tools, { root }) {
  const outDir = resolve(root, STAGE_DIR);
  mkdirSync(outDir, { recursive: true });
  const path = resolve(outDir, 'tools.css');
  const imports = tools
    .filter((tool) => tool.styles)
    .map((tool) => {
      const href = relative(outDir, toolFile(tool, tool.styles)).replaceAll('\\', '/');
      return `@import '${href.startsWith('.') ? href : `./${href}`}';`;
    });
  writeFileSync(
    path,
    [
      '/* 載っている全ツールの CSS（tools-plugin.js が組み立てたもの。編集しない）。',
      ' * デザインシステムの見本ページが、実物と同じものを読むために使う。 */',
      ...imports,
      '',
    ].join('\n')
  );
  return path;
}

/** トップページに並べるツール一覧（<li>）を組み立てる。 */
function toolListHtml(tools) {
  return tools
    .map((tool) =>
      [
        '<li>',
        `  <a class="tool-card" href="/${STAGE_DIR}/${tool.id}/">`,
        `    <span class="name">${escapeHtml(tool.name)}</span>`,
        '    <p class="desc">',
        indent(escapeHtml(trimDescription(tool.description)), 6),
        '    </p>',
        '  </a>',
        '</li>',
      ].join('\n')
    )
    .join('\n');
}

/**
 * 載せるツールを組み立てて、ビルドの入口を返す。
 *
 * vite.config.js から呼ぶ。プラグインの中ではなくここで（= 設定を組み立てる
 * 時点で）作るのは、マルチページビルドの入口が実在するファイルである必要が
 * あるため。
 *
 * @returns {{ inputs: Record<string, string>, styles: string }}
 */
export function stageTools(tools, root) {
  // 前回の組み立てを丸ごと捨ててから作る。ツールを外した・名前を変えた
  // ときに、古いページが残って配られ続けることがないようにする。
  rmSync(resolve(root, STAGE_DIR), { recursive: true, force: true });

  const frame = readFrame(root);
  const inputs = {};
  for (const tool of tools) {
    inputs[tool.id] = stageTool(tool, { root, frame });
  }
  return { inputs, styles: stageToolStyles(tools, { root }) };
}

/**
 * 組み立てたツールをポータルへつなぐ。
 *
 *   - トップページのツール一覧を差し込む
 *   - ツールの page.html / overlay.html を直したら、手元の画面を作り直す
 *
 * @param {object[]} tools 載せるツールのマニフェスト
 * @param {string} root frontend/ の絶対パス
 */
export function portalToolsPlugin(tools, root) {
  return {
    name: 'portal-tools',

    // トップページのツール一覧は、載っているツールから作る。ツールを
    // 増やしても index.html を書き換えないで済むようにするため。
    transformIndexHtml: {
      // %PORTAL_TITLE% の置換より先に処理する（説明文に混ざっていても効くように）。
      order: 'pre',
      handler(html) {
        if (!html.includes(TOOL_LIST_MARKER)) return html;
        return html.replace(TOOL_LIST_MARKER, indent(toolListHtml(tools), 6).trimStart());
      },
    },

    // 手元の開発（npm run dev）では、組み立て元を直したときに組み立て直す。
    // ツールの main.js などは Vite がそのまま見ているので、ここで見るのは
    // 組み立ての材料（ページの中身と外枠）だけでよい。
    configureServer(server) {
      const sources = new Set([resolve(root, 'tool-frame.html')]);
      for (const tool of tools) {
        sources.add(toolFile(tool, tool.page));
        if (tool.overlay) sources.add(toolFile(tool, tool.overlay));
      }
      for (const file of sources) server.watcher.add(file);

      server.watcher.on('change', (file) => {
        if (!sources.has(resolve(file))) return;
        stageTools(tools, root);
        server.ws.send({ type: 'full-reload' });
      });
    },
  };
}

export { STAGE_DIR, TOOL_LIST_MARKER, toolListHtml, trimDescription };
