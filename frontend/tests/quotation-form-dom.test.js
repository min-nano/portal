// @vitest-environment jsdom
//
// 明細の入力欄の組み立てと、DOM ↔ データの往復。
//
// 業務のテンプレートも選択肢も /config が配る定義（＝計算実装が持っている
// 単一の情報源）から作るので、ここで確かめるのは「配られた定義のとおりに
// 画面ができ、入れた内容がそのまま取り出せること」。

import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyForm,
  applySettings,
  readForm,
  readItems,
  readSettings,
  renderItems,
  renderSeismicEstimate,
  renderTotals,
  showOfficeChip,
  syncItems,
} from '../src/quotation-formatter/form-dom.js';

// /config の応答の縮小版。
const config = {
  templates: [
    {
      id: 'structural-design',
      name: '構造設計（構造計算＋構造図）',
      title: '新築木造軸組建築物の構造計算及び構造図作成',
      composition: 'design',
      areaLabel: '構造床面積',
      seismicWork: '',
    },
    {
      id: 'seismic-diagnosis',
      name: '耐震診断',
      title: '木造住宅の耐震診断',
      composition: 'seismic',
      areaLabel: '延べ面積',
      seismicWork: 'diagnosis',
    },
    {
      id: 'other',
      name: 'その他（自由記述）',
      title: '',
      composition: 'free',
      areaLabel: '',
      seismicWork: '',
    },
  ],
  scaleOptions: ['平屋建て', '2階建て'],
  methodOptions: ['仕様規定(壁量計算)', '許容応力度計算(ルート1)'],
  diagnosisMethodOptions: ['一般診断法', '精密診断法'],
  areaModes: [
    { id: 'approx', label: '約〇㎡' },
    { id: 'atMost', label: '〇㎡以下' },
  ],
  taxCategories: [
    { id: 'standard', label: '標準税率' },
    { id: 'exempt', label: '対象外' },
  ],
  roundings: [
    { id: 'floor', label: '切り捨て' },
    { id: 'round', label: '四捨五入' },
  ],
  seismic: { minArea: 75, maxArea: 250 },
  maxItems: 40,
};

// 画面のうち、この層が id で探すところだけを置く。
const PAGE = `
  <span id="officeChip" class="unset">未設定</span>
  <form id="quotationForm">
    <input type="text" id="quoteNumber">
    <input type="date" id="issuedOn">
    <input type="date" id="expiresOn">
    <input type="text" id="subject">
    <input type="text" id="clientName">
    <select id="clientHonorific"><option value="御中">御中</option><option value="様">様</option></select>
    <input type="text" id="clientPostalCode">
    <input type="text" id="clientAddress">
    <input type="text" id="clientDepartment">
    <input type="text" id="clientContactName">
    <select id="clientContactHonorific"><option value="様">様</option></select>
    <input type="text" id="issuerName">
    <input type="text" id="issuerPostalCode">
    <input type="text" id="issuerAddress">
    <input type="text" id="issuerTel">
    <input type="text" id="issuerPersonName">
    <input type="number" id="taxRate">
    <input type="number" id="reducedTaxRate">
    <select id="taxRounding"></select>
    <textarea id="remarks"></textarea>
    <div id="items"></div>
    <div id="quoteTotal"><span class="value">0</span></div>
    <table id="quoteBreakdown"><tbody></tbody></table>
    <ul id="quoteWarnings" hidden></ul>
  </form>
  <dialog id="settingsDialog">
    <input type="text" id="setOfficeName">
    <input type="text" id="setOfficePostalCode">
    <input type="text" id="setOfficeAddress">
    <input type="text" id="setOfficeTel">
    <input type="text" id="setOfficePersonName">
    <textarea id="setTermsDesign"></textarea>
    <textarea id="setTermsSeismic"></textarea>
    <textarea id="setRemarks"></textarea>
    <input type="number" id="setTaxRate">
    <input type="number" id="setReducedTaxRate">
    <select id="setTaxRounding"></select>
    <input type="number" id="setPersonnelUnitPrice">
    <input type="number" id="setTechnicalFeeRate">
    <input type="number" id="setOverheadMultiplier">
  </dialog>
`;

function item(overrides = {}) {
  return {
    key: overrides.key || 'item-1',
    templateId: 'structural-design',
    spec: {
      scale: '',
      areaMode: 'approx',
      floorArea: '',
      method: '',
      diagnosisMethod: '',
      note: '',
      inspectionCost: '',
      specialCost: '',
    },
    title: '',
    body: '',
    unitPrice: '',
    quantity: 1,
    taxCategory: 'standard',
    ...overrides,
  };
}

function block(index) {
  return document.querySelector(`[data-item-index="${index}"]`);
}

