// @vitest-environment jsdom
//
// フォームの組み立てと DOM ↔ データの往復。項目定義（/config の応答）から
// 画面が正しく作られ、入力した内容がそのまま取り出せることを確認する。

import { beforeEach, describe, expect, it } from 'vitest';
import { setSectionsOpen } from '../src/components/collapsible-section.js';
import {
  applyFormData,
  buildForm,
  collectFormData,
  revealMissingFields,
  syncFieldsFromPicker,
} from '../src/structural-cert-formatter/form-dom.js';

const config = {
  text_fields: [
    { key: 'era_year', label: '年号・年', required: true, unit: '', hint: '例: 令和7' },
    { key: 'month', label: '月', required: true, unit: '月', hint: '' },
    { key: 'day', label: '日', required: true, unit: '日', hint: '' },
    { key: 'building_area', label: '建築面積', required: true, unit: 'm²', hint: '' },
    { key: 'other_calc_type', label: 'その他の構造計算の種類', required: true, unit: '', hint: '' },
    { key: 'program_name', label: 'プログラムの名称', required: false, unit: '', hint: '' },
    {
      key: 'program_cert_number',
      label: 'プログラムの認定番号',
      required: true,
      unit: '',
      hint: '',
    },
    { key: 'remarks', label: '備考', required: false, unit: '', hint: '' },
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
      label: '国土交通大臣の認定',
      required: true,
      depends_on_field: 'program_name',
      options: [
        { value: '有', label: '有', requires_field: 'program_cert_number' },
        { value: '無', label: '無', requires_field: '' },
      ],
    },
  ],
  sections: [
    {
      title: '証明日',
      items: [
        { date: { label: '証明日', era_year: 'era_year', month: 'month', day: 'day' } },
      ],
    },
    { title: '建築物', items: [{ field: 'building_area' }] },
    {
      title: '構造計算の種類',
      items: [{ choice: 'calc_type' }, { field: 'other_calc_type' }],
    },
    {
      title: '当該構造計算に用いたプログラム',
      items: [
        { field: 'program_name' },
        { choice: 'program_certified' },
        { field: 'program_cert_number' },
      ],
    },
    { title: '備考', items: [{ field: 'remarks' }] },
  ],
};

// 必須でない選択肢（「（指定しない）」に戻せるグループ）だけの定義。
const optionalGroupConfig = {
  text_fields: [],
  choice_groups: [
    {
      key: 'program_certified',
      label: '国土交通大臣の認定',
      required: false,
      options: [
        { value: '有', label: '有', requires_field: '' },
        { value: '無', label: '無', requires_field: '' },
      ],
    },
  ],
  sections: [
    { title: '当該構造計算に用いたプログラム', items: [{ choice: 'program_certified' }] },
  ],
};

let root;

beforeEach(() => {
  document.body.innerHTML = '<div id="sections"></div>';
  root = document.getElementById('sections');
  buildForm(root, config);
});

/** 日付ピッカーを操作したときと同じ状態にする。 */
function setDate(node, iso) {
  node.querySelector('[data-date-picker]').value = iso;
  syncFieldsFromPicker(node);
}

