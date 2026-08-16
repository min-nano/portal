// ツールをポータルへ組み込む受け口（tools-plugin.js）。
//
// ここが壊れると「ページが出来上がるが中身が違う」という気付きにくい壊れ方を
// するので、組み立ての結果そのものを固定する。
//
//   - 外枠（tool-frame.html）の目印は 1 つずつしか無い
//   - ツールの page.html は <div id="app"> の中に、overlay.html は外に入る
//   - 入口（entry.js）はそのツールの main.js を読み込む
//   - トップページのツール一覧は、載せたツールから作られる
//   - 載せるのをやめたツールのページは、組み立て直すと消える
//
// 実際に載っている 4 つのツールのマニフェストが、この受け口の決まりを
// 満たしていることも合わせて確かめる（別リポジトリへ出したあとは、この
// テストがそのままツール側の受け入れ条件になる）。

import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import tools from '../tools.config.js';
import { stageTools, toolListHtml } from '../tools-plugin.js';

const FRONTEND = fileURLToPath(new URL('..', import.meta.url));

/** 本物の外枠を置いた、使い捨ての組み立て先。 */
let root;

function staged(id, file) {
  return readFileSync(resolve(root, 'tools', id, file), 'utf8');
}

beforeAll(() => {
  root = mkdtempSync(resolve(tmpdir(), 'portal-tools-'));
  cpSync(resolve(FRONTEND, 'tool-frame.html'), resolve(root, 'tool-frame.html'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('マニフェスト', () => {
  it('載せるツールは、受け口が要る項目をすべて名乗る', () => {
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.id).toMatch(/^[a-z0-9-]+$/);
      expect(tool.name).toBeTruthy();
      expect(tool.description.trim()).toBeTruthy();
      // 位置は「マニフェスト自身の場所からの相対」で解ける。ツールが
      // portal の中にあっても node_modules の中にあっても同じ形で解けるよう、
      // 相対パスではなく dir を持たせている。
      expect(existsSync(resolve(tool.dir, tool.page))).toBe(true);
      expect(existsSync(resolve(tool.dir, tool.entry))).toBe(true);
      if (tool.overlay) expect(existsSync(resolve(tool.dir, tool.overlay))).toBe(true);
      if (tool.styles) expect(existsSync(resolve(tool.dir, tool.styles))).toBe(true);
    }
  });

  it('id は重複しない（URL と API の接頭辞になるため）', () => {
    const ids = tools.map((tool) => tool.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('ページの組み立て', () => {
  beforeAll(() => {
    stageTools(tools, root);
  });

  it('載せたツールの数だけページが出来る', () => {
    const { inputs } = stageTools(tools, root);
    expect(Object.keys(inputs).sort()).toEqual(tools.map((t) => t.id).sort());
    for (const tool of tools) {
      expect(existsSync(resolve(root, 'tools', tool.id, 'index.html'))).toBe(true);
    }
  });

  it('全ページに、同じ外枠（ヘッダー・読み込み中・ゲート・#app）が入る', () => {
    for (const tool of tools) {
      const html = staged(tool.id, 'index.html');
      expect(html).toContain('<portal-header class="portal-header"');
      expect(html).toContain('<portal-loading id="pageLoading"');
      expect(html).toContain('<portal-auth-gate id="authGate"');
      expect(html).toContain('<div id="app" class="container" hidden>');
      // 見出しはそのツールのもの。
      expect(html).toContain(`<title>${tool.title ?? tool.name}</title>`);
      // 組み立ての覚え書き（外枠の先頭のコメント）は配らない。
      expect(html).not.toContain('tools-plugin.js');
      // 目印が残っていない＝差し込みそこねが無い。
      expect(html).not.toMatch(/%TOOL_(TITLE|PAGE|OVERLAY)%/);
    }
  });

  it('page.html は #app の中に、overlay.html は外に入る', () => {
    const tool = tools.find((t) => t.overlay);
    expect(tool, 'overlay を持つツールが 1 つは要る').toBeTruthy();

    const html = staged(tool.id, 'index.html');
    const page = readFileSync(resolve(tool.dir, tool.page), 'utf8').trim();
    const overlay = readFileSync(resolve(tool.dir, tool.overlay), 'utf8').trim();

    const appStart = html.indexOf('<div id="app"');
    const appEnd = html.indexOf('</div>\n\n', appStart);
    const firstPageLine = page.split('\n')[0].trim();
    const firstOverlayLine = overlay.split('\n')[0].trim();

    expect(html.indexOf(firstPageLine)).toBeGreaterThan(appStart);
    expect(html.indexOf(firstPageLine)).toBeLessThan(appEnd);
    expect(html.indexOf(firstOverlayLine)).toBeGreaterThan(appEnd);
  });

  it('入口は、そのツールの main.js を読み込むだけ', () => {
    for (const tool of tools) {
      const entry = staged(tool.id, 'entry.js');
      const imported = entry.match(/import '(.+)';/)[1];
      expect(resolve(root, 'tools', tool.id, imported)).toBe(
        resolve(tool.dir, tool.entry)
      );
      // ページ側は、ツールの位置ではなくこの 1 枚だけを見る。
      expect(staged(tool.id, 'index.html')).toContain('src="./entry.js"');
    }
  });

  it('CSS を名乗ったツールの分だけを、見本ページ用に束ねる', () => {
    const css = readFileSync(resolve(root, 'tools', 'tools.css'), 'utf8');
    const withStyles = tools.filter((tool) => tool.styles);
    expect(css.match(/@import/g) ?? []).toHaveLength(withStyles.length);
    for (const tool of withStyles) {
      expect(css).toContain(tool.id);
    }
  });

  it('載せるのをやめたツールのページは、組み立て直すと消える', () => {
    const [dropped, ...rest] = tools;
    stageTools(rest, root);

    expect(existsSync(resolve(root, 'tools', dropped.id, 'index.html'))).toBe(false);
    for (const tool of rest) {
      expect(existsSync(resolve(root, 'tools', tool.id, 'index.html'))).toBe(true);
    }
  });

  it('外枠の目印が 1 つでなければ、組み立てずに落とす', () => {
    const broken = mkdtempSync(resolve(tmpdir(), 'portal-tools-broken-'));
    try {
      const frame = readFileSync(resolve(FRONTEND, 'tool-frame.html'), 'utf8');
      // 説明文へ目印を書き写してしまった、という壊し方を再現する。
      writeFileSync(
        resolve(broken, 'tool-frame.html'),
        frame.replace('<html lang="ja">', '<!-- %TOOL_PAGE% -->\n<html lang="ja">')
      );
      expect(() => stageTools(tools, broken)).toThrow(/%TOOL_PAGE%.*2 個/);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });
});

describe('トップページのツール一覧', () => {
  it('載せたツールが、名乗った名前と説明で並ぶ', () => {
    const html = toolListHtml(tools);
    for (const tool of tools) {
      expect(html).toContain(`href="/tools/${tool.id}/"`);
      expect(html).toContain(`<span class="name">${tool.name}</span>`);
      // 説明は字下げを落として 1 つの塊になる。
      expect(html).toContain(tool.description.trim().split('\n')[0].trim());
    }
    expect(html.match(/<li>/g)).toHaveLength(tools.length);
  });

  it('並び順は tools.config.js のとおり', () => {
    const html = toolListHtml(tools);
    const order = tools.map((tool) => html.indexOf(`/tools/${tool.id}/`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('名前と説明は HTML として逃がす（ツールの名乗りをそのまま埋めない）', () => {
    const html = toolListHtml([
      { id: 'x', name: '<script>', description: 'a & b "c"' },
    ]);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a &amp; b &quot;c&quot;');
    expect(html).not.toContain('<script>');
  });
});