function fieldOf(index, path) {
  return block(index).querySelector(`[data-field="${path}"]`);
}

beforeEach(() => {
  document.body.innerHTML = PAGE;
});

describe('renderItems', () => {
  it('明細の数だけ入力欄の塊を作る', () => {
    renderItems(document, [item({ key: 'a' }), item({ key: 'b' })], config);

    expect(document.querySelectorAll('[data-item-index]')).toHaveLength(2);
    expect(block(0).querySelector('h4').textContent).toBe('1 行目');
    expect(block(1).querySelector('h4').textContent).toBe('2 行目');
  });

  it('最後の 1 行は消せない', () => {
    renderItems(document, [item()], config);
    expect(block(0).querySelector('[data-remove-item]').disabled).toBe(true);

    renderItems(document, [item({ key: 'a' }), item({ key: 'b' })], config);
    expect(block(0).querySelector('[data-remove-item]').disabled).toBe(false);
  });

  it('業務の選択肢は、配られたテンプレートから作る', () => {
    renderItems(document, [item()], config);
    const options = [...fieldOf(0, 'templateId').options];

    expect(options.map((o) => o.value)).toEqual([
      'structural-design',
      'seismic-diagnosis',
      'other',
    ]);
    // 選択肢に出るのはテンプレートの「名前」。
    expect(options.map((o) => o.textContent)).toEqual([
      '構造設計（構造計算＋構造図）',
      '耐震診断',
      'その他（自由記述）',
    ]);
  });

  it('組み立てた欄には、その明細の値が入っている', () => {
    // ここを忘れると、読み込んだ見積書が空の欄で上書きされる
    // （組み立てた直後に readItems が空を読むため）。
    const loaded = item({
      templateId: 'seismic-diagnosis',
      spec: {
        ...item().spec,
        scale: '平屋建て',
        floorArea: 120,
        areaMode: 'atMost',
        diagnosisMethod: '一般診断法',
        note: '提出書類は、耐震診断報告書とします。',
        inspectionCost: 50000,
      },
      title: '木造住宅の耐震診断',
      body: '平屋建て、延べ面積120㎡以下',
      unitPrice: 250000,
      quantity: 2,
      taxCategory: 'exempt',
    });
    renderItems(document, [loaded], config);

    expect(fieldOf(0, 'templateId').value).toBe('seismic-diagnosis');
    expect(fieldOf(0, 'spec.scale').value).toBe('平屋建て');
    expect(fieldOf(0, 'spec.floorArea').value).toBe('120');
    expect(fieldOf(0, 'spec.areaMode').value).toBe('atMost');
    expect(fieldOf(0, 'spec.diagnosisMethod').value).toBe('一般診断法');
    expect(fieldOf(0, 'spec.note').value).toBe('提出書類は、耐震診断報告書とします。');
    expect(fieldOf(0, 'spec.inspectionCost').value).toBe('50000');
    expect(fieldOf(0, 'title').value).toBe('木造住宅の耐震診断');
    expect(fieldOf(0, 'unitPrice').value).toBe('250000');
    expect(fieldOf(0, 'quantity').value).toBe('2');
    expect(fieldOf(0, 'taxCategory').value).toBe('exempt');

    // 組み立てた直後に読み戻しても、内容が失われない。
    const [round] = readItems(document, [loaded]);
    expect(round.unitPrice).toBe('250000');
    expect(round.spec.floorArea).toBe('120');
    expect(round.title).toBe('木造住宅の耐震診断');
  });

  it('面積の見出しは業務によって変わる', () => {
    renderItems(document, [item()], config);
    expect(block(0).querySelector('label[for="itemArea0"]').textContent).toBe(
      '構造床面積 [㎡]'
    );

    renderItems(document, [item({ templateId: 'seismic-diagnosis' })], config);
    expect(block(0).querySelector('label[for="itemArea0"]').textContent).toBe(
      '延べ面積 [㎡]'
    );
  });

  it('設計の業務には設計方法を、耐震には診断法を出す', () => {
    renderItems(document, [item()], config);
    expect(fieldOf(0, 'spec.method')).not.toBeNull();
    expect(fieldOf(0, 'spec.diagnosisMethod')).toBeNull();

    renderItems(document, [item({ templateId: 'seismic-diagnosis' })], config);
    expect(fieldOf(0, 'spec.method')).toBeNull();
    expect(fieldOf(0, 'spec.diagnosisMethod')).not.toBeNull();
  });

  it('自由記述の業務には、規模も設計方法も出さない', () => {
    renderItems(document, [item({ templateId: 'other' })], config);

    expect(fieldOf(0, 'spec.scale')).toBeNull();
    expect(fieldOf(0, 'spec.floorArea')).toBeNull();
    // 摘要に足す行と、金額の欄は残る。
    expect(fieldOf(0, 'spec.note')).not.toBeNull();
    expect(fieldOf(0, 'unitPrice')).not.toBeNull();
  });

  it('告示第670号の参考額の欄は、耐震の業務にだけ出る', () => {
    renderItems(document, [item()], config);
    expect(document.querySelector('[data-seismic="0"]')).toBeNull();

    renderItems(document, [item({ templateId: 'seismic-diagnosis' })], config);
    const seismic = document.querySelector('[data-seismic="0"]');
    expect(seismic).not.toBeNull();
    // 実費（検査費・特別経費）は告示第670号の費目なので、ここで入れる。
    expect(fieldOf(0, 'spec.inspectionCost')).not.toBeNull();
    expect(fieldOf(0, 'spec.specialCost')).not.toBeNull();
    // 計算するまでは、単価に入れられない。
    expect(seismic.querySelector('[data-apply-fee]').disabled).toBe(true);
  });

  it('候補に並べる語彙は、配られた選択肢から作る', () => {
    renderItems(document, [item()], config);
    const values = [...document.querySelectorAll('#quoteMethodOptions option')].map(
      (o) => o.value
    );

    expect(values).toEqual(['仕様規定(壁量計算)', '許容応力度計算(ルート1)']);
  });
});

