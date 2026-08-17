// 面材張り大壁 計算フォームの純粋ロジック（DOM に依存しない部分）。
//
// 計算そのもの・表示する桁の丸め・釘座標の解釈は、Rust で書いた唯一の実装
// （リポジトリの core/）が wasm として持つ。画面はそれを ../core.js 経由で
// 呼び、返ってきた表示用の値をそのまま並べるだけで、ここには「フォームの形を
// どう保つか」だけを置く。
//
// 入力の単位は壁 1 枚で、釘配列（グレー本 3.2）はその壁を構成する面材ごとの
// 入力として中に入る。実際の設計では面材の種類と釘が先に決まっていて、面材の
// 配置・釘の間隔・へりあきで調整するため。
//
// 面材と釘の仕様も面材ごとの入力で、1 枚の壁の中で混在してよい（上半分は
// N50、下半分は CN50 のような張り分け）。壁が持つのは階高・幅と中間材の
// 有無だけ。
//
// 「保存 / 別名で保存 / 未保存の確認」といったファイル操作の判断と文言は、
// 構造計算安全証明書 作成ツールと共通なので ../pdf-file-ops.js にある。

import { buildFileName } from '../pdf-file-ops.js';

/** 面材の既定寸法 [mm]（3×6 板を縦に使う一般的な面材）。 */
const DEFAULT_PANEL_WIDTH = 910;
const DEFAULT_PANEL_HEIGHT = 1820;

/** 壁の軸組と釘の既定値 [mm]（尺モジュールの間柱ピッチ・釘ピッチ）。 */
export const DEFAULT_STUD_PITCH = 455;
const DEFAULT_NAIL_PITCH = 150;

/**
 * へりあき（面材の縁から釘の中心まで）の下限 [mm]。
 *
 * 適用範囲 3.3(1)④「面材の釘列に対するへりあきは、10mm 以上かつ接合具径
 * d [mm] × 5 以上とする」の 10mm 側。d の側は選んだ釘で決まるので、
 * 表 3.3.1 の一覧が配る minEdgeDistance を使う。
 */
export const MIN_EDGE_DISTANCE = 10;

/** 壁の既定値。階高は一般的な 1 階。 */
const DEFAULT_WALL_HEIGHT = 2900;
const DEFAULT_WALL_WIDTH = 910;

let wallSequence = 0;
let panelSequence = 0;

