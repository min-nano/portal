// このポータルに載せるツール。
//
// **ポータルがツールを知っている唯一の場所**がここ。ビルドの入口も、
// トップページのツール一覧も、ページの外枠も、ここに並んだツールが自分で
// 名乗ったマニフェスト（src/<id>/tool.js）から決まる。ツールを増やす・
// 減らす・並べ替えるときに触るのはこのファイルだけで、vite.config.js にも
// index.html にもツールの名前は出てこない。
//
// 並び順がそのままトップページの並び順になる。
//
// ツールを別リポジトリへ出したあとは、この import が
//
//   import wallQuantity from '@min-nano/tool-wall-quantity-calculator';
//
// のようなパッケージ参照に変わり、どの版を載せるかは tools.json が決める
// （docs/plugin-architecture.md §5）。マニフェストの形は変わらないので、
// このファイル以外に手は入らない。

import excelReportFormatter from './src/excel-report-formatter/tool.js';
import structuralCertFormatter from './src/structural-cert-formatter/tool.js';
import timberPanelShearCalculator from './src/timber-panel-shear-calculator/tool.js';
import wallQuantityCalculator from './src/wall-quantity-calculator/tool.js';

export default [
  excelReportFormatter,
  structuralCertFormatter,
  timberPanelShearCalculator,
  wallQuantityCalculator,
];
