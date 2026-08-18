// @vitest-environment jsdom
//
// 入力欄・選択肢・節の共通部品（src/components/form-field.js）。
//
// この部品は 3 つのツール（構造計算安全証明書・必要壁量・面材張り大壁）の
// 画面が共有しているので、ここで固定するのは「どのツールから見ても同じ」で
// なければ困るところ——出来上がる形（クラス名と入れ子）、ラベルと欄の
// 結び付き、単位から決まるキーパッド——の 3 つ。
//
// ツールごとの振る舞い（和暦・連動プルダウン・釘配列図）は、それぞれの
// form-dom.js のテストが受け持つ。

import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildChoiceGroup,
  buildChoiceOption,
  buildField,
  buildFieldGroup,
  buildSection,
  inputModeFor,
} from '../src/components/form-field.js';

let doc;

beforeEach(() => {
  document.body.innerHTML = '';
  doc = document;
});

describe('buildField', () => {
  it('ラベル・欄・単位・注意書きを、決まった形で組み立てる', () => {
    const { wrap, control } = buildField(doc, {
      key: 'height_1f',
      label: '1 階の階高',
      type: 'number',
      unit: 'm',
      note: '土台上端～梁上端までの距離',
    });

    expect(wrap.className).toBe('field');
    expect(wrap.dataset.fieldWrap).toBe('height_1f');
    // ラベルは欄に結び付ける（読み上げでも、押したときの焦点移動でも効く）。
    expect(wrap.querySelector('label').getAttribute('for')).toBe('field-height_1f');
    expect(wrap.querySelector('label').textContent).toBe('1 階の階高');
    // 欄と単位は 1 つの行にまとめる（単位が欄の右にくっついて見えるように）。
    expect(control.parentElement.className).toBe('field-row');
    expect(control.id).toBe('field-height_1f');
    expect(control.dataset.field).toBe('height_1f');
    expect(wrap.querySelector('.field-row > .unit').textContent).toBe('m');
    expect(wrap.querySelector('.hint').textContent).toBe('土台上端～梁上端までの距離');
  });

  it('型に合わせて欄を作る（既定は文字列のまま扱う欄）', () => {
    expect(buildField(doc, { key: 'a' }).control.type).toBe('text');
    expect(buildField(doc, { key: 'b', type: 'date' }).control.type).toBe('date');
    expect(buildField(doc, { key: 'c', type: 'select' }).control.tagName).toBe('SELECT');

    const { control } = buildField(doc, {
      key: 'd',
      type: 'number',
      step: 'any',
      min: 0,
      placeholder: '例: 2730',
    });
    expect(control.type).toBe('number');
    expect(control.step).toBe('any');
    expect(control.min).toBe('0');
    expect(control.placeholder).toBe('例: 2730');
  });

  it('選ぶ欄は候補ごと組み立て、初期値を選んでおく', () => {
    const { control } = buildField(doc, {
      key: 'side',
      type: 'select',
      value: 'back',
      options: [
        { value: 'front', text: '表面' },
        { value: 'back', text: '裏面', title: '裏側に張る面材' },
      ],
    });

    expect([...control.options].map((o) => o.textContent)).toEqual(['表面', '裏面']);
    expect(control.options[1].title).toBe('裏側に張る面材');
    expect(control.value).toBe('back');
  });

  it('見出しが名前を担うときは、ラベルを重ねずに読み上げだけ結び付ける', () => {
    const { wrap, control } = buildField(
      doc,
      { key: 'remarks', label: '備考' },
      { hideLabel: true, labelledBy: 'cert-section-4' }
    );

    expect(wrap.querySelector('label')).toBeNull();
    expect(control.getAttribute('aria-labelledby')).toBe('cert-section-4');
  });

  it('見出しも無いとき（表の桝目の中）は、読み上げ名を欄そのものに付ける', () => {
    const { control } = buildField(
      doc,
      { key: 'c2_1_jas', label: 'JAS 規格' },
      { hideLabel: true, ariaLabel: 'JAS 規格' }
    );

    expect(control.getAttribute('aria-label')).toBe('JAS 規格');
  });

  it('必須の欄には目印を付ける（折り畳んだ節を開いて示すのに使う）', () => {
    expect(buildField(doc, { key: 'a', required: true }).wrap.dataset.required).toBe('');
    expect(buildField(doc, { key: 'a' }).wrap.dataset.required).toBeUndefined();
  });

  it('同じ名前の欄が画面に何組も出るときは、id を直に決められる', () => {
    const { wrap, control } = buildField(doc, { id: 'panel-1-thickness', label: '面材の厚さ t' });

    expect(control.id).toBe('panel-1-thickness');
    expect(wrap.querySelector('label').getAttribute('for')).toBe('panel-1-thickness');
    // key を渡していないので、欄を名前で引く印は付かない（呼び出し側が足す）。
    expect(control.dataset.field).toBeUndefined();
  });
});

