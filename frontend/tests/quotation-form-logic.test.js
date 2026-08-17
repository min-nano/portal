import { describe, expect, it } from 'vitest';
import {
  applySuggestions,
  canRemoveItem,
  defaultSaveName,
  emptyFormData,
  formSignature,
  issuerHint,
  makeItem,
  mergeFormData,
  seismicWorkOf,
  templateOf,
  toRequestBody,
  todayIsoDate,
  verificationOf,
  verificationWarning,
} from '../src/quotation-formatter/form-logic.js';

// バックエンドの /settings が配る内容の縮小版（すべて架空の値）。
const settings = {
  office: {
    name: '架空 二級建築士事務所',
    postalCode: '999-0002',
    address: '架空県架空市架空1766番地6',
    tel: '000-0000-0000',
    personName: '架空 花子',
  },
  terms: { design: '設計の但し書き', seismic: '耐震の但し書き' },
  remarks: '（架空の文例）備考',
  fee: { taxRate: 10, reducedTaxRate: 8, taxRounding: 'floor' },
};

// /config が配るテンプレートの縮小版（計算実装が持っている定義）。
const templates = [
  { id: 'structural-design', composition: 'design', seismicWork: '' },
  { id: 'seismic-diagnosis', composition: 'seismic', seismicWork: 'diagnosis' },
  {
    id: 'seismic-retrofit-design',
    composition: 'seismic',
    seismicWork: 'retrofit-design',
  },
  { id: 'other', composition: 'free', seismicWork: '' },
];

