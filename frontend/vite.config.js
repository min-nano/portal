import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import { clerkFrontendApiHost } from './src/clerk-frontend-api.js';
import { escapeHtml, resolvePortalTitle } from './src/portal-title.js';

// HTML 内の %PORTAL_TITLE% を、環境変数 VITE_PORTAL_TITLE の値（未設定なら
// 既定値）で置き換える。Vite 標準の %VITE_XXX% 置換は未設定だとプレース
// ホルダがそのまま残ってしまうため、既定値を挟めるよう自前で処理する。
function portalTitlePlugin(title) {
  const escaped = escapeHtml(title);
  return {
    name: 'portal-title',
    transformIndexHtml: {
      // Vite 標準の %VITE_XXX% 置換より先に処理する。
      order: 'pre',
      handler(html) {
        return html.replaceAll('%PORTAL_TITLE%', escaped);
      },
    },
  };
}

// Clerk のフロントエンド API へ preconnect する <link> を、各ページの <head> の
// 先頭に入れる。
//
// 画面が出るまでの待ちは「JS を読む → Clerk がフロントエンド API に問い合わせる」
// の直列な 2 段で、2 段目は別ドメインなので名前解決・TCP・TLS から始まる。
// 接続先は Publishable Key から分かるので、HTML を読んだ時点で握手だけ先に
// 済ませておく（src/clerk-frontend-api.js）。
//
// crossorigin は付けない。Clerk の問い合わせは cookie を伴う（credentials:
// include）ので、匿名の接続を張っても使い回されないため。
function clerkPreconnectPlugin(publishableKey) {
  const host = clerkFrontendApiHost(publishableKey);
  return {
    name: 'clerk-preconnect',
    transformIndexHtml() {
      if (!host) return [];
      return [
        {
          tag: 'link',
          attrs: { rel: 'preconnect', href: `https://${host}` },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

// ポータルはツールごとにページを持つマルチページ構成。ツールを追加するときは
// tools/<ツール名>/index.html を作り、ここの input に追記する。
// デザインシステムの見本ページ（/design/）を、このビルドに含めるかどうか。
//
// 本番では配らない（社内向けの読み物であって、ツールではないため）。
// PORTAL_DESIGN_PAGE=1 を渡したときだけ入口に加える（PR プレビューと CI の
// ビルドで渡している）。既定を「含めない」にしてあるので、渡し忘れても本番に
// 出てしまうことはない。
//
// 手元の npm run dev は入口の一覧を見ずにファイルをそのまま配るので、この
// 指定に関わらず http://localhost:5173/design/ で開ける。
const designPage = process.env.PORTAL_DESIGN_PAGE === '1';

export default defineConfig(({ mode }) => {
  // loadEnv は .env ファイルに加え、CI などが渡す process.env の
  // VITE_ 付き変数も拾う。
  const env = loadEnv(mode, import.meta.dirname);

  return {
    appType: 'mpa',
    plugins: [
      portalTitlePlugin(resolvePortalTitle(env.VITE_PORTAL_TITLE)),
      clerkPreconnectPlugin(env.VITE_CLERK_PUBLISHABLE_KEY),
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'index.html'),
          // 画面の決めごと（色・寸法・部品）の見本。実際のツールと同じ CSS を
          // 読み込んで並べるので、ここが実物とずれない（本番では配らない）。
          ...(designPage
            ? { design: resolve(import.meta.dirname, 'design/index.html') }
            : {}),
          'excel-report-formatter': resolve(
            import.meta.dirname,
            'tools/excel-report-formatter/index.html'
          ),
          'structural-cert-formatter': resolve(
            import.meta.dirname,
            'tools/structural-cert-formatter/index.html'
          ),
          'timber-panel-shear-calculator': resolve(
            import.meta.dirname,
            'tools/timber-panel-shear-calculator/index.html'
          ),
          'wall-quantity-calculator': resolve(
            import.meta.dirname,
            'tools/wall-quantity-calculator/index.html'
          ),
        },
      },
    },
    server: {
      // ローカル開発ではバックエンド（uvicorn app.main:app --port 8080）へ
      // プロキシし、本番（Firebase Hosting の /api/** リライト）と同じ
      // 同一オリジン構成にする。
      proxy: {
        '/api': 'http://localhost:8080',
      },
    },
    test: {
      environment: 'node',
      coverage: {
        // 既定では無効。`npm run test:coverage`（= vitest run --coverage）と
        // CI の Frontend ジョブのときだけ測る。
        provider: 'v8',
        // テスト中に読み込まれたファイルだけでなく src/ 全体を対象にする。
        // 画面の入口（main.js・auth.js など）は単体テストが読み込まないので、
        // 指定しないと「測っていないファイル」が表から消えて率が高く見える。
        include: ['src/**/*.js'],
        // text は CI のログ用、cobertura は PR のカバレッジコメント用
        // （.github/scripts/coverage.py がこれを読む）。
        reporter: ['text', 'cobertura'],
        reportsDirectory: 'coverage',
      },
    },
  };
});