describe('inputModeFor', () => {
  it('整数だけの単位は数字キーパッド、小数の単位は小数点付き', () => {
    // 3 つのツールの単位をまとめて 1 つの表にしてある。
    ['mm', '寸', '月', '日', '階'].forEach((unit) => {
      expect(inputModeFor(unit, 'number')).toBe('numeric');
    });
    ['m', 'm²'].forEach((unit) => {
      expect(inputModeFor(unit, 'text')).toBe('decimal');
    });
  });

  it('表に無い単位は型に従う（自由入力の欄はふつうのキーボード）', () => {
    expect(inputModeFor('kg/m³', 'number')).toBe('decimal');
    expect(inputModeFor('', 'number')).toBe('decimal');
    expect(inputModeFor('造', 'text')).toBe('');
    expect(inputModeFor('', 'text')).toBe('');
  });

  it('欄が直に指定したときは、単位より指定を優先する', () => {
    // 面材の欄は単位をラベルに書くので、キーパッドは欄が自分で決める。
    expect(buildField(doc, { key: 'a', type: 'number', inputMode: 'numeric' }).control.inputMode)
      .toBe('numeric');
  });
});

describe('buildChoiceGroup', () => {
  it('legend・案内・選択肢・（選べない理由）をこの順に並べる', () => {
    const { wrap, controls } = buildChoiceGroup(doc, {
      legend: '構造計算の種類 *',
      name: 'choice-calc_type',
      required: true,
      note: '1 つだけ選べます。',
      options: [
        { value: '1', text: '許容応力度計算' },
        { value: '6', text: 'その他' },
      ],
      footnote: '「プログラムの名称」を入力したときに選べます。',
    });

    expect(wrap.tagName).toBe('FIELDSET');
    expect(wrap.className).toBe('choices');
    expect(wrap.dataset.required).toBe('');
    expect([...wrap.children].map((node) => node.tagName)).toEqual([
      'LEGEND',
      'P',
      'LABEL',
      'LABEL',
      'P',
    ]);
    expect(controls.map((radio) => radio.value)).toEqual(['1', '6']);
    expect(controls.every((radio) => radio.name === 'choice-calc_type')).toBe(true);
  });

  it('節の見出しが名前を担うときは、legend も囲みも重ねない', () => {
    const { wrap } = buildChoiceGroup(
      doc,
      { legend: '構造計算の種類', options: [{ value: '1', text: '許容応力度計算' }] },
      { hideLegend: true, labelledBy: 'cert-section-2' }
    );

    expect(wrap.className).toBe('choices bare');
    expect(wrap.querySelector('legend')).toBeNull();
    expect(wrap.getAttribute('aria-labelledby')).toBe('cert-section-2');
  });
});

describe('buildChoiceOption', () => {
  it('行ごと押せる札にする（既定はラジオ、チェックにもできる）', () => {
    const { wrap, control } = buildChoiceOption(doc, {
      type: 'checkbox',
      text: '柱の断面から算定する',
      checked: true,
    });

    expect(wrap.tagName).toBe('LABEL');
    expect(wrap.className).toBe('choice-option');
    expect(control.type).toBe('checkbox');
    expect(control.checked).toBe(true);
    expect(wrap.querySelector('span').textContent).toBe('柱の断面から算定する');
  });
});

describe('buildFieldGroup', () => {
  it('小見出しと案内を付けたかたまりにする', () => {
    const wrap = buildFieldGroup(doc, { label: '面材と釘', note: '表から読み込めます。' });

    expect(wrap.className).toBe('field-group');
    expect(wrap.querySelector('h4').textContent).toBe('面材と釘');
    expect(wrap.querySelector('.hint').textContent).toBe('表から読み込めます。');
  });
});

describe('buildSection', () => {
  it('折り畳める節にし、見出しと操作ボタンを開閉の行に置く', () => {
    const remove = doc.createElement('button');
    const { wrap, heading } = buildSection(doc, {
      title: '物件',
      titleId: 'cert-section-0',
      actions: remove,
    });

    expect(wrap.tagName.toLowerCase()).toBe('portal-section');
    // 中身を桝目に並べるのが既定（節に入力欄を並べるのがふつうの使い方）。
    expect(wrap.className).toBe('form-section');
    expect(heading.tagName).toBe('H3');
    expect(heading.slot).toBe('title');
    expect(heading.id).toBe('cert-section-0');
    expect(remove.slot).toBe('actions');
  });

  it('縦に積みたい節（面材 1 枚ぶん）は桝目にしない', () => {
    const { wrap, heading } = buildSection(doc, {
      title: '面材 1',
      titleTag: 'strong',
      className: 'wall-panel',
      grid: false,
    });

    expect(wrap.className).toBe('wall-panel');
    expect(heading.tagName).toBe('STRONG');
  });
});
