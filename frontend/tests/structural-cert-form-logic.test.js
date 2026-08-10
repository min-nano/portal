import { describe, expect, it } from 'vitest';
import {
  canOverwrite,
  confirmSaveMessage,
  emptyFormData,
  ensurePdfExtension,
  mergeFormData,
  sanitizeFileName,
  suggestedFileName,
  validateFormData,
} from '../src/structural-cert-formatter/form-logic.js';

// バックエンドの /config が配る定義の縮小版。
const config = {
  text_fields: [
    { key: 'building_name', label: '建築物の名称', required: true, unit: '', hint: '' },
    { key: 'building_area', label: '建築面積', required: true, unit: 'm²', hint: '' },
    { key: 'program_name', label: 'プログラムの名称', required: false, unit: '', hint: '' },
    {
      key: 'other_calc_type',
      label: 'その他の構造計算の種類',
      required: false,
      unit: '',
      hint: '',
    },
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
  file_name_template: '構造計算安全証明書_{building_name}.pdf',
  default_file_name: '構造計算安全証明書.pdf',
};

function data(fields = {}, choices = {}) {
  const base = emptyFormData(config);
  return {
    fields: { ...base.fields, ...fields },
    choices: { ...base.choices, ...choices },
  };
}

describe('emptyFormData', () => {
  it('定義されたキーをすべて空文字で持つ', () => {
    expect(emptyFormData(config)).toEqual({
      fields: {
        building_name: '',
        building_area: '',
        program_name: '',
        other_calc_type: '',
      },
      choices: { calc_type: '', program_certified: '' },
    });
  });
});

describe('mergeFormData', () => {
  it('解析結果を現在の定義に合わせて取り込む', () => {
    const merged = mergeFormData(config, {
      fields: { building_name: 'サンプル邸', building_area: '62.10' },
      choices: { calc_type: '1' },
    });

    expect(merged.fields.building_name).toBe('サンプル邸');
    expect(merged.fields.program_name).toBe('');
    expect(merged.choices.calc_type).toBe('1');
    expect(merged.choices.program_certified).toBe('');
  });

  it('定義に無いキーと不正な選択肢は捨てる', () => {
    const merged = mergeFormData(config, {
      fields: { unknown: 'x' },
      choices: { calc_type: '9' },
    });

    expect(merged.fields.unknown).toBeUndefined();
    expect(merged.choices.calc_type).toBe('');
  });

  it('中身が無くても空のフォームデータになる', () => {
    expect(mergeFormData(config, {})).toEqual(emptyFormData(config));
    expect(mergeFormData(config, null)).toEqual(emptyFormData(config));
  });
});

describe('validateFormData', () => {
  it('未入力の必須項目をラベルで返す', () => {
    expect(validateFormData(config, data())).toEqual([
      '建築物の名称',
      '建築面積',
      '構造計算の種類',
    ]);
  });

  it('必須がそろえば何も返さない', () => {
    const filled = data(
      { building_name: 'サンプル邸', building_area: '62.10' },
      { calc_type: '1' }
    );

    expect(validateFormData(config, filled)).toEqual([]);
  });

  it('選択肢に紐づく入力欄は、その選択肢を選んだときだけ必須になる', () => {
    const base = { building_name: 'A', building_area: '1' };

    expect(validateFormData(config, data(base, { calc_type: '6' }))).toEqual([
      'その他の構造計算の種類',
    ]);
    expect(validateFormData(config, data(base, { calc_type: '1' }))).toEqual([]);
    expect(
      validateFormData(
        config,
        data({ ...base, other_calc_type: '限界耐力計算' }, { calc_type: '6' })
      )
    ).toEqual([]);
  });

  it('空白だけの入力は未入力として扱う', () => {
    const filled = data({ building_name: '   ', building_area: '1' }, { calc_type: '1' });

    expect(validateFormData(config, filled)).toEqual(['建築物の名称']);
  });
});

describe('sanitizeFileName', () => {
  it('ファイル名に使えない文字を落とす', () => {
    expect(sanitizeFileName('a/b:c*d?e"f<g>h|i')).toBe('abcdefghi');
    expect(sanitizeFileName('  余白  ')).toBe('余白');
    expect(sanitizeFileName('..隠し..')).toBe('隠し');
  });
});

describe('suggestedFileName', () => {
  it('建築物の名称を差し込む', () => {
    expect(
      suggestedFileName(config.file_name_template, data({ building_name: 'サンプル邸' }), 'x.pdf')
    ).toBe('構造計算安全証明書_サンプル邸.pdf');
  });

  it('名称が空なら余分な区切りを残さない', () => {
    expect(suggestedFileName(config.file_name_template, data(), 'x.pdf')).toBe(
      '構造計算安全証明書.pdf'
    );
  });

  it('名称に使えない文字が入っていても安全な名前になる', () => {
    expect(
      suggestedFileName(config.file_name_template, data({ building_name: 'A/B' }), 'x.pdf')
    ).toBe('構造計算安全証明書_AB.pdf');
  });
});

describe('ensurePdfExtension', () => {
  it.each([
    ['証明書', '証明書.pdf'],
    ['証明書.pdf', '証明書.pdf'],
    ['証明書.PDF', '証明書.PDF'],
    ['', '既定.pdf'],
    ['   ', '既定.pdf'],
  ])('%s → %s', (given, expected) => {
    expect(ensurePdfExtension(given, '既定.pdf')).toBe(expected);
  });
});

describe('canOverwrite / confirmSaveMessage', () => {
  it('上書きできるのは Drive 上のファイルを読み込んだときだけ', () => {
    expect(canOverwrite({ id: 'f1', name: 'a.pdf' })).toBe(true);
    // アップロードした PDF には Drive のファイル ID が無い。
    expect(canOverwrite({ id: '', name: 'a.pdf' })).toBe(false);
    expect(canOverwrite(null)).toBe(false);
  });

  it('上書きの確認文は対象と版履歴に触れる', () => {
    const message = confirmSaveMessage('overwrite', 'new.pdf', {
      id: 'f1',
      name: '既存の証明書.pdf',
    });

    expect(message).toContain('既存の証明書.pdf');
    expect(message).toContain('版履歴');
  });

  it('新規保存の確認文はファイル名を示す', () => {
    expect(confirmSaveMessage('new', '証明書.pdf', null)).toContain('証明書.pdf');
  });
});
