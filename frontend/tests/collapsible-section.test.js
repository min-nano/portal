// @vitest-environment jsdom
//
// 折り畳めるセクション <portal-section> と、その一括開閉。
// 入力・計算の量が増えても入力箇所を探せるようにするための部品なので、
// 「閉じても中身が消えない（DOM には残る）」「見出しに置いた操作ボタンや
// 入力欄はそのまま使える」ことをここで固定する。

import { beforeEach, describe, expect, it } from 'vitest';
import {
  revealSection,
  setSectionsOpen,
} from '../src/components/collapsible-section.js';
import '../src/components/section-controls.js';

function section(inner) {
  document.body.innerHTML = `<portal-section>${inner}</portal-section>`;
  return document.querySelector('portal-section');
}

function toggleButton(node) {
  return node.shadowRoot.querySelector('.toggle');
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('portal-section', () => {
  it('既定では開いている（属性を書き忘れても中身は出る）', () => {
    const node = section('<h3 slot="title">物件</h3><input id="a">');
    expect(node.open).toBe(true);
    expect(toggleButton(node).getAttribute('aria-expanded')).toBe('true');
  });

  it('collapsed 属性が付いているあいだだけ折り畳む', () => {
    const node = section('<h3 slot="title">物件</h3><input id="a">');
    node.open = false;

    expect(node.hasAttribute('collapsed')).toBe(true);
    expect(toggleButton(node).getAttribute('aria-expanded')).toBe('false');
    // 折り畳んでも入力は DOM に残る（保存する内容は変わらない）。
    expect(node.querySelector('#a')).not.toBeNull();
  });

  it('つまみを押すたびに開閉し、開閉を知らせる', () => {
    const node = section('<h3 slot="title">物件</h3>');
    const seen = [];
    node.addEventListener('section-toggle', (event) => seen.push(event.detail.open));

    toggleButton(node).click();
    expect(node.open).toBe(false);
    toggleButton(node).click();
    expect(node.open).toBe(true);
    expect(seen).toEqual([false, true]);
  });

  it('見出しのどこを押しても開閉する', () => {
    const node = section('<h3 slot="title">物件</h3>');
    node.querySelector('h3').click();
    expect(node.open).toBe(false);
  });

  it('見出しに並べた操作ボタン・入力欄では開閉しない', () => {
    const node = section(
      '<div slot="title"><h3>部屋 1</h3><input data-room-field="floor"></div>' +
        '<button type="button" slot="actions">削除</button>'
    );

    node.querySelector('[slot="actions"]').click();
    expect(node.open).toBe(true);
    node.querySelector('input').click();
    expect(node.open).toBe(true);
  });

  it('つまみの読み上げ名は見出しから作る（label 属性が優先）', () => {
    const node = section('<h3 slot="title">面材と釘</h3>');
    expect(toggleButton(node).getAttribute('aria-label')).toBe('面材と釘（開閉）');

    node.setAttribute('label', '部屋 1（1階 LDK）');
    expect(toggleButton(node).getAttribute('aria-label')).toBe('部屋 1（1階 LDK）（開閉）');
  });
});

describe('setSectionsOpen / revealSection', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="form">
        <portal-section id="outer">
          <h3 slot="title">壁</h3>
          <portal-section id="inner">
            <h3 slot="title">面材 1</h3>
            <input id="edge">
          </portal-section>
        </portal-section>
      </div>
      <portal-section id="outside"><h3 slot="title">別の場所</h3></portal-section>
    `;
  });

  it('範囲の中のセクションをまとめて開閉する', () => {
    setSectionsOpen(document.getElementById('form'), false);

    expect(document.getElementById('outer').open).toBe(false);
    expect(document.getElementById('inner').open).toBe(false);
    // 範囲の外は触らない。
    expect(document.getElementById('outside').open).toBe(true);

    setSectionsOpen(document.getElementById('form'), true);
    expect(document.getElementById('outer').open).toBe(true);
  });

  it('その欄を囲むセクションを、入れ子ごと開く', () => {
    setSectionsOpen(document, false);
    revealSection(document.getElementById('edge'));

    expect(document.getElementById('inner').open).toBe(true);
    expect(document.getElementById('outer').open).toBe(true);
    expect(document.getElementById('outside').open).toBe(false);
  });
});

describe('portal-section-controls', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <portal-section-controls for="form"></portal-section-controls>
      <div id="form"><portal-section id="a"><h3 slot="title">あ</h3></portal-section></div>
      <portal-section id="b"><h3 slot="title">い</h3></portal-section>
    `;
  });

  it('「すべて展開」「すべて折りたたむ」を出す', () => {
    const buttons = document.querySelectorAll('portal-section-controls button');
    expect([...buttons].map((b) => b.textContent)).toEqual([
      'すべて展開',
      'すべて折りたたむ',
    ]);
    // フォームの中に置いても送信ボタンにならない。
    expect(buttons[0].type).toBe('button');
  });

  it('for で指した範囲だけをまとめて開閉する', () => {
    const [expand, collapse] = document.querySelectorAll('portal-section-controls button');

    collapse.click();
    expect(document.getElementById('a').open).toBe(false);
    expect(document.getElementById('b').open).toBe(true);

    expand.click();
    expect(document.getElementById('a').open).toBe(true);
  });
});
