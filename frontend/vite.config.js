import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// ポータルはツールごとにページを持つマルチページ構成。ツールを追加するときは
// tools/<ツール名>/index.html を作り、ここの input に追記する。
export default defineConfig({
  appType: 'mpa',
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
});
