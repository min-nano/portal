// 頁の文字情報（サーチャブル PDF の透明な文字）を消す。
//
// スキャンした頁の文字情報は、画像の上に「描かない文字」（描き方 3 Tr）として
// 重ねてある。OCR の結果が文字化けしていると、結合した PDF を検索しても
// 化けた文字に当たり、Gemini などにも化けた文を読ませてしまう。そこで、
// 選んだ頁だけ、この透明な文字を消して結合する（Drive が画像から読み直せる
// ように。README「文字情報を消す」参照）。
//
// 消すのは、文字を描く命令（Tj・TJ・'・"）のうち、透明な文字だけでできた
// BT … ET の中のものだけ。見える文字（描き方が 3 以外）が 1 つでも混ざる
// BT … ET は、そのまま残す（同じ BT の中では、文字を描くたびに次の文字の
// 位置が進むので、透明な文字だけ抜くと、後ろの見える文字の位置が変わる）。
// 文字の状態（書体・描き方など）を決める命令は残すので、後ろの命令の状態は
// 変わらない。'・" は行を送る働きもあるので、行送り（T*。" は字間・語間も）に
// 置き換える。
//
// 画像・図形はバイト列のまま残す。頁の中身は、書き換えたものを新しい
// ストリームにして頁に付け替え、フォーム（XObject の Form）の中の文字は、
// 書き換えた写しを作って、その頁の資源だけから指す（ほかの頁と共有している
// 中身・資源・フォームは書き換えない）。インライン画像（BI … EI）のある
// 中身は、命令を最後まで読めないので消さない。

import { PDFDict, PDFName, PDFRawStream } from 'pdf-lib';
import { contentBytes, decodedBytes, operations } from './content-stream.js';

/** 文字を描く命令。 */
const SHOW = new Set(['Tj', 'TJ', "'", '"']);
/** 描かない文字の描き方（Tr）。 */
const INVISIBLE = 3;
/** フォームを入れ子でたどる深さの上限（scan-images.js と同じ）。 */
const MAX_FORM_DEPTH = 4;

/**
 * 頁（またはフォーム）の中身 1 つから、消す命令を探す。
 *
 * @param {Uint8Array} bytes 展開した中身
 * @param {number} [mode] 始めの描き方（フォームは、呼んだところの描き方を受け継ぐ）
 * @returns {{edits:{start:number, end:number, text:string}[], removed:number, kept:number,
 *            forms:{name:string, mode:number}[]} | null}
 *   edits は置き換える範囲（text に替える）、removed は消す命令の数、kept は残す
 *   文字の命令の数、forms は中で呼んでいる XObject（と、呼んだときの描き方）。
 *   命令を最後まで読めなければ（インライン画像）null
 */
export function planContent(bytes, mode = 0) {
  const edits = [];
  const forms = [];
  const stack = [];
  let removed = 0;
  let kept = 0;
  let block = null; // BT … ET の中: { edits, shows, visible }
  for (const { op, operands, start, end } of operations(bytes)) {
    if (op === 'BI') return null;
    if (op === 'q') {
      stack.push(mode);
    } else if (op === 'Q') {
      mode = stack.pop() ?? mode;
    } else if (op === 'Tr') {
      const value = operands.at(-1);
      if (typeof value === 'number') mode = value;
    } else if (op === 'BT' || op === 'ET') {
      // 閉じずに次の BT が来たら（壊れた中身）、前の BT … ET はそこで閉じたものとする。
      if (block) {
        if (block.visible) {
          kept += block.shows;
        } else {
          edits.push(...block.edits);
          removed += block.shows;
        }
      }
      block = op === 'BT' ? { edits: [], shows: 0, visible: false } : null;
    } else if (SHOW.has(op)) {
      if (!block) {
        kept++; // BT の外の文字（壊れた中身）は、手を付けずに残す
        continue;
      }
      block.shows++;
      if (mode !== INVISIBLE) {
        block.visible = true;
        continue;
      }
      if (op === '"') {
        // aw ac (文字) " ＝ aw Tw ac Tc (文字) '
        const [aw, ac] = operands.slice(-3);
        if (typeof aw !== 'number' || typeof ac !== 'number') {
          block.visible = true; // 読めない指定は、手を付けずに残す
          continue;
        }
        block.edits.push({ start, end, text: ` ${aw} Tw ${ac} Tc T* ` });
      } else {
        // 前後の命令とつながらないように、空白で挟む（「Td(a)'」を「TdT*」にしない）。
        block.edits.push({ start, end, text: op === "'" ? ' T* ' : ' ' });
      }
    } else if (op === 'Do') {
      const name = operands.at(-1);
      if (typeof name === 'string') forms.push({ name: name.slice(1), mode });
    }
  }
  // 閉じていない BT（壊れた中身）は、手を付けずに残す。
  if (block) kept += block.shows;
  return { edits, removed, kept, forms };
}