/** 壁の一意 ID を作る。PDF に埋め込まれ、読み込み後もそのまま使う。 */
export function newWallId() {
  return `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 面材の一意 ID を作る。壁と同じく PDF に埋め込まれる。 */
export function newPanelId() {
  return `pn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 面材と釘の仕様の欄（面材ごとの入力）。空＝まだ決めていない。 */
export const EMPTY_SPEC = {
  materialId: '',
  thickness: '',
  shearModulus: '',
  k: '',
  deltaV: '',
  deltaU: '',
  deltaPv: '',
  gradeId: '',
  tauMax: '',
  e1: '',
  e2: '',
};

/**
 * 新しい面材（壁を構成する 1 枚）を作る。
 *
 * 面材は「壁の中で占める領域」。既定では壁の左下に 3×6 板を 1 枚置く形に
 * しておき、そこから動かしてもらう。釘配列はこの領域と壁の間柱ピッチから
 * 決まるので、面材が持つ釘の入力は釘ピッチとへりあきだけ。
 *
 * 面材と釘の数値は空のままにしておき、表 3.3.1 の一覧から読み込むか、
 * 4.5 の試験で得た値を直接入力してもらう（既定値を入れておくと、確かめない
 * まま計算してしまうため）。
 */
export function makePanel(overrides) {
  panelSequence += 1;
  return {
    panelId: newPanelId(),
    panelName: `面材${panelSequence}`,
    ...EMPTY_SPEC,
    side: 'front',
    left: 0,
    bottom: 0,
    right: DEFAULT_PANEL_WIDTH,
    top: DEFAULT_PANEL_HEIGHT,
    nailPitch: DEFAULT_NAIL_PITCH,
    edgeDistance: MIN_EDGE_DISTANCE,
    grain: '',
    ...(overrides || {}),
  };
}

/**
 * 新しい壁（面材張り大壁 1 枚分の入力）を作る。
 *
 * 壁は面材を張る**軸組**として持つ: 階高・幅と、間柱ピッチ。面材と釘の仕様は
 * 面材ごとの入力。面材は 1 枚から始める。
 */
export function makeWall(overrides) {
  wallSequence += 1;
  return {
    wallId: newWallId(),
    wallName: `壁${wallSequence}`,
    height: DEFAULT_WALL_HEIGHT,
    width: DEFAULT_WALL_WIDTH,
    // 釘の縦列の位置も、せん断座屈の ξ（中間材の有無）も、このピッチで決まる。
    studPitch: DEFAULT_STUD_PITCH,
    panels: [makePanel()],
    ...(overrides || {}),
  };
}

/**
 * 入力欄から読み直した内容を壁へ書き戻し、index の面材を返す。
 *
 * 書き戻すと面材はオブジェクトごと作り直される。書き換えたい面材を先に
 * 取り出しておくと、書き戻しで作り直されたほうが残って書き換えが捨てられる
 * ので、**書き換える面材はこの関数から受け取る**。index が無ければ null。
 */
export function capturePanel(wall, captured, index) {
  Object.assign(wall, captured);
  return (wall.panels || [])[index] || null;
}

/**
 * 面材と釘の仕様だけを取り出す（面材を足すときに前の面材から引き継ぐ）。
 *
 * 1 枚の壁で仕様を張り分けられるが、実際には同じ仕様で張ることのほうが
 * 多いので、面材を足したときは直前の面材の仕様を初期値にする。
 */
export function specOf(panel) {
  const spec = {};
  Object.keys(EMPTY_SPEC).forEach((key) => {
    spec[key] = (panel || {})[key] === undefined ? '' : panel[key];
  });
  return spec;
}

/**
 * 面材を足すときの、壁の中で占める領域の初期値。
 *
 * 直前の面材と同じ大きさのものを、その**真上**（同じ面・同じ左右の位置）に
 * 置く。壁は下から段を重ねて張ることが多いので、そのまま使えることが多く、
 * 違えばその面材の欄で動かせる。
 */
export function nextPlacement(previous) {
  const panel = previous || {};
  const side = panel.side === 'back' ? 'back' : 'front';
  const left = Number(panel.left) || 0;
  const right = Number(panel.right) || left + DEFAULT_PANEL_WIDTH;
  const top = Number(panel.top) || 0;
  const height = Math.max(top - (Number(panel.bottom) || 0), 0) || DEFAULT_PANEL_HEIGHT;
  return { side, left, bottom: top, right, top: top + height };
}

/**
 * 表 3.2.1 の組み合わせを、面材の入力欄へ入れる形にする。
 *
 * 大きさは「左下をそのままに右上を動かす」形で入る（面材は壁の中で占める
 * 領域なので、読み込みで位置まで動かさない）。
 */
export function panelFieldsFromPreset(panel, preset) {
  const left = Number(panel.left) || 0;
  const bottom = Number(panel.bottom) || 0;
  return {
    nailPitch: preset.nailPitch,
    edgeDistance: preset.edgeDistance,
    right: left + Number(preset.width),
    top: bottom + Number(preset.height),
  };
}

/**
 * 表 3.3.1 の 1 行を、面材の入力欄へ入れる形にする。
 *
 * 表 3.3.2 の既定の規格（構造用合板なら JAS 1 級）も一緒に入るので、これ
 * 1 回の選択で面材のせん断破壊・せん断座屈の検定まで数値がそろう。
 */
export function panelFieldsFromMaterial(material) {
  return {
    materialId: material.id,
    thickness: material.thickness,
    shearModulus: material.shearModulus,
    k: material.k,
    deltaV: material.deltaV,
    deltaU: material.deltaU,
    deltaPv: material.deltaPv,
    ...panelFieldsFromGrade({
      id: material.gradeId,
      tauMax: material.tauMax,
      e1: material.e1,
      e2: material.e2,
    }),
  };
}

/** 表 3.3.2 の 1 行（面材の規格）を、面材の入力欄へ入れる形にする。 */
export function panelFieldsFromGrade(grade) {
  return {
    gradeId: grade.id,
    tauMax: grade.tauMax,
    e1: grade.e1,
    e2: grade.e2,
  };
}

/** 表 3.3.1 から選んだ組合せを引く（選んでいなければ null）。 */
export function findMaterial(materials, materialId) {
  return (materials || []).find((entry) => entry.id === materialId) || null;
}

/**
 * 選んだ釘で必要になる、面材のへりあきの最小値 [mm]（適用範囲 3.3(1)④）。
 *
 * 「10mm 以上かつ接合具径 d × 5 以上」。d の側は計算実装が組合せごとに
 * 配るので、ここでは選んでいないとき（4.5 の試験値を直接入力する場合）の
 * 10mm を補うだけにする。
 */
export function minimumEdgeDistance(materials, materialId) {
  const material = findMaterial(materials, materialId);
  return material && material.minEdgeDistance
    ? material.minEdgeDistance
    : MIN_EDGE_DISTANCE;
}

/**
 * 選んだ面材と釘の組合せを、へりあきを決めるための一言にする。
 *
 * へりあきは釘の呼び径で決まる（3.3(1)④）ので、選んだ釘とその径、必要な
 * へりあきをそのまま伝える。
 */
export function nailNote(materials, materialId) {
  const material = findMaterial(materials, materialId);
  if (!material) return '';
  return (
    `選んだ釘は ${material.nailLabel}（呼び径 φ${material.nailDiameter} mm）です。` +
    `適用範囲 3.3(1)④ により、面材のへりあきは ${material.minEdgeDistance} mm 以上` +
    `（10 mm 以上かつ呼び径の 5 倍以上）にしてください。`
  );
}

/**
 * 面材のへりあきを、必要な最小値まで引き上げる（足りているものは触らない）。
 *
 * 面材と釘を選び直したとき・標準的な釘配列（表 3.2.1、へりあき 10 mm が
 * 前提）を読み込んだときに使う。設計者が広げた値を勝手に狭めないよう、
 * 引き上げるだけにしてある。
 */
export function raiseEdgeDistance(panels, minimum) {
  (panels || []).forEach((panel) => {
    if (!(Number(panel.edgeDistance) >= minimum)) panel.edgeDistance = minimum;
  });
  return panels;
}

/** 今日の日付を input[type=date] の値にする。 */
export function todayIso() {
  const now = new Date();
  return (
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}` +
    `-${String(now.getDate()).padStart(2, '0')}`
  );
}

/**
 * 新規作成の初期状態。1 物件 = 1 ファイルなので、壁は 1 枚から始める。
 */
export function emptyFormData() {
  return {
    projectName: '',
    issuedOn: todayIso(),
    walls: [makeWall()],
  };
}

/**
 * 読み込んだ PDF の内容を、この画面が扱う形に整える。
 *
 * 定義に無いキーは捨て、足りないキーは既定値で埋める。壁が 1 枚も無ければ
 * 空の壁を 1 枚用意する（編集を始められる状態にする）。古い形（釘配列
 * パターンを別に登録した形）からの移し替えは、読み込みの時点で計算実装が
 * 済ませているので、ここには来ない。
 */
export function mergeFormData(parsed) {
  const walls = Array.isArray(parsed && parsed.walls) ? parsed.walls : [];
  const merged = walls.map((wall, index) =>
    makeWall({
      wallId: String(wall.wallId || '') || newWallId(),
      wallName: String(wall.wallName || '') || `壁${index + 1}`,
      height: Number(wall.height) || 0,
      width: Number(wall.width) || 0,
      studPitch: Number(wall.studPitch) || DEFAULT_STUD_PITCH,
      panels: (Array.isArray(wall.panels) ? wall.panels : []).map((panel, position) =>
        makePanel({
          panelId: String(panel.panelId || '') || newPanelId(),
          panelName: String(panel.panelName || '') || `面材${position + 1}`,
          // 面材と釘の仕様は面材ごと。壁が 1 組だけ持っていた版の入力は
          // 計算実装（wasm）が読み込みの時点で面材へ配り終えているので、
          // ここでは面材の側だけを読む。
          materialId: String(panel.materialId || ''),
          thickness: Number(panel.thickness) || 0,
          shearModulus: Number(panel.shearModulus) || 0,
          k: Number(panel.k) || 0,
          deltaV: Number(panel.deltaV) || 0,
          deltaU: Number(panel.deltaU) || 0,
          deltaPv: Number(panel.deltaPv) || 0,
          gradeId: String(panel.gradeId || ''),
          tauMax: Number(panel.tauMax) || 0,
          e1: Number(panel.e1) || 0,
          e2: Number(panel.e2) || 0,
          // 面材は壁の中で占める領域。読み込みの時点で計算実装が
          // 前の版の入力（寸法だけ・左下だけ）を領域へ直し終えている。
          side: panel.side === 'back' ? 'back' : 'front',
          left: Number(panel.left) || 0,
          bottom: Number(panel.bottom) || 0,
          right: Number(panel.right) || 0,
          top: Number(panel.top) || 0,
          nailPitch: Number(panel.nailPitch) || 0,
          edgeDistance: Number(panel.edgeDistance) || 0,
          grain: String(panel.grain || ''),
        })
      ),
    })
  );

  return {
    projectName: String((parsed && parsed.projectName) || ''),
    issuedOn: String((parsed && parsed.issuedOn) || '') || todayIso(),
    walls: merged.length > 0 ? merged : [makeWall()],
  };
}

/** バックエンドへ送る本文（保存・計算で共通）。 */
export function toRequestBody(data) {
  return {
    projectName: data.projectName,
    issuedOn: data.issuedOn,
    walls: data.walls,
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
 * これと突き合わせる。壁の値（3.3）だけでなく、その根拠になる面材ごとの
 * 釘配列諸定数（3.2）も送る。同じ .wasm を動かしている以上ふつうは一致
 * するが、画面を開いたまま新しい版がデプロイされた場合などに食い違いが
 * 起こりうる。
 */
export function verificationOf(coreVersion, reports) {
  const walls = (reports && reports.walls) || [];
  const panels = walls.flatMap((wall) => (wall && wall.panelReports) || []);
  const calculated = (list) => list.filter((report) => report && report.ok);
  return {
    coreVersion,
    walls: calculated(walls).map((report) => ({
      wallId: report.wallId,
      result: report.result,
    })),
    panels: calculated(panels).map((report) => ({
      panelId: report.panelId,
      result: report.result,
    })),
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
      const name =
        difference.panelName ||
        difference.wallName ||
        difference.panelId ||
        difference.wallId;
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
  return buildFileName(
    template,
    { projectName: String(data.projectName || '').trim() },
    fallback
  );
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

/** 壁を消せるのは 2 枚以上あるときだけ（0 枚の物件は作らせない）。 */
export function canRemoveWall(data) {
  return (data.walls || []).length > 1;
}

/** 削除後に選んでおく壁の位置。末尾を消したら 1 つ前へ寄せる。 */
export function indexAfterRemoval(currentIndex, remaining) {
  return Math.max(0, Math.min(currentIndex, remaining - 1));
}

/** 壁のタブに出す名前（未入力なら通し番号で代替する）。 */
export function wallLabel(wall, index) {
  return String((wall && wall.wallName) || '').trim() || `壁${index + 1}`;
}

/** 面材の見出しに出す名前（未入力なら通し番号で代替する）。 */
export function panelLabel(panel, index) {
  return String((panel && panel.panelName) || '').trim() || `面材${index + 1}`;
}