describe('buildForm', () => {
  it('sections の並びどおりにセクションを作る', () => {
    const titles = [...root.querySelectorAll('.cert-section h3')].map((h) => h.textContent);

    // 必須の項目をひとつだけ持つセクションは、見出しが * を引き受ける。
    expect(titles).toEqual([
      '証明日 *',
      '建築物',
      '構造計算の種類 *',
      '当該構造計算に用いたプログラム',
      '備考',
    ]);
  });

  it('セクションは折り畳めるようにし、見出しを開閉の行に出す', () => {
    const sections = [...root.querySelectorAll('.cert-section')];

    expect(sections.every((node) => node.tagName.toLowerCase() === 'portal-section')).toBe(
      true
    );
    // 見出しは light DOM のまま（aria-labelledby が届く位置に置く）。
    expect(sections[0].querySelector('h3').slot).toBe('title');
    // 既定はすべて開いた状態。
    expect(sections.every((node) => node.open)).toBe(true);
  });

  it('未入力の必須項目がある節は、折り畳んでいても開く', () => {
    setSectionsOpen(root, false);
    // 「建築面積」だけ入れて、証明日・構造計算の種類は空のままにする。
    root.querySelector('#field-building_area').value = '120.5';

    revealMissingFields(root);

    const sectionOf = (selector) => root.querySelector(selector).closest('.cert-section');
    expect(sectionOf('[data-date-picker]').open).toBe(true); // 証明日（必須）
    expect(sectionOf('[data-choice="calc_type"]').open).toBe(true); // 選択が必須
    expect(sectionOf('#field-building_area').open).toBe(false); // 入力済み
    expect(sectionOf('#field-remarks').open).toBe(false); // 必須ではない
    // 前提が外れている項目（プログラムの認定番号）は入力漏れに数えない。
    expect(sectionOf('#field-program_cert_number').open).toBe(false);
  });

  it('見出しと同じ名前の記入欄は、名前を重ねない', () => {
    const input = root.querySelector('#field-remarks');

    expect(root.querySelector('label[for="field-remarks"]')).toBeNull();
    // 名前は見出しが担う（読み上げでも同じ結び付きになる）。
    expect(input.getAttribute('aria-labelledby')).toBe(
      input.closest('.cert-section').querySelector('h3').id
    );
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
    expect(root.querySelector('#field-building_area').inputMode).toBe('decimal');
    // 自由入力の欄は通常のキーボード。
    expect(root.querySelector('#field-other_calc_type').inputMode).toBe('');
  });

  it('入力欄は文字列のまま扱う（数値入力欄にしない）', () => {
    root.querySelectorAll('[data-field]').forEach((input) => {
      // 証明日の 3 欄は日付ピッカーが埋めるので隠し入力。
      expect(['text', 'hidden']).toContain(input.type);
    });
  });

  it('選択肢は証明書と同じ番号付きで並べる', () => {
    const labels = [...root.querySelectorAll('[name="choice-calc_type"]')].map(
      (radio) => radio.parentElement.textContent
    );

    expect(labels).toEqual(['1　令第81条第1項', '6　その他']);
  });

  it('必須でないグループには「指定しない」を足し、既定で選んでおく', () => {
    buildForm(root, optionalGroupConfig);
    const radios = [...root.querySelectorAll('[name="choice-program_certified"]')];

    expect(radios.map((r) => r.value)).toEqual(['', '有', '無']);
    expect(radios[0].checked).toBe(true);
  });

  it('値そのものが表示名の選択肢は、番号を前置きせずそのまま出す', () => {
    const labels = [...root.querySelectorAll('[name="choice-program_certified"]')].map(
      (radio) => radio.parentElement.textContent
    );

    // 「有　有」のように重複させない。
    expect(labels).toEqual(['有', '無']);
  });

  it('必須のグループは既定で未選択', () => {
    const radios = [...root.querySelectorAll('[name="choice-calc_type"]')];

    expect(radios.some((r) => r.checked)).toBe(false);
  });

  it('見出しと同じ名前の選択肢は、名前も囲みも重ねない', () => {
    const group = root.querySelector('[name="choice-calc_type"]').closest('fieldset');

    // 見出し「構造計算の種類 *」と同じ文言の legend は出さない。
    expect(group.querySelector('legend')).toBeNull();
    // 囲みも二重にしない。
    expect(group.classList.contains('bare')).toBe(true);
    // 名前は見出しが担う（読み上げでも同じ結び付きになる）。
    expect(group.getAttribute('aria-labelledby')).toBe(
      group.closest('.cert-section').querySelector('h3').id
    );
  });

  it('見出しと別の名前を持つ選択肢は、名前を出して囲む', () => {
    const group = root
      .querySelector('[name="choice-program_certified"]')
      .closest('fieldset');

    expect(group.querySelector('legend').textContent).toBe('国土交通大臣の認定 *');
    expect(group.classList.contains('bare')).toBe(false);
  });

  it('作り直しても項目が重複しない', () => {
    buildForm(root, config);

    expect(root.querySelectorAll('#field-building_area').length).toBe(1);
    expect(root.querySelectorAll('[data-date-picker]').length).toBe(1);
  });
});

