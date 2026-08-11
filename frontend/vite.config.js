import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
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

// ポータルはツールごとにページを持つマルチページ構成。ツールを追加するときは
// tools/<ツール名>/index.html を作り、ここの input に追記する。
export default defineConfig(({ mode }) => ({
  appType: 'mpa',
  plugins: [
    // loadEnv は .env ファイルに加え、CI などが渡す process.env の
    // VITE_ 付き変数も拾う。
    portalTitlePlugin(
      resolvePortalTitle(loadEnv(mode, import.meta.dirname).VITE_PORTAL_TITLE)
    ),
  ],
  build: {
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
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
  },
}));
