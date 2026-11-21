// 写真から読んだ文字（../paddle-ocr/）を、フォームに入れる値にする（DOM 非依存）。
//
//   - データシート（検査の申込の控え）からは「物件名」の欄の値
//   - 間取り図からは、部屋（居室）の名前とその階
//
// 読んだ文字は { text, x0, y0, x1, y1 }（写真の画素の座標）の並び。どの写真が
// どちらの資料かは問わず、1 枚ずつ両方を探す。

/** 比べやすい形にする（全角の英数字・括弧を半角に、空白を外す）。 */
export function normalize(text) {
  return text.normalize('NFKC').replace(/\s+/g, '');
}

const centerX = (item) => (item.x0 + item.x1) / 2;
const centerY = (item) => (item.y0 + item.y1) / 2;
const heightOf = (item) => item.y1 - item.y0;

// --- データシート ------------------------------------------------------------

/**
 * 見出し「物件名」のかたまり。後ろに区切り（空白かコロン）を挟んで値が続けて
 * 読まれていれば、それを取り出す。区切りの無いもの（物件名称など）は、別の
 * 見出しなので見出しとみなさない。
 */
const PROPERTY_LABEL = /^\s*物\s*件\s*名(?:\s*[:：]\s*|\s+|\s*$)(.*)$/;

/**
 * 「物件名」の欄の値。見出し（物件名）の右に並ぶ、いちばん近い文字。
 * 見出しと値が 1 つのかたまりに読まれたときは、見出しの後ろを値とする。
 * 見つからなければ空。
 *
 * @param {{text:string, x0:number, y0:number, x1:number, y1:number}[]} items
 * @return {string}
 */
export function findPropertyName(items) {
  for (const label of items) {
    const match = PROPERTY_LABEL.exec(label.text);
    if (!match) continue;
    if (match[1].trim() !== '') return match[1].trim();
    // 同じ行：縦の範囲が、低いほうの高さの 3 割以上重なるもの（斜めから撮った
    // 写真では、同じ行でも右へ行くほど上下にずれる）。
    const row = items.filter(
      (item) =>
        item.x0 > centerX(label) &&
        Math.min(item.y1, label.y1) - Math.max(item.y0, label.y0) >=
          0.3 * Math.min(heightOf(item), heightOf(label))
    );
    row.sort((a, b) => a.x0 - b.x0);
    if (row.length > 0) return row[0].text.trim();
  }
  return '';
}

// --- 間取り図 ---------------------------------------------------------------

/**
 * 傾斜を測る部屋（居室）の名前。間取り図に書かれる呼び方のうち、測る対象に
 * なるもの。押入・CL・浴室・トイレ・玄関・バルコニーなどは入れない
 * （測るなら、確かめるダイアログで足す）。
 * 後ろに付く A・B や 1・2（洋室A・洋室2）はそのまま名前に残す。
 */
const ROOM_NAME = new RegExp(
  '^(' +
    [
      'LDK',
      'LD',
      'DK',
      '洋室',
      '和室',
      '居間',
      'リビングダイニング',
      'リビング・ダイニング',
      'ダイニングキッチン',
      'リビング',
      'ダイニング',
      'キッチン',
      '台所',
      '食堂',
      '主寝室',
      '寝室',
      '子供室',
      '子ども室',
      '子供部屋',
      '子ども部屋',
      '書斎',
      '納戸',
      '居室',
    ].join('|') +
    // 後ろの数字は、広さの数字の始まり（LDK19.0帖）でないものだけ。
    ')([A-Z]|[0-9](?![0-9.]))?'
);

/** 広さ（6帖・(8.5帖)・6畳・6J）。 */
const SIZE = /^\(?(\d{1,2}(?:\.\d)?)(帖|畳|J)\)?$/;

/** 階の見出し（1F・2階・floor1）。 */
const FLOOR = /^(?:([1-9])(?:F|階)|FLOOR([1-9]))$/;

/**
 * 1 つのかたまりを、部屋の名前・広さ・階の見出しのどれかとして読む。
 * どれでもなければ null。
 */
export function classify(text) {
  const t = normalize(text).toUpperCase();
  const floor = FLOOR.exec(t);
  if (floor) return { kind: 'floor', floor: floor[1] || floor[2] };
  const size = SIZE.exec(t);
  if (size) return { kind: 'size', size: size[1] };
  const room = ROOM_NAME.exec(t);
  if (room) {
    // 名前の後ろに広さが続けて読まれることがある（洋室6.0帖・和室(8帖)）。
    const rest = t.slice(room[0].length);
    const restSize = SIZE.exec(rest);
    if (rest === '' || restSize) {
      return { kind: 'room', name: room[0], size: restSize ? restSize[1] : '' };
    }
  }
  return null;
}

/**
 * 部屋ごとに、名前の下（または右）に書かれた広さを結び付ける。
 * 広さは、名前のかたまりの真下から、名前の高さの 2 つ分まで（または同じ行の
 * すぐ右）にあるもののうち、いちばん近いもの。1 つの広さは 1 部屋にだけ付ける。
 */