describe('readItems', () => {
  it('入力した内容が、そのまま明細として取り出せる', () => {
    renderItems(document, [item({ templateId: 'seismic-diagnosis' })], config);
    fieldOf(0, 'spec.scale').value = '2階建て';
    fieldOf(0, 'spec.floorArea').value = '120';
    fieldOf(0, 'spec.diagnosisMethod').value = '一般診断法';
    fieldOf(0, 'spec.inspectionCost').value = '50000';
    fieldOf(0, 'title').value = '木造住宅の耐震診断';
    fieldOf(0, 'unitPrice').value = '250000';
    fieldOf(0, 'taxCategory').value = 'exempt';

    const [read] = readItems(document, [item({ templateId: 'seismic-diagnosis' })]);

    expect(read.spec.scale).toBe('2階建て');
    expect(read.spec.floorArea).toBe('120');
    expect(read.spec.diagnosisMethod).toBe('一般診断法');
    expect(read.spec.inspectionCost).toBe('50000');
    expect(read.title).toBe('木造住宅の耐震診断');
    expect(read.unitPrice).toBe('250000');
    expect(read.taxCategory).toBe('exempt');
  });

  it('画面に出ていない欄は、元の値のまま残す', () => {
    // 自由記述の業務には設計方法の欄が無いが、値を捨ててしまうと、業務を
    // 戻したときに入れ直しになる。
    const original = item({ templateId: 'other', spec: { ...item().spec, method: '残す' } });
    renderItems(document, [original], config);

    expect(readItems(document, [original])[0].spec.method).toBe('残す');
  });
});

describe('applyForm / readForm', () => {
  it('見積書の内容が入力欄へ写り、そのまま読み戻せる', () => {
    const data = {
      number: '20260099',
      issuedOn: '2026-08-17',
      expiresOn: '2026-09-30',
      subject: '架空邸 構造設計業務',
      client: {
        name: '架空建築設計事務所',
        honorific: '御中',
        postalCode: '999-0001',
        address: '架空県架空市架空町1-2-3',
        department: '設計部',
        contactName: '架空 太郎',
        contactHonorific: '様',
      },
      issuer: {
        name: '架空 二級建築士事務所',
        postalCode: '999-0002',
        address: '架空県架空市架空1766番地6',
        tel: '000-0000-0000',
        personName: '架空 花子',
      },
      items: [item()],
      remarks: '（架空の文例）備考',
      tax: { taxRate: 10, reducedTaxRate: 8, taxRounding: 'floor' },
    };

    applyForm(document, data, config);
    renderItems(document, data.items, config);

    expect(document.getElementById('quoteNumber').value).toBe('20260099');
    expect(document.getElementById('clientName').value).toBe('架空建築設計事務所');
    expect(document.getElementById('issuerTel').value).toBe('000-0000-0000');
    expect(document.getElementById('taxRounding').value).toBe('floor');

    const readBack = readForm(document, JSON.parse(JSON.stringify(data)));
    expect(readBack.number).toBe('20260099');
    expect(readBack.client.contactName).toBe('架空 太郎');
    expect(readBack.remarks).toBe('（架空の文例）備考');
  });
});

describe('syncItems', () => {
  it('計算し直した金額と、追従した品名・摘要を書き戻す', () => {
    const items = [item()];
    renderItems(document, items, config);

    const updated = [{ ...items[0], title: '構造設計', body: '2階建て' }];
    syncItems(document, updated, {
      items: [{ amountText: '284,000' }],
    });

    expect(fieldOf(0, 'title').value).toBe('構造設計');
    expect(fieldOf(0, 'body').value).toBe('2階建て');
    expect(block(0).querySelector('[data-amount]').textContent).toBe('金額: 284,000 円');
  });
});