describe('証明日（日付ピッカー）', () => {
  it('日付ピッカーひとつで、和暦の 3 欄は隠し入力になる', () => {
    const picker = root.querySelector('[data-date-picker]');

    expect(picker.type).toBe('date');
    // 見出しが「証明日 *」なので、同じ文言のラベルは重ねて出さない。
    expect(root.querySelector('label[for="certDate"]')).toBeNull();
    expect(picker.getAttribute('aria-labelledby')).toBe(
      root.querySelector('.cert-section h3').id
    );
    ['era_year', 'month', 'day'].forEach((key) => {
      expect(root.querySelector(`[data-field="${key}"]`).type).toBe('hidden');
    });
  });

  it('選んだ日付を和暦に直して 3 欄へ入れる', () => {
    setDate(root, '2026-08-10');

    const fields = collectFormData(root, config).fields;
    expect(fields).toMatchObject({ era_year: '令和 8', month: '8', day: '10' });
  });

  it('証明書に印字される日付を確認欄に出す', () => {
    setDate(root, '2026-08-10');

    expect(root.querySelector('[data-date-preview]').textContent).toContain(
      '令和 8年8月10日'
    );
  });

  it('読み込んだ和暦から日付ピッカーの表示を復元する', () => {
    applyFormData(root, {
      fields: { era_year: '令和7', month: '8', day: '10' },
      choices: {},
    });

    expect(root.querySelector('[data-date-picker]').value).toBe('2025-08-10');
    // 区切りの無い表記で読み込んでも、保存時はこのツールの表記に揃える。
    expect(collectFormData(root, config).fields.era_year).toBe('令和 7');
  });

  it('和暦として読めない日付でも、元の値は失われない', () => {
    // 他所で作られた PDF から、想定外の表記が読み込まれた場合。
    applyFormData(root, {
      fields: { era_year: '不明', month: '8', day: '10' },
      choices: {},
    });

    // ピッカーは空のままだが、保存すれば元の値がそのまま出る。
    expect(root.querySelector('[data-date-picker]').value).toBe('');
    expect(collectFormData(root, config).fields.era_year).toBe('不明');
    // 何が印字されるのかは確認欄で分かる。
    expect(root.querySelector('[data-date-preview]').textContent).toContain(
      '不明年8月10日'
    );
  });

  it('日付が未入力なら確認欄で促す', () => {
    applyFormData(root, { fields: {}, choices: {} });

    expect(root.querySelector('[data-date-preview]').textContent).toBe(
      '日付を選択してください。'
    );
  });
});

