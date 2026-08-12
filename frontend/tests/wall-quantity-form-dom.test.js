// @vitest-environment jsdom
//
// 必要壁量ツールのフォームの組み立てと、DOM ↔ 入力値の往復。
// 画面には項目を持たないので、/config を模した定義から画面が正しく
// 作られること、連動プルダウンが作り直されること、入力できない欄の値が
// 残らないことを確かめる。

import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildForm,
  buildUsage,
  readValues,
  refresh,
  writeValues,
} from '../src/wall-quantity-calculator/form-dom.js';

const config = {
  usage: {
    key: 'usage',
    title: '0. 設計の用途',
    note: 'いずれか 1 つ',
    options: [
      { value: 'performance', label: '住宅性能表示制度を利用' },
      { value: 'standard', label: '左記以外' },
    ],
  },
  options: {
    roof: ['瓦屋根（ふき土無）', 'スレート屋根'],
    heavy_snow: ['ー', 'なし(一般区域)', 'あり(多雪区域)'],
    jas: ['JAS目視等級区分構造用製材', '無等級材'],
  },
  species: {
    'JAS目視等級区分構造用製材': ['すぎ', 'ひのき'],
    '無等級材': ['けやき'],
  },
  grade: {
    'JAS目視等級区分構造用製材': ['一級', '二級'],
    '無等級材': ['ー'],
  },
  file_name: { prefix: '必要壁量 表計算ツール', extension: '.xlsx' },
  buildings: [
    {
      key: 'one_story',
      label: '平屋建て',
      sections: [
        {
          key: 'header',
          title: '作成者',
          blocks: [
            {
              kind: 'fields',
              fields: [
                { key: 'created_at', cell: 'D4', label: '作成日', type: 'date' },
                { key: 'property_name', cell: 'K4', label: '物件名', type: 'text' },
              ],
            },
          ],
        },
        {
          key: 'loads',
          title: '1. 必要壁量',
          note: '緑の欄にあたる入力です。',
          blocks: [
            {
              kind: 'fields',
              fields: [
                {
                  key: 'height_1f',
                  cell: 'H15',
                  label: '1階階高',
                  type: 'number',
                  unit: 'm',
                  step: '0.001',
                  min: 0,
                  required: true,
                  note: '土台上端～梁上端までの距離',
                },
                {
                  key: 'roof_pitch',
                  cell: 'H24',
                  label: '屋根勾配',
                  type: 'number',
                  unit: '寸',
                },
                {
                  key: 'roof_spec',
                  cell: 'H25',
                  label: '屋根の仕様',
                  type: 'select',
                  options_ref: 'roof',
                },
                {
                  key: 'heavy_snow',
                  cell: 'H19',
                  label: '多雪区域の指定',
                  type: 'select',
                  options_ref: 'heavy_snow',
                  visible_when: { field: 'usage', in: ['performance'] },
                },
                {
                  key: 'snow_depth',
                  cell: 'H20',
                  label: '垂直積雪量',
                  type: 'number',
                  unit: 'cm',
                  visible_when: { field: 'heavy_snow', in: ['あり(多雪区域)'] },
                  required_when: { field: 'heavy_snow', in: ['あり(多雪区域)'] },
                },
              ],
            },
            {
              kind: 'table',
              label: '任意入力',
              columns: ['', '密度'],
              visible_when: { field: 'roof_spec', in: ['スレート屋根'] },
              rows: [
                {
                  key: 'custom_1',
                  label: '仕様①',
                  fields: [
                    { key: 'custom_1_density', cell: 'R33', label: '密度', type: 'number' },
                  ],
                },
              ],
            },
          ],
        },
        {
          key: 'column_2',
          title: '2-2 柱の小径',
          toggle: { key: 'use_column_2', cell: 'W61', label: '2-2 を使う' },
          blocks: [
            {
              kind: 'table',
              label: '1階',
              columns: ['', 'JAS規格', '樹種等', '等級等'],
              rows: [
                {
                  key: 'c2_1',
                  label: '①',
                  fields: [
                    {
                      key: 'c2_1_jas',
                      cell: 'D66',
                      label: 'JAS規格',
                      type: 'select',
                      options_ref: 'jas',
                    },
                    {
                      key: 'c2_1_species',
                      cell: 'I66',
                      label: '樹種等',
                      type: 'select',
                      cascade: { role: 'species', of: 'c2_1_jas' },
                    },
                    {
                      key: 'c2_1_grade',
                      cell: 'L66',
                      label: '等級等',
                      type: 'select',
                      cascade: { role: 'grade', of: 'c2_1_jas' },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

let root;

function values(overrides = {}) {
  return {
    usage: 'standard',
    created_at: '2026-08-12',
    property_name: '',
    height_1f: '',
    roof_pitch: '',
    roof_spec: '',
    heavy_snow: '',
    snow_depth: '',
    custom_1_density: '',
    use_column_2: false,
    c2_1_jas: '',
    c2_1_species: '',
    c2_1_grade: '',
    ...overrides,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  root = document.createElement('div');
  root.appendChild(buildForm(document, config, 'one_story'));
  document.body.appendChild(root);
});

describe('buildForm', () => {
  it('定義された節をすべて作る', () => {
    const titles = Array.from(root.querySelectorAll('[data-section] h3')).map(
      (h) => h.textContent
    );
    expect(titles).toEqual(['作成者', '1. 必要壁量', '2-2 柱の小径']);
  });

  it('用途の選択を最初の節の直後に置く', () => {
    const children = Array.from(root.querySelector('.wq-form').children);
    expect(children[0].dataset.section).toBe('header');
    expect(children[1].querySelector('legend').textContent).toBe('0. 設計の用途');
  });

  it('入力欄の型・単位・注意書きを定義どおりに作る', () => {
    const height = root.querySelector('[data-field="height_1f"]');
    expect(height.type).toBe('number');
    expect(height.step).toBe('0.001');
    expect(height.min).toBe('0');
    expect(height.inputMode).toBe('decimal');
    const wrap = root.querySelector('[data-field-wrap="height_1f"]');
    expect(wrap.querySelector('.unit').textContent).toBe('m');
    expect(wrap.querySelector('.hint').textContent).toBe('土台上端～梁上端までの距離');
  });

  it('mm や寸の欄は数字キーパッドを出す', () => {
    expect(root.querySelector('[data-field="roof_pitch"]').inputMode).toBe('numeric');
  });

  it('日付・文字列の欄はそれぞれの型で作る', () => {
    expect(root.querySelector('[data-field="created_at"]').type).toBe('date');
    expect(root.querySelector('[data-field="property_name"]').type).toBe('text');
  });

  it('柱材は表として作り、列見出しと行の記号を持つ', () => {
    const section = root.querySelector('[data-section="column_2"]');
    const heads = Array.from(section.querySelectorAll('thead th')).map((th) => th.textContent);
    expect(heads).toEqual(['', 'JAS規格', '樹種等', '等級等']);
    expect(section.querySelector('tbody th').textContent).toBe('①');
  });

  it('表の中の入力にはラベルの代わりに aria-label を付ける', () => {
    const select = root.querySelector('[data-field="c2_1_jas"]');
    expect(select.getAttribute('aria-label')).toBe('JAS規格');
    expect(root.querySelector('label[for="field-c2_1_jas"]')).toBeNull();
  });

  it('算定方法のチェックボックスを作る', () => {
    const toggle = root.querySelector('[data-field="use_column_2"]');
    expect(toggle.type).toBe('checkbox');
    expect(toggle.dataset.toggle).toBe('true');
  });

  it('知らない建物なら空のまま返す', () => {
    const empty = buildForm(document, config, 'ないもの');
    expect(empty.children).toHaveLength(0);
  });
});

describe('buildUsage', () => {
  it('選択肢をラジオにする（配布物ではチェックボックスだが 1 つしか選べない）', () => {
    const node = buildUsage(document, config.usage);
    const radios = node.querySelectorAll('input[type="radio"]');
    expect(radios).toHaveLength(2);
    expect(radios[0].name).toBe('usage');
    expect(radios[0].value).toBe('performance');
  });
});

describe('readValues / writeValues', () => {
  it('書いた値をそのまま読み戻せる', () => {
    const written = values({
      usage: 'performance',
      property_name: '見本邸',
      height_1f: '3',
      use_column_2: true,
    });
    refresh(root, config, 'one_story', written);
    writeValues(root, written);
    const read = readValues(root);
    expect(read.property_name).toBe('見本邸');
    expect(read.height_1f).toBe('3');
    expect(read.use_column_2).toBe(true);
    expect(read.usage).toBe('performance');
  });

  it('用途を選んでいなければ空文字', () => {
    writeValues(root, values({ usage: '' }));
    expect(readValues(root).usage).toBe('');
  });

  it('未定義の値は空欄にする', () => {
    writeValues(root, { property_name: undefined });
    expect(root.querySelector('[data-field="property_name"]').value).toBe('');
  });
});

describe('refresh', () => {
  it('JAS 規格に応じて樹種等・等級等の候補を作り直す', () => {
    refresh(root, config, 'one_story', values({ use_column_2: true, c2_1_jas: '無等級材' }));
    const species = root.querySelector('[data-field="c2_1_species"]');
    expect(Array.from(species.options).map((o) => o.value)).toEqual(['', 'けやき']);
    expect(species.options[0].textContent).toBe('（未選択）');
  });

  it('規格を変えて候補から外れた選択は捨てる', () => {
    let current = values({
      use_column_2: true,
      c2_1_jas: 'JAS目視等級区分構造用製材',
      c2_1_species: 'ひのき',
    });
    current = refresh(root, config, 'one_story', current);
    expect(current.c2_1_species).toBe('ひのき');

    current = refresh(root, config, 'one_story', { ...current, c2_1_jas: '無等級材' });
    expect(current.c2_1_species).toBe('');
  });

  it('選択肢の改行は 1 行にして見せる（値そのものは変えない）', () => {
    const withNewline = {
      ...config,
      options: { ...config.options, roof: ['金属板ぶき\n（例）'] },
    };
    refresh(root, withNewline, 'one_story', values());
    const select = root.querySelector('[data-field="roof_spec"]');
    expect(select.options[1].value).toBe('金属板ぶき\n（例）');
    expect(select.options[1].textContent).toBe('金属板ぶき （例）');
  });

  it('チェックの外れた節の入力を使えなくし、値も消す', () => {
    let current = values({ use_column_2: true, c2_1_jas: '無等級材' });
    current = refresh(root, config, 'one_story', current);
    writeValues(root, current);

    current = refresh(root, config, 'one_story', { ...current, use_column_2: false });
    expect(root.querySelector('[data-section="column_2"]').classList).toContain('disabled');
    expect(root.querySelector('[data-field="c2_1_jas"]').disabled).toBe(true);
    expect(current.c2_1_jas).toBe('');
  });

  it('条件を満たさない欄は隠して値を消す', () => {
    let current = values({ usage: 'performance', heavy_snow: 'あり(多雪区域)', snow_depth: '100' });
    current = refresh(root, config, 'one_story', current);
    writeValues(root, current);
    expect(root.querySelector('[data-field-wrap="snow_depth"]').hidden).toBe(false);

    current = refresh(root, config, 'one_story', { ...current, usage: 'standard' });
    expect(root.querySelector('[data-field-wrap="heavy_snow"]').hidden).toBe(true);
    expect(current.heavy_snow).toBe('');
    expect(current.snow_depth).toBe('');
  });

  it('条件つきの表を出し入れする', () => {
    const block = () =>
      root.querySelector('[data-section="loads"] [data-block-index="1"]');
    refresh(root, config, 'one_story', values());
    expect(block().hidden).toBe(true);

    refresh(root, config, 'one_story', values({ roof_spec: 'スレート屋根' }));
    expect(block().hidden).toBe(false);
  });

  it('必須の欄に印を付ける', () => {
    refresh(root, config, 'one_story', values());
    expect(root.querySelector('[data-field-wrap="height_1f"]').classList).toContain(
      'required'
    );
    expect(root.querySelector('[data-field-wrap="roof_pitch"]').classList).not.toContain(
      'required'
    );
  });

  it('知らない建物なら何もしない', () => {
    const current = values();
    expect(refresh(root, config, 'ないもの', current)).toBe(current);
  });
});
