// ツールをポータルへ組み込む受け口（tools-plugin.js）。
//
// ここが壊れると「ページが出来上がるが中身が違う」という気付きにくい壊れ方を
// するので、組み立ての結果そのものを固定する。
//
//   - 外枠（tool-frame.html）の目印は 1 つずつしか無い
//   - ツールの page.html は <div id="app"> の中に、overlay.html は外に入る
//   - 入口（entry.js）はそのツールの main.js を読み込む
//   - トップページのツール一覧は、載せたツールから作られる（絵・名前・説明）
//   - 載せるのをやめたツールのページは、組み立て直すと消える
//   - 手元の開発では、組み立ての材料を直すと画面を読み直す
//
// 実際に載っているツールのマニフェストが、この受け口の決まりを満たして
// いることも合わせて確かめる。

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
import {
  TOOL_LIST_MARKER,
  portalToolsPlugin,
  stageTools,
  toolListHtml,
} from '../tools-plugin.js';

const FRONTEND = fileURLToPath(new URL('..', import.meta.url));

/** 本物の外枠を置いた、使い捨ての組み立て先。 */
let root;

function staged(id, file) {
  return readFileSync(resolve(root, 'tools', id, file), 'utf8');
}

/**
 * 外枠を書き換えた使い捨ての組み立て先で、1 つのことを確かめる。
 *
 * @param {(frame: string) => string} edit 本物の外枠をどう壊す（変える）か
 * @param {(root: string) => void} check その外枠で何を確かめるか
 */