/** 置き換えを当てたバイト列。edits は start の順に並び、重ならないこと。 */
export function applyEdits(bytes, edits) {
  const encoder = new TextEncoder();
  const parts = [];
  let at = 0;
  for (const { start, end, text } of edits) {
    parts.push(bytes.subarray(at, start), encoder.encode(text));
    at = end;
  }
  parts.push(bytes.subarray(at));
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function isForm(stream) {
  return stream instanceof PDFRawStream && stream.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Form');
}

/**
 * 資源（Resources）の XObject のうち、書き換えたフォームを差し替えた写し。
 * 元の資源は、ほかの頁と共有していることがあるので書き換えない。
 */
function replacedResources(context, resources, replaced) {
  const copy = resources.clone(context);
  const xobjects = resources.lookup(PDFName.of('XObject'), PDFDict).clone(context);
  for (const [name, ref] of replaced) xobjects.set(PDFName.of(name), ref);
  copy.set(PDFName.of('XObject'), xobjects);
  return copy;
}

/**
 * 中身 1 つと、そこから呼ぶフォームをたどって、消す命令を数える（write なら書き換える）。
 *
 * @returns {{removed:number, kept:number, bytes:Uint8Array|null, replaced:Map<string, import('pdf-lib').PDFRef>} | null}
 *   bytes は書き換えた中身（消すものが無ければ null）、replaced は資源の中で
 *   差し替えるフォーム（名前 → 書き換えた写し）。読めなければ null
 */
function walk(context, bytes, resources, mode, depth, state) {
  const plan = planContent(bytes, mode);
  if (!plan) return null;
  let { removed, kept } = plan;
  const replaced = new Map();
  const modes = new Map(); // フォームの名前 → 呼んだときの描き方
  const removing = new Set(); // 消すものがあったフォームの名前
  const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  for (const { name, mode: inner } of plan.forms) {
    const stream = xobjects?.lookup(PDFName.of(name));
    if (!isForm(stream)) continue; // 画像（と読めないもの）には文字が無い
    const form = formResult(context, stream, resources, inner, depth + 1, state);
    if (!form) return null;
    // 描き方を受け継ぐフォームを、違う描き方で呼んでいて消すものがあれば、
    // 1 つの名前で両方を指せないので諦める。
    if (modes.has(name) && modes.get(name) !== inner && (form.removed > 0 || removing.has(name))) return null;
    modes.set(name, inner);
    if (form.removed > 0) removing.add(name);
    removed += form.removed;
    kept += form.kept;
    if (form.ref) replaced.set(name, form.ref);
  }
  return {
    removed,
    kept,
    bytes: plan.edits.length ? applyEdits(bytes, plan.edits) : null,
    replaced,
  };
}

/**
 * フォーム 1 つ（同じフォームを同じ描き方で何度呼んでも、1 度だけたどる）。
 *
 * 資源を持たないフォームは、呼んだところの資源で読むので、呼ぶところごとに
 * 中身の意味が変わりうる。写しを使い回さない。
 */
function formResult(context, stream, outer, mode, depth, state) {
  const resources = stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict);
  const key = `${mode}`;
  const known = resources ? state.forms.get(stream)?.get(key) : undefined;
  if (known !== undefined) return known;
  // 深すぎる入れ子・自分を（間接に）呼ぶフォームは、たどらずに諦める。
  if (depth > MAX_FORM_DEPTH || state.visiting.has(stream)) return null;
  state.visiting.add(stream);
  const content = decodedBytes([stream]);
  const result = walk(context, content, resources ?? outer, mode, depth, state);
  state.visiting.delete(stream);
  let form = null;
  if (result) {
    form = { removed: result.removed, kept: result.kept, ref: null };
    if (state.write && (result.bytes || result.replaced.size)) {
      const fresh = context.flateStream(result.bytes ?? content);
      for (const [name, value] of stream.dict.entries()) {
        if (['Length', 'Filter', 'DecodeParms'].includes(name.decodeText())) continue;
        fresh.dict.set(name, value);
      }
      // 資源を持たないフォームは、呼んだところの資源を使う（それを写して持たせる）。
      if (result.replaced.size) {
        fresh.dict.set(PDFName.of('Resources'), replacedResources(context, resources ?? outer, result.replaced));
      }
      form.ref = context.register(fresh);
    }
  }
  if (resources) {
    if (!state.forms.has(stream)) state.forms.set(stream, new Map());
    state.forms.get(stream).set(key, form);
  }
  return form;
}

/**
 * 頁の透明な文字を数える（write なら消す）。
 *
 * 消すときは、書き換えた中身を新しいストリームにして頁に付け、書き換えた
 * フォームは、写した資源から指す。元の中身・資源・フォームは書き換えない。
 *
 * @param {import('pdf-lib').PDFPage} page
 * @param {{write?:boolean, cache?:Map}} [options] cache は同じ文書の頁どうしで
 *   使い回す（同じフォームを共有する頁で、写しを 1 つにする）
 * @returns {{removed:number, kept:number} | null}
 *   removed は消す（消した）文字の命令の数、kept は残る文字の命令の数。
 *   頁の中身を読めなければ null（消さない）
 */
export function stripInvisibleText(page, { write = false, cache = new Map() } = {}) {
  const { node } = page;
  const { context } = node;
  const resources = node.Resources();
  let result;
  try {
    // 展開できない中身・フォーム（知らない圧縮など）は、消せないものとする。
    const content = contentBytes(node);
    result = content && walk(context, content, resources, 0, 0, { write, forms: cache, visiting: new Set() });
  } catch {
    return null;
  }
  if (!result) return null;
  if (write && result.removed > 0) {
    if (result.bytes) node.set(PDFName.of('Contents'), context.register(context.flateStream(result.bytes)));
    if (result.replaced.size) node.set(PDFName.of('Resources'), replacedResources(context, resources, result.replaced));
  }
  return { removed: result.removed, kept: result.kept };
}