describe('項目どうしの前提条件', () => {
  /** 利用者が選択肢を選んだときと同じ状態にする。 */
  function check(selector) {
    const radio = root.querySelector(selector);
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** 利用者が記入欄へ打ち込んだときと同じ状態にする。 */
  function type(selector, value) {
    const input = root.querySelector(selector);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  const choose = (value) => check(`[name="choice-calc_type"][value="${value}"]`);

  it('その選択肢を選ぶまでは入力できない', () => {
    const input = root.querySelector('#field-other_calc_type');

    expect(input.disabled).toBe(true);
    expect(input.closest('.cert-field').classList.contains('disabled')).toBe(true);
    // いつ入力できるようになるのかを画面にも書いておく。
    expect(input.closest('.cert-field').querySelector('.hint').textContent).toBe(
      '「6　その他」を選んだときに入力できます。'
    );
  });

  it('紐づかない記入欄はいつでも入力できる', () => {
    expect(root.querySelector('#field-building_area').disabled).toBe(false);
    expect(root.querySelector('#field-remarks').disabled).toBe(false);
  });

  it('その選択肢を選ぶと入力できるようになる', () => {
    choose('6');

    const input = root.querySelector('#field-other_calc_type');
    expect(input.disabled).toBe(false);
    expect(input.closest('.cert-field').classList.contains('disabled')).toBe(false);
  });

  it('別の選択肢へ移すと、入力した内容は残さない', () => {
    choose('6');
    root.querySelector('#field-other_calc_type').value = '限界耐力計算';

    choose('1');

    // 証明書に載らない内容なので、画面にも残さない（バックエンドも空にする）。
    expect(root.querySelector('#field-other_calc_type').value).toBe('');
    expect(collectFormData(root, config).fields.other_calc_type).toBe('');
  });

  it('前提となる欄が空のうちは、その選択肢を選べない', () => {
    const group = root.querySelector('[name="choice-program_certified"]').closest('fieldset');

    expect([...group.querySelectorAll('[data-choice]')].every((r) => r.disabled)).toBe(true);
    expect(group.classList.contains('disabled')).toBe(true);
    // いつ選べるようになるのかを画面にも書いておく。
    expect(group.querySelector('.hint').textContent).toBe(
      '「プログラムの名称」を入力したときに選べます。'
    );
  });

  it('前提となる欄を入力すると選べるようになる', () => {
    type('#field-program_name', 'サンプル構造計算');

    const group = root.querySelector('[name="choice-program_certified"]').closest('fieldset');
    expect([...group.querySelectorAll('[data-choice]')].some((r) => r.disabled)).toBe(false);
    expect(group.classList.contains('disabled')).toBe(false);
  });

  it('前提が連鎖する（名称 → 認定の有無 → 認定番号）', () => {
    type('#field-program_name', 'サンプル構造計算');
    check('[name="choice-program_certified"][value="有"]');
    expect(root.querySelector('#field-program_cert_number').disabled).toBe(false);

    root.querySelector('#field-program_cert_number').value = 'TPRG-1234';
    // 名称を消すと、認定の有無も認定番号もまとめて外れる。
    type('#field-program_name', '');

    const data = collectFormData(root, config);
    expect(data.choices.program_certified).toBe('');
    expect(data.fields.program_cert_number).toBe('');
    expect(root.querySelector('#field-program_cert_number').disabled).toBe(true);
  });

  it('認定が「無」なら認定番号は入力できない', () => {
    type('#field-program_name', 'サンプル構造計算');
    check('[name="choice-program_certified"][value="無"]');

    expect(root.querySelector('#field-program_cert_number').disabled).toBe(true);
  });

  it('読み込んだ内容の選択に合わせて、入力の可否も決め直す', () => {
    applyFormData(root, {
      fields: { other_calc_type: '限界耐力計算' },
      choices: { calc_type: '6' },
    });
    expect(root.querySelector('#field-other_calc_type').disabled).toBe(false);

    applyFormData(root, {
      fields: { other_calc_type: '限界耐力計算' },
      choices: { calc_type: '1' },
    });

    const input = root.querySelector('#field-other_calc_type');
    expect(input.disabled).toBe(true);
    expect(input.value).toBe('');
  });
});

describe('collectFormData / applyFormData', () => {
  it('入力した内容をそのまま取り出せる', () => {
    setDate(root, '2025-08-10');
    root.querySelector('#field-building_area').value = '62.10';
    root.querySelector('[name="choice-calc_type"][value="6"]').checked = true;
    root.querySelector('[name="choice-program_certified"][value="無"]').checked = true;

    const data = collectFormData(root, config);

    expect(data.fields.era_year).toBe('令和 7');
    expect(data.fields.month).toBe('8');
    expect(data.fields.day).toBe('10');
    expect(data.fields.building_area).toBe('62.10');
    expect(data.choices).toEqual({ calc_type: '6', program_certified: '無' });
  });

  it('前後の空白は落とす', () => {
    root.querySelector('#field-building_area').value = '  62.10  ';

    expect(collectFormData(root, config).fields.building_area).toBe('62.10');
  });

  it('流し込んだ内容を取り出すと元に戻る（読み込み → 編集の往復）', () => {
    const loaded = {
      fields: {
        era_year: '令和 7',
        month: '8',
        day: '10',
        building_area: '62.10',
        other_calc_type: '限界耐力計算',
        program_name: 'サンプル構造計算',
        program_cert_number: 'TPRG-1234',
        remarks: '特記事項なし',
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
  });

  it('必須でないグループへ未選択を流し込むと「指定しない」に戻る', () => {
    buildForm(root, optionalGroupConfig);
    root.querySelector('[name="choice-program_certified"][value="有"]').checked = true;

    applyFormData(root, { fields: {}, choices: { program_certified: '' } });

    expect(root.querySelector('[name="choice-program_certified"][value=""]').checked).toBe(
      true
    );
  });
});