function attachSizes(rooms, sizes) {
  const used = new Set();
  for (const room of rooms) {
    if (room.size) continue;
    const h = heightOf(room);
    let best = null;
    let bestDistance = Infinity;
    for (const size of sizes) {
      if (used.has(size)) continue;
      const dx = centerX(size) - centerX(room);
      const dy = centerY(size) - centerY(room);
      const below = dy > 0 && dy <= 2 * h && Math.abs(dx) <= h * 1.5;
      const right = Math.abs(dy) < h / 2 && dx > 0 && size.x0 - room.x1 <= h;
      if (!below && !right) continue;
      const distance = Math.hypot(dx, dy);
      if (distance < bestDistance) {
        best = size;
        bestDistance = distance;
      }
    }
    if (best) {
      used.add(best);
      room.size = best.size;
    }
  }
}

/**
 * 部屋を階の見出しに振り分ける。
 *
 * 見出しは、階ごとの図の上（1F）か下（floor1）に置かれる。見出しが 2 つ
 * 以上あるときは、見出しの並ぶ向き（縦に並ぶか横に並ぶか）に沿って、
 *   - どの部屋よりも前（上・左）に見出しがある → 見出しは図の前に置く書き方。
 *     部屋は、手前にある最後の見出しの階
 *   - そうでなければ図の後に置く書き方。部屋は、後ろにある最初の見出しの階
 *     （最後の見出しより後ろの部屋は、最後の見出しの階）
 * 見出しが 1 つなら全部その階、無ければ階は空（ダイアログで入れる）。
 */
function assignFloors(rooms, floors) {
  if (floors.length === 0) return;
  if (floors.length === 1) {
    for (const room of rooms) room.floor = floors[0].floor;
    return;
  }
  const xs = floors.map(centerX);
  const ys = floors.map(centerY);
  const spread = (values) => Math.max(...values) - Math.min(...values);
  const along = spread(ys) >= spread(xs) ? centerY : centerX;
  const labels = [...floors].sort((a, b) => along(a) - along(b));
  const first = along(labels[0]);
  const before = rooms.every((room) => along(room) > first);
  for (const room of rooms) {
    const p = along(room);
    const label = before
      ? labels.findLast((l) => along(l) <= p)
      : labels.find((l) => along(l) >= p);
    // 図の後に置く書き方で、最後の見出しより後ろの部屋は、最後の見出しの階。
    room.floor = (label ?? labels[labels.length - 1]).floor;
  }
}

/**
 * 間取り図の写真 1 枚から、部屋（階・名前）を読む。
 *
 * @param {{text:string, x0:number, y0:number, x1:number, y1:number}[]} items
 * @return {{floor:string, name:string, size:string, x:number, y:number, h:number}[]}
 *   上から下、ほぼ同じ高さなら左から右の順。
 */
export function findRooms(items) {
  const rooms = [];
  const sizes = [];
  const floors = [];
  for (const item of items) {
    const found = classify(item.text);
    if (!found) continue;
    const box = { x0: item.x0, y0: item.y0, x1: item.x1, y1: item.y1 };
    if (found.kind === 'room') rooms.push({ ...box, floor: '', name: found.name, size: found.size });
    else if (found.kind === 'size') sizes.push({ ...box, size: found.size });
    else floors.push({ ...box, floor: found.floor });
  }
  attachSizes(rooms, sizes);
  assignFloors(rooms, floors);
  return rooms.map((room) => ({
    floor: room.floor,
    name: room.name,
    size: room.size,
    x: centerX(room),
    y: centerY(room),
    h: heightOf(room),
  }));
}

/**
 * 写真ごとに読んだ部屋を 1 つの一覧にする。
 *
 * 階の順（階の分からない部屋は最後）に並べ、同じ階の中は写真の順、同じ写真の
 * 中は上から下・左から右（縦の位置の差が文字の高さより小さければ同じ行）。
 * 同じ階に同じ名前の部屋が 2 つ以上あるときは、見分けられるよう広さを添える
 * （洋室（8.5帖））。
 *
 * @param {ReturnType<typeof findRooms>[]} perPhoto
 * @return {{floor:string, name:string}[]}
 */
export function mergeRooms(perPhoto) {
  const all = [];
  perPhoto.forEach((rooms, photo) => {
    // 上から順に行へまとめ（行の先頭との縦の差が文字の高さより小さいもの）、
    // 行の中を左から並べる。
    const rows = [];
    for (const room of [...rooms].sort((a, b) => a.y - b.y)) {
      const row = rows[rows.length - 1];
      if (row && room.y - row[0].y < Math.max(row[0].h, room.h)) row.push(room);
      else rows.push([room]);
    }
    rows
      .flatMap((row) => row.sort((a, b) => a.x - b.x))
      .forEach((room, index) => all.push({ ...room, photo, index }));
  });
  const floorKey = (room) => (room.floor === '' ? Infinity : Number(room.floor));
  all.sort((a, b) => floorKey(a) - floorKey(b) || a.photo - b.photo || a.index - b.index);

  const counts = new Map();
  for (const room of all) {
    const key = `${room.floor}\n${room.name}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return all.map((room) => {
    const duplicate = counts.get(`${room.floor}\n${room.name}`) > 1;
    const name = duplicate && room.size ? `${room.name}（${room.size}帖）` : room.name;
    return { floor: room.floor, name };
  });
}