describe('emptyFormData', () => {
  it('新規作成は明細 1 行から始まり、発行日は当日', () => {
    const data = emptyFormData(settings);

    expect(data.items).toHaveLength(1);
    expect(data.issuedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(data.client.honorific).toBe('御中');
  });

  it('発行元・備考・税の条件は設定から「写す」（参照しない）', () => {
    const data = emptyFormData(settings);

    expect(data.issuer.name).toBe('架空 二級建築士事務所');
    expect(data.remarks).toBe('（架空の文例）備考');
    expect(data.tax).toEqual({ taxRate: 10, reducedTaxRate: 8, taxRounding: 'floor' });

    // 写しなので、あとから設定を変えても作成済みの見積書は変わらない。
    settings.office.name = '別の名前';
    expect(data.issuer.name).toBe('架空 二級建築士事務所');
    settings.office.name = '架空 二級建築士事務所';
  });

  it('設定がまだ無くても、法定の税率で始められる', () => {
    const data = emptyFormData(null);

    expect(data.issuer.name).toBe('');
    expect(data.tax.taxRate).toBe(10);
    expect(data.tax.taxRounding).toBe('floor');
  });
});

describe('todayIsoDate', () => {
  it('端末の日付を YYYY-MM-DD で返す', () => {
    expect(todayIsoDate(new Date(2026, 7, 17))).toBe('2026-08-17');
    expect(todayIsoDate(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('makeItem', () => {
  it('直前の行から、業務・設計方法・税区分を引き継ぐ', () => {
    const previous = {
      templateId: 'seismic-diagnosis',
      taxCategory: 'exempt',
      spec: { method: '仕様規定(壁量計算)', diagnosisMethod: '一般診断法' },
    };
    const item = makeItem(previous);

    expect(item.templateId).toBe('seismic-diagnosis');
    expect(item.taxCategory).toBe('exempt');
    expect(item.spec.diagnosisMethod).toBe('一般診断法');
    // 品名・摘要・単価は引き継がない（別の業務の値が残ると事故になる）。
    expect(item.title).toBe('');
    expect(item.unitPrice).toBe('');
  });

  it('行ごとに違う識別子を持つ（候補の追従に使う）', () => {
    expect(makeItem().key).not.toBe(makeItem().key);
  });
});

describe('applySuggestions', () => {
  const suggestion = (title, body) => ({ title, body });

  it('空欄には候補が入る', () => {
    const items = [{ ...makeItem(), title: '', body: '' }];
    const { items: next, memo } = applySuggestions(items, {}, [
      suggestion('構造設計', '2階建て'),
    ]);

    expect(next[0].title).toBe('構造設計');
    expect(next[0].body).toBe('2階建て');
    expect(memo[items[0].key]).toEqual(suggestion('構造設計', '2階建て'));
  });

  it('直前の候補のままの欄は、新しい候補についてくる', () => {
    const item = { ...makeItem(), title: '構造設計', body: '2階建て' };
    const memo = { [item.key]: suggestion('構造設計', '2階建て') };
    const { items: next } = applySuggestions([item], memo, [
      suggestion('構造設計', '3階建て'),
    ]);

    expect(next[0].body).toBe('3階建て');
  });

  it('手で書き換えた欄は上書きしない', () => {
    const item = { ...makeItem(), title: '構造設計', body: '手で書いた摘要' };
    const memo = { [item.key]: suggestion('構造設計', '2階建て') };
    const { items: next } = applySuggestions([item], memo, [
      suggestion('構造設計', '3階建て'),
    ]);

    expect(next[0].body).toBe('手で書いた摘要');
  });

  it('行を消しても、残った行の追従は崩れない（識別子で覚えているため）', () => {
    const first = { ...makeItem(), title: 'A', body: 'a' };
    const second = { ...makeItem(), title: 'B', body: 'b' };
    const memo = {
      [first.key]: suggestion('A', 'a'),
      [second.key]: suggestion('B', 'b'),
    };
    // 1 行目を消したので、2 行目が先頭に来る。
    const { items: next } = applySuggestions([second], memo, [suggestion('B', 'b2')]);

    expect(next[0].body).toBe('b2');
  });
});

describe('templateOf / seismicWorkOf', () => {
  it('告示第670号の別表の行を名乗るのは、耐震の 2 つだけ', () => {
    expect(seismicWorkOf(templates, 'seismic-diagnosis')).toBe('diagnosis');
    expect(seismicWorkOf(templates, 'seismic-retrofit-design')).toBe('retrofit-design');
    expect(seismicWorkOf(templates, 'structural-design')).toBe('');
    expect(seismicWorkOf(templates, '知らない業務')).toBe('');
  });

  it('テンプレートは id で引ける', () => {
    expect(templateOf(templates, 'other').composition).toBe('free');
    expect(templateOf(templates, '知らない業務')).toBeNull();
  });
});

describe('canRemoveItem', () => {
  it('明細は 1 行以上ある（最後の 1 行は消せない）', () => {
    expect(canRemoveItem({ items: [makeItem()] })).toBe(false);
    expect(canRemoveItem({ items: [makeItem(), makeItem()] })).toBe(true);
  });
});

describe('toRequestBody / formSignature', () => {
  it('画面だけの識別子は、送る内容にも未保存の判定にも入らない', () => {
    const data = emptyFormData(settings);
    const body = toRequestBody(data);

    expect(body.items[0].key).toBeUndefined();
    expect(formSignature(data)).toBe(JSON.stringify(body));
  });

  it('内容が同じなら、識別子が違っても「保存済み」のまま', () => {
    const a = emptyFormData(settings);
    const b = emptyFormData(settings);

    expect(a.items[0].key).not.toBe(b.items[0].key);
    expect(formSignature(a)).toBe(formSignature(b));
  });
});

describe('mergeFormData', () => {
  it('読み込んだ見積書に、画面だけの識別子を振り直す', () => {
    const parsed = {
      data: {
        number: '20260099',
        issuedOn: '2026-08-17',
        items: [{ templateId: 'seismic-diagnosis', title: '木造住宅の耐震診断' }],
      },
    };
    const data = mergeFormData(parsed);

    expect(data.number).toBe('20260099');
    expect(data.items[0].key).toBeTruthy();
    expect(data.items[0].title).toBe('木造住宅の耐震診断');
    // 欠けている欄は、新規作成と同じ既定で埋める。
    expect(data.items[0].spec.areaMode).toBe('approx');
  });

  it('明細が空の見積書でも、1 行ある状態にして開く', () => {
    expect(mergeFormData({ data: { items: [] } }).items).toHaveLength(1);
  });
});

describe('defaultSaveName', () => {
  it('組み立てるのは計算実装（画面はその文字列を使うだけ）', () => {
    const computed = { defaultFileName: '20260817_架空建築設計事務所_312400.pdf' };

    expect(defaultSaveName(computed, '')).toBe('20260817_架空建築設計事務所_312400.pdf');
    // 開いているファイルがあれば、その名前が優先される。
    expect(defaultSaveName(computed, '既存.pdf')).toBe('既存.pdf');
    expect(defaultSaveName(null, '')).toBe('見積書.pdf');
  });
});

describe('verificationOf / verificationWarning', () => {
  it('サーバへ渡すのは、画面が出した金額と計算実装の版', () => {
    const claim = verificationOf('2.2.0', {
      totals: { subtotal: 284000, tax: 28400, total: 312400 },
    });

    expect(claim).toEqual({
      coreVersion: '2.2.0',
      totals: { subtotal: 284000, tax: 28400, total: 312400 },
    });
  });

  it('合っていれば、警告は出さない', () => {
    expect(verificationWarning({ checked: true, ok: true })).toBe('');
    expect(verificationWarning({ checked: false })).toBe('');
    expect(verificationWarning(null)).toBe('');
  });

  it('金額が食い違えば、どの項目がどう違うのかを出す', () => {
    const warning = verificationWarning({
      checked: true,
      ok: false,
      coreVersion: { client: '2.2.0', server: '2.2.0' },
      differences: [{ key: 'total', label: '合計', client: 1, server: 312400 }],
    });

    expect(warning).toContain('合計');
    expect(warning).toContain('312400');
  });

  it('計算実装の版が違えば、再読み込みを促す', () => {
    const warning = verificationWarning({
      checked: true,
      ok: false,
      coreVersion: { client: '2.1.0', server: '2.2.0' },
      differences: [],
    });

    expect(warning).toContain('再読み込み');
  });
});

describe('issuerHint', () => {
  it('発行元が入っていないときだけ案内を出す', () => {
    expect(issuerHint(emptyFormData(settings))).toBe('');
    expect(issuerHint(emptyFormData(null))).toContain('設定');
  });
});
