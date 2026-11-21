// @vitest-environment jsdom
//
// 現況検査レポート作成ツール: 写真から読んだ部屋を確かめるダイアログ
// （room-dialog.js）。一覧の出し方・直し方と、確定・キャンセルの返し方。

import { beforeEach, describe, expect, it } from 'vitest';
import { confirmRooms, validateRooms } from '../src/excel-report-formatter/room-dialog.js';

// jsdom の <dialog> には showModal / close が無い。開閉の印だけを真似る。
HTMLDialogElement.prototype.showModal = function showModal() {
  this.open = true;
};
HTMLDialogElement.prototype.close = function close() {
  this.open = false;
};

const rows = () =>
  [...document.querySelectorAll('.room-reading-row')].map((row) => [
    row.querySelector('.room-reading-floor').value,
    row.querySelector('.room-reading-name').value,
  ]);
const click = (id) => document.getElementById(id).click();
const message = () => document.getElementById('roomReadingMessage').textContent;

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('validateRooms', () => {
  it('前後の空白を外し、階も室名も無い行は外す', () => {
    expect(
      validateRooms(
        [
          { floor: ' 1 ', name: ' LDK ' },
          { floor: '', name: ' ' },
          { floor: '2', name: '洋室' },
        ],
        2
      )
    ).toEqual({
      rooms: [
        { floor: '1', name: 'LDK' },
        { floor: '2', name: '洋室' },
      ],
    });
  });

  it('階か室名の片方だけの行があれば、その行を知らせる', () => {
    expect(validateRooms([{ floor: '1', name: 'LDK' }, { floor: '', name: '和室' }], 5)).toEqual({
      error: '2 行目の階と室名を入れてください。',
    });
    expect(validateRooms([{ floor: '1', name: '' }], 5).error).toBe('1 行目の階と室名を入れてください。');
  });

  it('部屋が無い・入れられる数を超えるときは確定できない', () => {
    expect(validateRooms([], 5).error).toBe('部屋がありません。「＋ 部屋を追加」で足してください。');
    expect(
      validateRooms(
        [
          { floor: '1', name: 'A' },
          { floor: '1', name: 'B' },
          { floor: '1', name: 'C' },
        ],
        1
      ).error
    ).toBe('フォームに入れられる部屋はあと 1 までです（雛形の上限）。2 部屋を削除してください。');
  });
});

describe('confirmRooms', () => {
  const read = [
    { floor: '1', name: 'LDK' },
    { floor: '2', name: '洋室' },
  ];

  it('読んだ部屋を一覧に出し、直したものを確定で返す', async () => {
    const result = confirmRooms(read, 8);
    const dialog = document.getElementById('roomReadingDialog');
    expect(dialog.open).toBe(true);
    expect(rows()).toEqual([
      ['1', 'LDK'],
      ['2', '洋室'],
    ]);
    expect(document.getElementById('roomReadingOkBtn').autofocus).toBe(true);

    // 1 行目を消し、行を足す（階は最後の行を引き継ぎ、室名の欄に焦点が来る）。
    document.querySelector('.room-reading-remove').click();
    click('roomReadingAddBtn');
    expect(rows()).toEqual([
      ['2', '洋室'],
      ['2', ''],
    ]);
    expect(document.activeElement).toBe(document.querySelectorAll('.room-reading-name')[1]);

    // 室名が空のまま確定しようとすると、理由を出して閉じない。
    document.querySelectorAll('.room-reading-floor')[1].value = '3';
    click('roomReadingOkBtn');
    expect(message()).toBe('2 行目の階と室名を入れてください。');
    expect(dialog.open).toBe(true);

    document.querySelectorAll('.room-reading-name')[1].value = '洗面所';
    click('roomReadingOkBtn');
    await expect(result).resolves.toEqual([
      { floor: '2', name: '洋室' },
      { floor: '3', name: '洗面所' },
    ]);
    expect(dialog.open).toBe(false);
  });

  it('行が無いところへ足すと、階は空', async () => {
    const result = confirmRooms([], 8);
    click('roomReadingAddBtn');
    expect(rows()).toEqual([['', '']]);
    click('roomReadingCancelBtn');
    await expect(result).resolves.toBeNull();
  });

  it('キャンセル・Esc では null を返し、次に開いたときは前の一覧と理由を残さない', async () => {
    const first = confirmRooms(read, 0);
    click('roomReadingOkBtn');
    expect(message()).toContain('あと 0 まで');
    click('roomReadingCancelBtn');
    await expect(first).resolves.toBeNull();

    const second = confirmRooms([{ floor: '1', name: '和室' }], 8);
    expect(document.querySelectorAll('#roomReadingDialog')).toHaveLength(1);
    expect(rows()).toEqual([['1', '和室']]);
    expect(message()).toBe('');
    const escape = new Event('cancel', { cancelable: true });
    document.getElementById('roomReadingDialog').dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    await expect(second).resolves.toBeNull();

    // 閉じたダイアログのボタンは、前の呼び出しにはもうつながっていない。
    const third = confirmRooms(read, 8);
    click('roomReadingOkBtn');
    await expect(third).resolves.toEqual(read);
  });
});
