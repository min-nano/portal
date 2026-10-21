// 頁の画像を測る worker（measure-client.js から使う）。
//
// 傾きの測り方は、角度を変えながら数万の点を投影し直すので、1 頁で数十ミリ秒
// かかる。数百頁を画面と同じスレッドで測ると、その間ずっと画面が固まるので、
// ここで測る。測り方そのものは image-checks.js にあり、画面と同じもの。
//
// この worker に話しかけられるのは、作った画面だけ（専用の worker）。それでも
// 届いたものは形を確かめてから使う（決まった形の画像だけを測る）。

import { measurePage } from './image-checks.js';

/** 届いたものが「測る画像」の形をしていれば、写しを返す。違えば null。 */
export function imageFrom(data) {
  const image = data?.image;
  if (!Number.isInteger(data?.id) || !image || !(image.gray instanceof Uint8Array)) return null;
  const { width, height } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  if (width * height !== image.gray.length) return null;
  return { width, height, gray: new Uint8Array(image.gray) };
}

self.onmessage = (event) => {
  // 専用の worker への知らせには送り主が付かない（空）。付いていれば、この
  // 画面と同じところからのものだけを受ける。
  if (event.origin && event.origin !== self.location?.origin) return;
  const { data } = event;
  const image = imageFrom(data);
  if (!image) {
    if (Number.isInteger(data?.id)) self.postMessage({ id: data.id, error: '測る画像の形が正しくありません。' });
    return;
  }
  try {
    self.postMessage({ id: data.id, measure: measurePage(image) });
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error?.message || error) });
  }
};
