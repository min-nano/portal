// 必要壁量ツールのフォームロジック（DOM 非依存）。
//
// 画面はセルの位置も選択肢も知らず、/config が配る定義だけで動く。ここでは
// その定義を模したものを渡して、条件の判定・連動プルダウン・送信データの
// 組み立て（入力できない欄を送らないこと）を確かめる。

import { describe, expect, it } from 'vitest';
import {
  blockVisible,
  buildPayload,
  buildingOf,
  collectErrors,
  conditionMet,
  defaultValues,
  eachField,
  fallbackFileName,
  fieldRequired,
  fieldVisible,
  isoToday,
  optionLabel,
  optionsFor,
  sectionEnabled,
  toNumber,
} from '../src/wall-quantity-calculator/form-logic.js';

const SOLAR_FREE = 'あり(任意入力)';
const SNOW_YES = 'あり(多雪区域)';

const config = {
  usage: {
    key: 'usage',
    title: '0. 設計の用途',
    options: [
      { value: 'performance', label: '住宅性能表示制度を利用' },
      { value: 'standard', label: '左記以外' },
    ],
  },
  options: {
    roof: ['瓦屋根（ふき土無）', 'スレート屋根'],
    solar: ['なし(0)', 'あり(200)\n（部位面積あたり）', SOLAR_FREE],
    heavy_snow: ['ー', 'なし(一般区域)', SNOW_YES],
    seismic_zone: ['ー', '1.0', '0.9'],
    base_shear: ['0.2', '0.3'],
    ceiling_insulation: ['100\n（初期値・天井）', '任意入力'],
    wall_insulation: ['70（初期値）', '任意入力'],
    jas: ['JAS目視等級区分構造用製材', '無等級材'],
  },
  species: {
    'JAS目視等級区分構造用製材': ['すぎ', 'ひのき'],
    '無等級材': ['すぎ', 'けやき'],
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
          key: 'loads',
          title: '1. 必要壁量',
          blocks: [
            {
              kind: 'fields',
              fields: [
                { key: 'created_at', cell: 'D4', label: '作成日', type: 'date' },
                { key: 'property_name', cell: 'K4', label: '物件名', type: 'text' },
                {
                  key: 'floor_area_1f',
                  cell: 'H22',
                  label: '1階床面積',
                  type: 'number',
                  required: true,
                },
                {
                  key: 'roof_spec',
                  cell: 'H25',
                  label: '屋根の仕様',
                  type: 'select',
                  options_ref: 'roof',
                  required: true,
                },
                {
                  key: 'base_shear',
                  cell: 'H18',
                  label: '標準せん断力係数 C0',
                  type: 'select',
                  options_ref: 'base_shear',
                },
                {
                  key: 'seismic_zone',
                  cell: 'H17',
                  label: '地震地域係数 Z',
                  type: 'select',
                  options_ref: 'seismic_zone',
                  visible_when: { field: 'usage', in: ['performance'] },
                  fixed_when: { field: 'usage', not_in: ['performance'], value: 'ー' },
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
                  visible_when: { field: 'heavy_snow', in: [SNOW_YES] },
                  required_when: { field: 'heavy_snow', in: [SNOW_YES] },
                },
                {
                  key: 'solar',
                  cell: 'H27',
                  label: '太陽光発電設備等',
                  type: 'select',
                  options_ref: 'solar',
                },
                {
                  key: 'ceiling_insulation',
                  cell: 'H30',
                  label: '天井(屋根)断熱材',
                  type: 'select',
                  options_ref: 'ceiling_insulation',
                  required: true,
                },
              ],
            },
            {
              kind: 'table',
              label: '天井断熱材の任意入力',
              columns: ['', '密度'],
              visible_when: { field: 'ceiling_insulation', in: ['任意入力'] },
              rows: [
                {
                  key: 'ceiling_custom_1',
                  label: '仕様①',
                  fields: [
                    {
                      key: 'ceiling_custom_1_density',
                      cell: 'R33',
                      label: '密度',
                      type: 'number',
                    },
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

function base(overrides = {}) {
  return {
    usage: 'standard',
    created_at: '2026-08-12',
    property_name: '見本邸',
    floor_area_1f: '60',
    roof_spec: 'スレート屋根',
    base_shear: '0.2',
    seismic_zone: 'ー',
    heavy_snow: 'ー',
    snow_depth: '',
    solar: 'なし(0)',
    use_column_2: false,
    c2_1_jas: '',
    c2_1_species: '',
    c2_1_grade: '',
    ceiling_insulation: '100\n（初期値・天井）',
    ceiling_custom_1_density: '',
    ...overrides,
  };
}

describe('optionLabel', () => {
  it('配布物の選択肢の改行を、1 行にまとめて読めるようにする', () => {
    expect(optionLabel('あり(200)\n（部位面積あたり）')).toBe('あり(200) （部位面積あたり）');
  });

  it('空の値でも落ちない', () => {
    expect(optionLabel(undefined)).toBe('');
    expect(optionLabel(null)).toBe('');
  });
});

describe('conditionMet', () => {
  it('条件が無ければ常に満たす', () => {
    expect(conditionMet(undefined, {})).toBe(true);
  });

  it('in / not_in を判定する', () => {
    expect(conditionMet({ field: 'usage', in: ['performance'] }, { usage: 'performance' })).toBe(true);
    expect(conditionMet({ field: 'usage', in: ['performance'] }, { usage: 'standard' })).toBe(false);
    expect(conditionMet({ field: 'usage', not_in: ['performance'] }, { usage: 'standard' })).toBe(true);
  });

  it('未入力は空文字として扱う', () => {
    expect(conditionMet({ field: 'usage', in: [''] }, {})).toBe(true);
  });
});

describe('表示と必須', () => {
  const building = buildingOf(config, 'one_story');
  const loads = building.sections[0];
  const zone = loads.blocks[0].fields.find((f) => f.key === 'seismic_zone');
  const snow = loads.blocks[0].fields.find((f) => f.key === 'snow_depth');

  it('地震地域係数は住宅性能表示制度のときだけ入力できる', () => {
    expect(fieldVisible(loads, zone, base({ usage: 'performance' }))).toBe(true);
    expect(fieldVisible(loads, zone, base({ usage: 'standard' }))).toBe(false);
  });

  it('垂直積雪量は多雪区域のときだけ必須になる', () => {
    const heavy = base({ usage: 'performance', heavy_snow: SNOW_YES });
    expect(fieldVisible(loads, snow, heavy)).toBe(true);
    expect(fieldRequired(snow, heavy)).toBe(true);
    expect(fieldRequired(snow, base())).toBe(false);
  });

  it('算定方法のチェックが外れている節は入力できない', () => {
    const column = building.sections[1];
    const field = column.blocks[0].rows[0].fields[0];
    expect(sectionEnabled(column, base())).toBe(false);
    expect(fieldVisible(column, field, base())).toBe(false);
    expect(fieldVisible(column, field, base({ use_column_2: true }))).toBe(true);
  });

  it('任意入力の表は、断熱材で「任意入力」を選んだときだけ出す', () => {
    const block = loads.blocks[1];
    expect(blockVisible(loads, block, base())).toBe(false);
    expect(blockVisible(loads, block, base({ ceiling_insulation: '任意入力' }))).toBe(true);
  });
});

describe('optionsFor', () => {
  const building = buildingOf(config, 'one_story');
  const row = building.sections[1].blocks[0].rows[0];

  it('連動していない選択欄は options_ref を引く', () => {
    const roof = building.sections[0].blocks[0].fields.find((f) => f.key === 'roof_spec');
    expect(optionsFor(roof, base(), config)).toEqual(config.options.roof);
  });

  it('樹種等・等級等は同じ行の JAS 規格で決まる', () => {
    const values = base({ c2_1_jas: '無等級材' });
    expect(optionsFor(row.fields[1], values, config)).toEqual(['すぎ', 'けやき']);
    expect(optionsFor(row.fields[2], values, config)).toEqual(['ー']);
  });

  it('JAS 規格が未選択なら候補は空', () => {
    expect(optionsFor(row.fields[1], base(), config)).toEqual([]);
  });

  it('選択欄以外は候補を持たない', () => {
    const area = building.sections[0].blocks[0].fields.find((f) => f.key === 'floor_area_1f');
    expect(optionsFor(area, base(), config)).toEqual([]);
  });
});

describe('eachField', () => {
  it('かたまりと表の両方の入力欄を、節と行つきで返す', () => {
    const fields = eachField(buildingOf(config, 'one_story'));
    const keys = fields.map((f) => f.field.key);
    expect(keys).toContain('floor_area_1f');
    expect(keys).toContain('c2_1_grade');
    const grade = fields.find((f) => f.field.key === 'c2_1_grade');
    expect(grade.row.label).toBe('①');
  });
});

describe('collectErrors', () => {
  it('過不足なく入力できていれば何も言わない', () => {
    expect(collectErrors(config, 'one_story', base())).toEqual([]);
  });

  it('用途を選んでいないと、そこだけを指摘する', () => {
    expect(collectErrors(config, 'one_story', base({ usage: '' }))).toEqual([
      '「0. 設計の用途」を 1 つ選んでください。',
    ]);
  });

  it('足りない入力を 1 つにまとめて挙げる', () => {
    const errors = collectErrors(config, 'one_story', base({ floor_area_1f: '', roof_spec: '' }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('1階床面積');
    expect(errors[0]).toContain('屋根の仕様');
  });

  it('多雪区域を選んだのに垂直積雪量が空なら止める', () => {
    const values = base({ usage: 'performance', heavy_snow: SNOW_YES });
    expect(collectErrors(config, 'one_story', values)[0]).toContain('垂直積雪量');
  });

  it('候補にない選択は止める', () => {
    const errors = collectErrors(config, 'one_story', base({ roof_spec: 'かやぶき' }));
    expect(errors).toContain('「屋根の仕様」に選べない値が入っています。');
  });

  it('数値欄に数値以外が入っていれば止める', () => {
    const errors = collectErrors(config, 'one_story', base({ floor_area_1f: 'ろくじゅう' }));
    expect(errors).toContain('「1階床面積」には数値を入力してください。');
  });

  it('入力できない欄の値は見ない', () => {
    // 用途が「左記以外」なら地震地域係数は入力できないので、候補外でも通す。
    const values = base({ seismic_zone: 'とんでもない値' });
    expect(collectErrors(config, 'one_story', values)).toEqual([]);
  });

  it('知らない建物は建物の種別として指摘する', () => {
    expect(collectErrors(config, 'ないもの', base())).toEqual(['建物の種別を選んでください。']);
  });
});

describe('toNumber', () => {
  it('全角の数字も読む', () => {
    expect(toNumber('３．５')).toBe(3.5);
  });

  it('数値にならないものは NaN', () => {
    expect(Number.isNaN(toNumber('だいたい'))).toBe(true);
    expect(Number.isNaN(toNumber(''))).toBe(true);
    expect(Number.isNaN(toNumber(undefined))).toBe(true);
  });
});

describe('buildPayload', () => {
  it('入力できる欄だけを送る', () => {
    const values = base({ seismic_zone: '0.9', snow_depth: '100' });
    const payload = buildPayload(config, 'one_story', values);
    // 用途が「左記以外」なので地震地域係数は送らない。多雪区域でもないので積雪も送らない。
    expect(payload.values.seismic_zone).toBeUndefined();
    expect(payload.values.snow_depth).toBeUndefined();
    expect(payload.values.floor_area_1f).toBe('60');
  });

  it('算定方法のチェックと、その中の入力を一緒に送る', () => {
    const values = base({
      use_column_2: true,
      c2_1_jas: '無等級材',
      c2_1_species: 'すぎ',
      c2_1_grade: 'ー',
    });
    const payload = buildPayload(config, 'one_story', values);
    expect(payload.toggles).toEqual({ use_column_2: true });
    expect(payload.values.c2_1_species).toBe('すぎ');
  });

  it('チェックが外れていれば、その節の入力は送らない', () => {
    const values = base({ use_column_2: false, c2_1_jas: '無等級材' });
    const payload = buildPayload(config, 'one_story', values);
    expect(payload.values.c2_1_jas).toBeUndefined();
  });

  it('建物と用途と物件名を添える', () => {
    const payload = buildPayload(config, 'one_story', base());
    expect(payload.building).toBe('one_story');
    expect(payload.usage).toBe('standard');
    expect(payload.values.property_name).toBe('見本邸');
  });
});

describe('fallbackFileName', () => {
  it('建物の種別と物件名を添える', () => {
    expect(fallbackFileName(config, 'one_story', '見本邸')).toBe(
      '必要壁量 表計算ツール（平屋建て）_見本邸.xlsx'
    );
  });

  it('物件名が無ければ種別だけ', () => {
    expect(fallbackFileName(config, 'one_story', '')).toBe(
      '必要壁量 表計算ツール（平屋建て）.xlsx'
    );
  });

  it('ファイル名に使えない文字は落とす', () => {
    expect(fallbackFileName(config, 'one_story', 'A/B:C')).toBe(
      '必要壁量 表計算ツール（平屋建て）_ABC.xlsx'
    );
  });
});

describe('defaultValues', () => {
  it('配布物の初期値に揃える', () => {
    const values = defaultValues(config, 'one_story', new Date(2026, 7, 12));
    expect(values.created_at).toBe('2026-08-12');
    expect(values.base_shear).toBe('0.2');
    expect(values.seismic_zone).toBe('ー');
    expect(values.heavy_snow).toBe('ー');
    expect(values.ceiling_insulation).toBe('100\n（初期値・天井）');
    expect(values.wall_insulation).toBeUndefined(); // この模擬定義には欄が無い
    expect(values.use_column_2).toBe(false);
    expect(values.usage).toBe('');
  });

  it('知らない建物でも落ちない', () => {
    expect(defaultValues(config, 'ないもの')).toEqual({ usage: '', property_name: '' });
  });
});

describe('isoToday', () => {
  it('日付入力の形（YYYY-MM-DD）にする', () => {
    expect(isoToday(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});
