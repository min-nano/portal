import { describe, expect, it } from 'vitest';
import {
  canOverwrite,
  confirmSaveMessage,
  dateFieldsFromIso,
  emptyFormData,
  ensurePdfExtension,
  formSignature,
  formatCertificateDate,
  isoFromDateFields,
  mergeFormData,
  sanitizeFileName,
  saveHintMessage,
  saveModeFor,
  suggestedFileName,
  unsavedPromptMessage,
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

describe('dateFieldsFromIso', () => {
  it.each([
    // 元号と年数の間は半角スペースで区切る。
    ['2026-08-10', { era_year: '令和 8', month: '8', day: '10' }],
    ['2044-01-01', { era_year: '令和 26', month: '1', day: '1' }],
    // 改元の当日と前日。
    ['2019-05-01', { era_year: '令和 元', month: '5', day: '1' }],
    ['2019-04-30', { era_year: '平成 31', month: '4', day: '30' }],
    ['1989-01-08', { era_year: '平成 元', month: '1', day: '8' }],
    ['1989-01-07', { era_year: '昭和 64', month: '1', day: '7' }],
  ])('%s → 和暦', (iso, expected) => {
    expect(dateFieldsFromIso(iso)).toEqual(expected);
  });

  it.each(['', '2026-08', '2026/08/10', '2026-02-30', '2026-13-01', null])(
    '日付として成立しない %s は null',
    (iso) => {
      expect(dateFieldsFromIso(iso)).toBeNull();
    }
  );
});

describe('isoFromDateFields', () => {
  it.each([
    [{ era_year: '令和 8', month: '8', day: '10' }, '2026-08-10'],
    // 区切りが無い書き方も読める（他所で作られた PDF 対策）。
    [{ era_year: '令和8', month: '8', day: '10' }, '2026-08-10'],
    [{ era_year: '令和元', month: '5', day: '1' }, '2019-05-01'],
    [{ era_year: '令和1', month: '5', day: '1' }, '2019-05-01'],
    [{ era_year: '平成31', month: '4', day: '30' }, '2019-04-30'],
    [{ era_year: '昭和64', month: '1', day: '7' }, '1989-01-07'],
    // 全角で入っていても読める（携帯の日本語入力対策）。
    [{ era_year: '令和８', month: '８', day: '１０' }, '2026-08-10'],
    // 年号なしは西暦とみなす。
    [{ era_year: '2026', month: '8', day: '10' }, '2026-08-10'],
  ])('%o → %s', (fields, expected) => {
    expect(isoFromDateFields(fields)).toBe(expected);
  });

  it.each([
    {},
    { era_year: '', month: '8', day: '10' },
    { era_year: '令和8', month: '', day: '10' },
    { era_year: '令和8', month: '2', day: '30' },
    { era_year: '不明8', month: '8', day: '10' },
    // 年号なしで西暦にしては小さすぎる値は、取り違えを避けて戻さない。
    { era_year: '8', month: '8', day: '10' },
  ])('戻せない %o は空文字', (fields) => {
    expect(isoFromDateFields(fields)).toBe('');
  });

  it('日付ピッカーとの往復で値が変わらない', () => {
    for (const iso of ['2026-08-10', '2019-05-01', '2000-12-31']) {
      expect(isoFromDateFields(dateFieldsFromIso(iso))).toBe(iso);
    }
  });
});

describe('formatCertificateDate', () => {
  it('証明書に刷られる形で組み立てる', () => {
    expect(formatCertificateDate({ era_year: '令和 8', month: '8', day: '10' })).toBe(
      '令和 8年8月10日'
    );
  });

  it('欠けている項目があれば空文字', () => {
    expect(formatCertificateDate({ era_year: '令和 8', month: '', day: '10' })).toBe('');
    expect(formatCertificateDate({})).toBe('');
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

describe('saveModeFor / saveHintMessage', () => {
  it('編集中のファイルがあれば「保存」はそこへの上書きになる', () => {
    expect(saveModeFor({ id: 'f1', name: 'a.pdf' })).toBe('overwrite');
  });

  it('新規作成・アップロードした PDF は保存先をそのつど選ぶ', () => {
    expect(saveModeFor(null)).toBe('new');
    expect(saveModeFor({ id: '', name: 'a.pdf' })).toBe('new');
  });

  it('案内文は「保存」を押したときに起きることを書く', () => {
    expect(saveHintMessage({ id: 'f1', name: '既存の証明書.pdf' })).toContain(
      '既存の証明書.pdf'
    );
    expect(saveHintMessage(null)).toContain('フォルダ');
  });
});

describe('formSignature', () => {
  const data = { fields: { a: '1' }, choices: { b: '2' } };

  it('同じ内容なら同じ指紋になる', () => {
    expect(formSignature(data, 'x.pdf')).toBe(
      formSignature({ fields: { a: '1' }, choices: { b: '2' } }, 'x.pdf')
    );
  });

  it('入力が変われば指紋も変わる', () => {
    expect(formSignature({ ...data, fields: { a: '9' } }, 'x.pdf')).not.toBe(
      formSignature(data, 'x.pdf')
    );
    expect(formSignature({ ...data, choices: { b: '9' } }, 'x.pdf')).not.toBe(
      formSignature(data, 'x.pdf')
    );
  });

  it('ファイル名も保存すれば残る内容なので指紋に含める', () => {
    expect(formSignature(data, 'y.pdf')).not.toBe(formSignature(data, 'x.pdf'));
  });
});

describe('unsavedPromptMessage', () => {
  it('編集中のファイルがあれば、その名前で尋ねる', () => {
    const message = unsavedPromptMessage({ id: 'f1', name: '既存の証明書.pdf' }, '新規作成');

    expect(message).toContain('既存の証明書.pdf');
    expect(message).toContain('新規作成');
  });

  it('新規作成中なら入力内容として尋ねる', () => {
    expect(unsavedPromptMessage(null, '読み込み')).toContain('入力した内容');
  });
});
