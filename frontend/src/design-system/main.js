// デザインシステムの見本ページ（/design/）。
//
// 実際のツールと同じ styles.css を読み込んで、部品をそのまま並べる
// （見本のためだけの複製は作らない。複製を作ると、必ず実物とずれる）。
//
// ここでするのは 2 つだけ。
//   1. 明暗テーマの切り替え（<html data-theme> を書き換える）
//   2. 判定（OK / NG）の切り替え。結果の節の見出しの帯の色と、狭い画面で
//      出る「結果へ飛ぶ」ボタンが、判定の升目から決まることを見せる

import '../styles.css';
import './page.css';
import '../components/index.js';

const THEMES = ['auto', 'light', 'dark'];
const THEME_LABEL = { auto: '端末の設定', light: '明るい', dark: '暗い' };

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'auto') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
  document.getElementById('themeBtn').textContent = `テーマ: ${THEME_LABEL[theme]}`;
}

function setUpThemeToggle() {
  let index = 0;
  applyTheme(THEMES[index]);
  document.getElementById('themeBtn').addEventListener('click', () => {
    index = (index + 1) % THEMES.length;
    applyTheme(THEMES[index]);
  });
}

/** 判定の升目を OK / NG に入れ替える（結果の帯の色が変わるのを見せる）。 */
function setUpVerdictToggle() {
  const cell = document.getElementById('demoVerdict');
  const row = document.getElementById('demoVerdictValue');
  document.getElementById('verdictBtn').addEventListener('click', () => {
    const ng = cell.classList.contains('ng');
    cell.classList.toggle('ng', !ng);
    cell.classList.toggle('ok', ng);
    cell.textContent = ng ? 'OK' : 'NG';
    row.textContent = ng ? 'Pa = 5.88 kN/m ≦ 13.72 kN/m' : 'Pa = 21.4 kN/m > 13.72 kN/m';
  });
}

setUpThemeToggle();
setUpVerdictToggle();