function withFrame(edit, check) {
  const dir = mkdtempSync(resolve(tmpdir(), 'portal-tools-frame-'));
  try {
    const frame = readFileSync(resolve(FRONTEND, 'tool-frame.html'), 'utf8');
    writeFileSync(resolve(dir, 'tool-frame.html'), edit(frame));
    check(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
      expect(existsSync(resolve(tool.dir, tool.icon))).toBe(true);
      if (tool.overlay) expect(existsSync(resolve(tool.dir, tool.overlay))).toBe(true);
      if (tool.styles) expect(existsSync(resolve(tool.dir, tool.styles))).toBe(true);
    }
  });

  it('説明は 1 行・40 字まで（長い説明は読まれないので、詳しくは README に書く）', () => {
    for (const tool of tools) {
      const description = tool.description.trim();
      expect(description, tool.id).not.toContain('\n');
      expect([...description].length, tool.id).toBeLessThanOrEqual(40);
    }
  });

  it('絵は、色を CSS に任せた 48 の升目の SVG', () => {
    for (const tool of tools) {
      const svg = readFileSync(resolve(tool.dir, tool.icon), 'utf8').trim();
      const root = svg.match(/^<svg\b[^>]*>/)?.[0];
      expect(root, `${tool.id} の絵は <svg> で始める`).toBeTruthy();
      expect(root).toContain('viewBox="0 0 48 48"');
      // 大きさはカードの CSS が決める（SVG の側で決めると、そちらが勝つ）。
      expect(root).not.toMatch(/\s(width|height)=/);
      // 色は currentColor だけ。生の色を書くと、明暗テーマで片方が見えなくなる。
      const paints = [...svg.matchAll(/\s(?:fill|stroke)="([^"]*)"/g)].map((m) => m[1]);
      expect(paints).toContain('currentColor');
      for (const paint of paints) {
        expect(['currentColor', 'none'], `${tool.id}: ${paint}`).toContain(paint);
      }
      expect(svg, tool.id).not.toMatch(/\s(?:color|stop-color|flood-color)=/);
      // カードの中へそのまま埋め込むので、id（ページの中で 1 つでなければ
      // ならない）・スクリプト・スタイル（<style> はページ全体に効き、style=
      // は色の決まりをすり抜ける）は持たない。
      expect(svg, tool.id).not.toMatch(/\sid=|<script|<style|\sstyle=/i);
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

  it('ページの中の目印が 1 つでなければ、組み立てずに落とす', () => {
    withFrame(
      // 覚え書きの中にも <div id="app"> という字は出てくるので、実物のほう
      // （class の付いた開始タグ）を狙う。
      (frame) =>
        frame.replace(
          '<div id="app" class',
          '%TOOL_PAGE%\n  <div id="app" class'
        ),
      (root) => expect(() => stageTools(tools, root)).toThrow(/%TOOL_PAGE%.*2 個/)
    );
  });

  it('組み立てのしくみの覚え書きは、配るものに入らない', () => {
    // 覚え書きは <html> より前にあり、そこに目印が書いてあっても
    // 組み立てには影響しない（配るのは <html> から先だけなので）。
    withFrame(
      (frame) => `<!-- %TOOL_PAGE% %TOOL_TITLE% おぼえがき -->\n${frame}`,
      (root) => {
        stageTools(tools, root);
        const html = readFileSync(
          resolve(root, 'tools', tools[0].id, 'index.html'),
          'utf8'
        );
        expect(html).not.toContain('おぼえがき');
        expect(html).toMatch(/^<!DOCTYPE html>\n<html\b/);
        expect(html).toContain(`<title>${tools[0].title ?? tools[0].name}</title>`);
      }
    );
  });

  it('外枠に <html> が無ければ、組み立てずに落とす', () => {
    withFrame(
      (frame) => frame.replaceAll('<html lang="ja">', '<body>'),
      (root) => expect(() => stageTools(tools, root)).toThrow(/<html> がありません/)
    );
  });
});

describe('トップページのツール一覧', () => {
  it('載せたツールが、名乗った絵・名前・説明で並ぶ', () => {
    const html = toolListHtml(tools);
    for (const tool of tools) {
      expect(html).toContain(`href="/tools/${tool.id}/"`);
      expect(html).toContain(`<span class="name">${tool.name}</span>`);
      expect(html).toContain(`<p class="desc">${tool.description.trim()}</p>`);
    }
    expect(html.match(/<li>/g)).toHaveLength(tools.length);
  });

  it('絵はカードの中へそのまま埋め込み、読み上げからは外す', () => {
    const html = toolListHtml(tools);
    const cards = html.split('<li>').slice(1);
    tools.forEach((tool, i) => {
      const svg = readFileSync(resolve(tool.dir, tool.icon), 'utf8').trim();
      // 埋め込むときに字下げが付くので、1 行目（<svg …>）で見る。
      const firstLine = svg.split('\n')[0];
      expect(cards[i]).toContain(`<span class="tool-icon" aria-hidden="true">\n      ${firstLine}`);
      // 絵は名前より前（カードの上・左に出る）。
      expect(cards[i].indexOf('<svg')).toBeLessThan(cards[i].indexOf('class="name"'));
    });
  });

  it('絵を名乗っていないツールは、一覧を組み立てずに落とす', () => {
    const { icon, ...withoutIcon } = tools[0];
    expect(icon).toBeTruthy();
    expect(() => toolListHtml([withoutIcon])).toThrow(
      `${tools[0].id} のマニフェストに icon`
    );
  });

  it('並び順は tools.config.js のとおり', () => {
    const html = toolListHtml(tools);
    const order = tools.map((tool) => html.indexOf(`/tools/${tool.id}/`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('名前と説明は HTML として逃がす（ツールの名乗りをそのまま埋めない）', () => {
    const { dir, icon } = tools[0];
    const html = toolListHtml([
      { id: 'x', name: '<script>', description: 'a & b "c"', dir, icon },
    ]);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a &amp; b &quot;c&quot;');
    expect(html).not.toContain('<script>');
  });
});

describe('Vite プラグイン', () => {
  const plugin = portalToolsPlugin(tools, FRONTEND);

  it('トップページの目印を、ツール一覧に差し替える', () => {
    const html = plugin.transformIndexHtml.handler(
      `<ul class="tool-list">${TOOL_LIST_MARKER}</ul>`
    );
    expect(html).not.toContain(TOOL_LIST_MARKER);
    expect(html.match(/<li>/g)).toHaveLength(tools.length);
    expect(html).toContain('<span class="tool-icon" aria-hidden="true">');
  });

  it('名前や絵に $ を含む置き換えの記号があっても、そのまま入る', () => {
    const tricky = portalToolsPlugin(
      [{ ...tools[0], name: "A$'B$&C" }],
      FRONTEND
    );
    const html = tricky.transformIndexHtml.handler(
      `<ul class="tool-list">${TOOL_LIST_MARKER}</ul><footer>後ろ</footer>`
    );
    expect(html).toContain(`<span class="name">A$'B$&amp;C</span>`);
    expect(html.match(/<footer>/g)).toHaveLength(1);
  });

  it('目印の無いページ（ツールのページ・見本ページ）には触らない', () => {
    const html = '<p>ツール一覧ではないページ</p>';
    expect(plugin.transformIndexHtml.handler(html)).toBe(html);
  });

  describe('手元の開発（npm run dev）', () => {
    /** Vite の開発サーバのうち、プラグインが触る所だけを真似たもの。 */
    function fakeServer() {
      const watched = new Set();
      const listeners = [];
      const sent = [];
      return {
        watched,
        sent,
        change: (file) => listeners.forEach((listener) => listener(file)),
        watcher: {
          add: (file) => watched.add(file),
          on: (event, listener) => {
            if (event === 'change') listeners.push(listener);
          },
        },
        ws: { send: (message) => sent.push(message) },
      };
    }

    /** 本物の外枠を写した使い捨ての root で、プラグインを開発サーバにつなぐ。 */
    function withServer(check) {
      const dir = mkdtempSync(resolve(tmpdir(), 'portal-tools-dev-'));
      try {
        cpSync(resolve(FRONTEND, 'tool-frame.html'), resolve(dir, 'tool-frame.html'));
        const server = fakeServer();
        portalToolsPlugin(tools, dir).configureServer(server);
        check(server, dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it('外枠と、各ツールのページ・絵・overlay を見張る', () => {
      withServer((server, dir) => {
        expect(server.watched).toContain(resolve(dir, 'tool-frame.html'));
        for (const tool of tools) {
          expect(server.watched).toContain(resolve(tool.dir, tool.page));
          expect(server.watched).toContain(resolve(tool.dir, tool.icon));
          if (tool.overlay) {
            expect(server.watched).toContain(resolve(tool.dir, tool.overlay));
          }
        }
      });
    });

    it('絵を直すと組み立て直して、画面を読み直させる', () => {
      withServer((server, dir) => {
        server.change(resolve(tools[0].dir, tools[0].icon));
        expect(server.sent).toEqual([{ type: 'full-reload' }]);
        expect(existsSync(resolve(dir, 'tools', tools[0].id, 'index.html'))).toBe(true);
      });
    });

    it('組み立ての材料でないファイルの変更は、Vite に任せる', () => {
      withServer((server, dir) => {
        server.change(resolve(tools[0].dir, tools[0].entry));
        expect(server.sent).toEqual([]);
        expect(existsSync(resolve(dir, 'tools'))).toBe(false);
      });
    });
  });
});
