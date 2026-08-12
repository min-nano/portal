// 釘配列諸定数 計算フォームの純粋ロジック（DOM に依存しない部分）。
//
// 計算そのもの・表示する桁の丸め・釘座標の解釈は、Rust で書いた唯一の実装
// （リポジトリの core/）が wasm として持つ。画面はそれを ./core.js 経由で
// 呼び、返ってきた表示用の値をそのまま並べるだけで、ここには「フォームの形を
// どう保つか」だけを置く。
//
// 「保存 / 別名で保存 / 未保存の確認」といったファイル操作の判断と文言は、
// 構造計算安全証明書 作成ツールと共通なので ../pdf-file-ops.js にある。

import { sanitizeFileName } from '../pdf-file-ops.js';

/** 面材の既定寸法 [mm]（3×10 板の短辺 × 一般的な階高まわり）。 */
const DEFAULT_WIDTH = 910;
const DEFAULT_HEIGHT = 2730;

let patternSequence = 0;

/** パターンの一意 ID を作る。PDF に埋め込まれ、読み込み後もそのまま使う。 */
export function newPatternId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 新しいパターン（1 枚の面材の入力）を作る。 */
export function makePattern(overrides) {
  patternSequence += 1;
  return {
    patternId: newPatternId(),
    patternName: `パターン${patternSequence}`,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    mode: 'grid',
    gridX: '',
    gridY: '',
    coords: '',
    ...(overrides || {}),
  };
}

/** 今日の日付を input[type=date] の値にする。 */
export function todayIso() {
  const now = new Date();
  return (
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}` +
    `-${String(now.getDate()).padStart(2, '0')}`
  );
}

/** 新規作成の初期状態。1 物件 = 1 ファイルなので、パターンは 1 つから始める。 */
export function emptyFormData() {
  return { projectName: '', issuedOn: todayIso(), patterns: [makePattern()] };
}

/**
 * 読み込んだ PDF の内容を、この画面が扱う形に整える。
 *
 * 定義に無いキーは捨て、足りないキーは既定値で埋める。パターンが 1 つも
 * 無ければ空のパターンを 1 つ用意する（編集を始められる状態にする）。
 */
export function mergeFormData(parsed) {
  const patterns = Array.isArray(parsed && parsed.patterns) ? parsed.patterns : [];
  const merged = patterns.map((pattern, index) =>
    makePattern({
      patternId: String(pattern.patternId || '') || newPatternId(),
      patternName: String(pattern.patternName || '') || `パターン${index + 1}`,
      width: Number(pattern.width) || 0,
      height: Number(pattern.height) || 0,
      mode: pattern.mode === 'coords' ? 'coords' : 'grid',
      gridX: String(pattern.gridX || ''),
      gridY: String(pattern.gridY || ''),
      coords: String(pattern.coords || ''),
    })
  );
  return {
    projectName: String((parsed && parsed.projectName) || ''),
    issuedOn: String((parsed && parsed.issuedOn) || '') || todayIso(),
    patterns: merged.length > 0 ? merged : [makePattern()],
  };
}

/** バックエンドへ送る本文（保存・計算で共通）。 */
export function toRequestBody(data) {
  return {
    projectName: data.projectName,
    issuedOn: data.issuedOn,
    patterns: data.patterns,
  };
}

/**
 * 未保存の入力があるかを判定するための、フォーム内容の指紋。
 *
 * 読み込み直後・保存直後の値と比べて、変わっていれば「編集中」とみなす。
 */
export function formSignature(data) {
  return JSON.stringify(toRequestBody(data));
}

/**
 * 保存時に添える「画面はこう計算した」。
 *
 * 編集中の計算は画面（wasm）が行うので、サーバは保存のたびに同じ計算をして
 * これと突き合わせる。同じ .wasm を動かしている以上ふつうは一致するが、
 * 画面を開いたまま新しい版がデプロイされた場合などに食い違いが起こりうる。
 */
export function verificationOf(coreVersion, reports) {
  return {
    coreVersion,
    patterns: (reports || [])
      .filter((report) => report && report.ok)
      .map((report) => ({ patternId: report.patternId, result: report.result })),
  };
}

/**
 * 突き合わせの結果を、画面に出す 1 つの文にする。
 * 食い違いが無ければ空文字（＝警告を出さない）。
 */
export function verificationWarning(verification) {
  if (!verification || !verification.checked || verification.ok) return '';

  const versions = verification.coreVersion || {};
  if (versions.client !== versions.server) {
    return (
      '警告: 画面の計算エンジン（' +
      `${versions.client || '不明'}）がサーバー（${versions.server || '不明'}）と違います。` +
      'ページを再読み込みしてから、内容を確かめてください。' +
      '計算書には、サーバーで計算し直した値が載っています。'
    );
  }

  const differences = verification.differences || [];
  const shown = differences
    .map((difference) => {
      const name = difference.patternName || difference.patternId;
      return `${name} の ${difference.key}（画面 ${difference.client} / 計算書 ${difference.server}）`;
    })
    .join('、');
  const omitted = verification.omittedDifferences
    ? ` ほか ${verification.omittedDifferences} 件`
    : '';
  return (
    '警告: 画面に出ていた値と、計算書に載せた値が違います: ' +
    `${shown}${omitted}。計算書にはサーバーで計算し直した値が載っています。`
  );
}

/**
 * 入力内容から既定のファイル名を組み立てる。
 * template は /config が配る "釘配列諸定数計算書_{projectName}.pdf" のような文字列。
 */
export function suggestedFileName(template, data, fallback) {
  const project = String(data.projectName || '').trim();
  if (!project) return fallback;
  const filled = String(template || '').replace(/\{(\w+)\}/g, (whole, key) =>
    key === 'projectName' ? project : ''
  );
  return sanitizeFileName(filled) || fallback;
}

/**
 * 保存ダイアログに最初から入れておくファイル名。
 *
 * 既に名前が決まっている（Drive から開いた・一度保存した）ならその名前、
 * まだ無ければ物件名から組み立てた候補を使う。
 */
export function defaultSaveName(config, data, documentName) {
  return (
    documentName ||
    suggestedFileName(config.file_name_template, data, config.default_file_name)
  );
}

/** パターンを消せるのは 2 つ以上あるときだけ（0 個の物件は作らせない）。 */
export function canRemovePattern(data) {
  return data.patterns.length > 1;
}

/** 削除後に選んでおくパターンの位置。末尾を消したら 1 つ前へ寄せる。 */
export function indexAfterRemoval(currentIndex, remaining) {
  return Math.max(0, Math.min(currentIndex, remaining - 1));
}

/** パターンのタブに出す名前（未入力なら通し番号で代替する）。 */
export function patternLabel(pattern, index) {
  return String((pattern && pattern.patternName) || '').trim() || `パターン${index + 1}`;
}
