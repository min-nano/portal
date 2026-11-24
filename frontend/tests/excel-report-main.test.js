// @vitest-environment jsdom
//
// 傾斜測定 報告フォーム（excel-report-formatter/main.js）の部屋の入力欄。
//
// 部屋は折り畳まず、「部屋 1」のような見出しも置かない（階数・部屋名・削除の
// 1 行だけ）。番号が画面に無いので、階数・部屋名の入力漏れは、空の欄へ
// フォーカスを送り、上から何番目の部屋かで知らせる。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ prepare: null, apiPostForBlob: null }));

vi.mock('../src/page-start.js', () => ({
  startPage: ({ prepare }) => {
    mocks.prepare = prepare;
  },
}));
vi.mock('../src/api.js', () => ({
  apiGet: async (path) =>
    path.endsWith('/config')
      ? { measurement_groups: [], validation: {}, max_rooms: 3 }
      : { configured: true, fileName: '雛形' },
  apiPostForBlob: (...args) => mocks.apiPostForBlob(...args),
  apiSendJson: vi.fn(),
}));
vi.mock('../src/drive-picker.js', () => ({ pickFile: vi.fn() }));
vi.mock('../src/template-preview.js', () => ({ connectTemplatePreview: vi.fn() }));

async function openForm() {
  vi.resetModules();
  document.body.innerHTML = readFileSync(
    resolve('src/excel-report-formatter/page.html'),
    'utf8'
  );
  await import('../src/components/index.js');
  await import('../src/excel-report-formatter/main.js');
  await mocks.prepare();
}

function rooms() {
  return Array.from(document.querySelectorAll('#rooms .room'));
}

beforeEach(async () => {
  mocks.apiPostForBlob = vi.fn(async () => ({ blob: new Blob(), fileName: '報告書.xlsx' }));
  await openForm();
});

afterEach(() => {
  delete URL.createObjectURL; // jsdom には無いので、足したものを外す。
});

describe('部屋の入力欄', () => {
  it('折り畳まず、一括開閉のボタンも部屋の番号の見出しも置かない', () => {
    expect(document.querySelector('portal-section, portal-section-controls')).toBeNull();
    const [room] = rooms();
    expect(room.querySelector('h3')).toBeNull();
    expect(room.querySelector('.room-head').textContent).not.toContain('部屋 1');
  });

  it('階数・部屋名が空なら、その欄へフォーカスを送り、上から何番目の部屋かを示す', () => {
    document.getElementById('addRoomBtn').click();
    const [first, second] = rooms();
    first.querySelector('[data-room-field="room_name"]').value = 'LDK';

    document.getElementById('submitBtn').click();

    const empty = second.querySelector('[data-room-field="room_name"]');
    expect(document.activeElement).toBe(empty);
    expect(document.getElementById('message').innerText).toBe(
      '上から 2 つ目の部屋の階数と部屋名を入力してください。'
    );
    expect(document.getElementById('submitBtn').disabled).toBe(false);
  });

  it('削除ボタンで部屋を外せる', () => {
    document.getElementById('addRoomBtn').click();
    rooms()[0].querySelector('.remove').click();
    expect(rooms()).toHaveLength(1);
  });

  it('階数・部屋名がそろっていれば、そのまま出力へ進む', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:report');
    rooms()[0].querySelector('[data-room-field="room_name"]').value = 'LDK';

    document.getElementById('submitBtn').click();
    await vi.waitFor(() =>
      expect(document.getElementById('message').innerText).toBe('ダウンロードが完了しました。')
    );

    expect(mocks.apiPostForBlob.mock.calls[0][1].rooms).toEqual([
      { floor: '1', room_name: 'LDK', measurements: {} },
    ]);
  });
});
