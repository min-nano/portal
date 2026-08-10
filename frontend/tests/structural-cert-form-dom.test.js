// @vitest-environment jsdom
//
// フォームの組み立てと DOM ↔ データの往復。項目定義（/config の応答）から
// 画面が正しく作られ、入力した内容がそのまま取り出せることを確認する。

import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyFormData,
  buildForm,
  collectFormData,
} from '../src/structural-cert-formatter/form-dom.js';

const config = {
  text_fields: [
    { key: 'era_year', label: '年号・年', required: true, unit: '', hint: '例: 令和7' },
    { key: 'month', label: '月', required: true, unit: '月', hint: '' },
    { key: 'building_area', label: '建築面積', required: true, unit: 'm²', hint: '' },
    { key: 'other_calc_type', label: 'その他の構造計算の種類', required: false, unit: '', hint: '' },
  ],
  choice_groups: [
    {
      key: 'calc_type',
      label: '構造計算の種類',
      required: true,
      options: [
        { value: '1', label: '令第81条第1項', requires_field: '' },
        { value: '6', label: 'その他', requires_field: 'other_calc_type' },
      ],
    },
    {
      key: 'program_certified',
      label: '大臣の認定',
      required: false,
      options: [
        { value: '有', label: '有', requires_field: '' },
        { value: '無', label: '無', requires_field: '' },
      ],
    },
  ],
  sections: [
    { title: '証明日', items: [{ field: 'era_year' }, { field: 'month' }] },
    { title: '建築物', items: [{ field: 'building_area' }] },
    {
      title: '構造計算の種類',
      items: [{ choice: 'calc_type' }, { field: 'other_calc_type' }],
    },
    { title: 'プログラム', items: [{ choice: 'program_certified' }] },
  ],
};

let root;

beforeEach(() => {
  document.body.innerHTML = '<div id="sections"></div>';
  root = document.getElementById('sections');
  buildForm(root, config);
});

describe('buildForm', () => {
  it('sections の並びどおりにセクションを作る', () => {
    const titles = [...root.querySelectorAll('.cert-section h3')].map((h) => h.textContent);

    expect(titles).toEqual(['証明日', '建築物', '構造計算の種類', 'プログラム']);
  });

  it('記入欄には単位とラベルを付ける', () => {
    const area = root.querySelector('#field-building_area');

    expect(area.dataset.field).toBe('building_area');
    expect(area.inputMode).toBe('decimal');
    expect(root.querySelector('label[for="field-building_area"]').textContent).toBe(
      '建築面積 *'
    );
    expect(area.closest('.cert-field').querySelector('.unit').textContent).toBe('m²');
  });

  it('数値だけの欄は数字キーパッドを出す', () => {
    expect(root.querySelector('#field-month').inputMode).toBe('numeric');
    // 年号は文字を含むので通常のキーボード。
    expect(root.querySelector('#field-era_year').inputMode).toBe('');
    expect(root.querySelector('#field-era_year').placeholder).toBe('例: 令和7');
  });

  it('入力欄は文字列のまま扱う（数値入力欄にしない）', () => {
    root.querySelectorAll('[data-field]').forEach((input) => {
      expect(input.type).toBe('text');
    });
  });

  it('選択肢は証明書と同じ番号付きで並べる', () => {
    const labels = [...root.querySelectorAll('[name="choice-calc_type"]')].map(
      (radio) => radio.parentElement.textContent
    );

    expect(labels).toEqual(['1　令第81条第1項', '6　その他']);
  });

  it('必須でないグループには「指定しない」を足し、既定で選んでおく', () => {
    const radios = [...root.querySelectorAll('[name="choice-program_certified"]')];

    expect(radios.map((r) => r.value)).toEqual(['', '有', '無']);
    expect(radios[0].checked).toBe(true);
  });

  it('必須のグループは既定で未選択', () => {
    const radios = [...root.querySelectorAll('[name="choice-calc_type"]')];

    expect(radios.some((r) => r.checked)).toBe(false);
  });

  it('作り直しても項目が重複しない', () => {
    buildForm(root, config);

    expect(root.querySelectorAll('#field-month').length).toBe(1);
  });
});

describe('collectFormData / applyFormData', () => {
  it('入力した内容をそのまま取り出せる', () => {
    root.querySelector('#field-era_year').value = '令和7';
    root.querySelector('#field-building_area').value = '62.10';
    root.querySelector('[name="choice-calc_type"][value="6"]').checked = true;
    root.querySelector('[name="choice-program_certified"][value="無"]').checked = true;

    const data = collectFormData(root, config);

    expect(data.fields.era_year).toBe('令和7');
    expect(data.fields.building_area).toBe('62.10');
    expect(data.fields.month).toBe('');
    expect(data.choices).toEqual({ calc_type: '6', program_certified: '無' });
  });

  it('前後の空白は落とす', () => {
    root.querySelector('#field-era_year').value = '  令和7  ';

    expect(collectFormData(root, config).fields.era_year).toBe('令和7');
  });

  it('流し込んだ内容を取り出すと元に戻る（読み込み → 編集の往復）', () => {
    const loaded = {
      fields: {
        era_year: '令和7',
        month: '8',
        building_area: '62.10',
        other_calc_type: '限界耐力計算',
      },
      choices: { calc_type: '6', program_certified: '有' },
    };

    applyFormData(root, loaded);

    expect(collectFormData(root, config)).toEqual(loaded);
  });

  it('未選択を流し込むと選択が外れる', () => {
    root.querySelector('[name="choice-calc_type"][value="1"]').checked = true;

    applyFormData(root, {
      fields: {},
      choices: { calc_type: '', program_certified: '' },
    });

    expect(collectFormData(root, config).choices.calc_type).toBe('');
    // 必須でないグループは「指定しない」が選ばれた状態に戻る。
    expect(root.querySelector('[name="choice-program_certified"][value=""]').checked).toBe(
      true
    );
  });
});