describe('renderSeismicEstimate', () => {
  beforeEach(() => {
    renderItems(document, [item({ templateId: 'seismic-diagnosis' })], config);
  });

  it('算定できたら費目を並べ、単価に入れられるようにする', () => {
    renderSeismicEstimate(document, 0, {
      applicable: true,
      reason: '',
      amount: 756000,
      amountText: '756,000',
      rows: [
        { label: '標準業務人・時間数', amountText: '45 人・時間', note: '別表第二' },
        { label: '直接人件費', amountText: '360,000', note: '' },
      ],
    });

    const rows = document.querySelectorAll('[data-seismic-rows="0"] tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('.step-value').textContent).toBe('45 人・時間');
    expect(document.querySelector('[data-apply-fee="0"]').disabled).toBe(false);
    expect(document.querySelector('[data-seismic-error="0"]').hidden).toBe(true);
  });

  it('算定できないときは理由を出し、単価には入れさせない', () => {
    renderSeismicEstimate(document, 0, {
      applicable: false,
      reason: '床面積の合計が別表第二の範囲（75㎡〜250㎡）の外です。',
      rows: [],
    });

    const error = document.querySelector('[data-seismic-error="0"]');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain('別表第二');
    expect(document.querySelector('[data-apply-fee="0"]').disabled).toBe(true);
    expect(document.querySelector('[data-seismic-rows="0"]').hidden).toBe(true);
  });
});

describe('renderTotals', () => {
  it('御見積金額と内訳、そして警告を出す', () => {
    renderTotals(document, {
      totals: {
        subtotalText: '284,000',
        taxText: '28,400',
        totalText: '312,400',
        roundingLabel: '切り捨て',
        buckets: [{ category: 'standard', label: '10%対象', baseText: '284,000', taxText: '28,400' }],
      },
      warnings: ['件名が未入力です。'],
    });

    expect(document.querySelector('#quoteTotal .value').textContent).toBe('312,400');
    const labels = [...document.querySelectorAll('#quoteBreakdown .step-label')].map(
      (cell) => cell.textContent
    );
    expect(labels).toEqual(['小計', '消費税', '内訳 10%対象', '　消費税']);

    const warnings = document.getElementById('quoteWarnings');
    expect(warnings.hidden).toBe(false);
    expect(warnings.textContent).toContain('件名が未入力です。');
  });

  it('対象外の区分には、消費税の行を出さない', () => {
    renderTotals(document, {
      totals: {
        totalText: '33,000',
        buckets: [{ category: 'exempt', label: '対象外', baseText: '33,000', taxText: '0' }],
      },
      warnings: [],
    });

    const labels = [...document.querySelectorAll('#quoteBreakdown .step-label')].map(
      (cell) => cell.textContent
    );
    expect(labels).toEqual(['小計', '消費税', '内訳 対象外']);
    expect(document.getElementById('quoteWarnings').hidden).toBe(true);
  });
});

describe('設定', () => {
  it('設定が入力欄へ写り、そのまま読み戻せる', () => {
    const settings = {
      office: { name: '架空 二級建築士事務所', tel: '000-0000-0000' },
      terms: { design: '設計の但し書き', seismic: '耐震の但し書き' },
      remarks: '（架空の文例）備考',
      fee: {
        taxRate: 10,
        reducedTaxRate: 8,
        taxRounding: 'round',
        personnelUnitPrice: 8000,
        technicalFeeRate: 10,
        overheadMultiplier: 1,
      },
    };

    applySettings(document, settings, config);
    expect(document.getElementById('setOfficeName').value).toBe('架空 二級建築士事務所');
    expect(document.getElementById('setTermsSeismic').value).toBe('耐震の但し書き');
    expect(document.getElementById('setTaxRounding').value).toBe('round');

    const read = readSettings(document);
    expect(read.office.name).toBe('架空 二級建築士事務所');
    expect(read.fee.personnelUnitPrice).toBe('8000');
    expect(read.terms.design).toBe('設計の但し書き');
  });

  it('発行元が未設定なら、その旨をタイトル横に出す', () => {
    showOfficeChip(document, { office: { name: '' } });
    expect(document.getElementById('officeChip').textContent).toBe('未設定');
    expect(document.getElementById('officeChip').className).toBe('unset');

    showOfficeChip(document, { office: { name: '架空 二級建築士事務所' } });
    expect(document.getElementById('officeChip').textContent).toBe(
      '架空 二級建築士事務所'
    );
    expect(document.getElementById('officeChip').className).toBe('name');
  });
});
