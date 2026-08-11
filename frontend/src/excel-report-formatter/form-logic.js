// フォームの純粋ロジック（DOM 非依存）。GAS 版 index.html から移植し、
// vitest で単体テストする。フォーム定義とバリデーション設定は、旧版のように
// フロントエンドへ直書きせず、バックエンドの /config API（mapping.json 由来）
// から受け取る。

/**
 * モバイル IME の全角数字・記号（－ ． など）も数値として解釈する。
 * バックエンドの NFKC 正規化と挙動を揃える。
 */
export function toNumber(value) {
  if (value === undefined || value === null) return NaN;
  let text = String(value).trim();
  if (text === '') return NaN;
  if (text.normalize) text = text.normalize('NFKC');
  return parseFloat(text);
}

/**
 * 選択欄（傾斜方向 / 測定した壁・柱）を選んだ後に、フォーカスをどこへ送るかを決める。
 *
 *   'value'       … 同じ行の数値欄（水平器）へ移動する。
 *   'next-select' … 「傾斜無」「―」など計測値を入力しない選択肢。数値欄は飛ばして
 *                   次の計測点の選択欄へ移動する。
 *   'none'        … 未選択（「（なし）」）に戻した場合。フォーカスは動かさない。
 *
 * @param {string} value 選択された値
 * @param {string[]} noValueOptions /config の validation.no_value_select_options
 * @return {'value'|'next-select'|'none'}
 */
export function selectFocusTarget(value, noValueOptions) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (text === '') return 'none';
  return (noValueOptions || []).indexOf(text) !== -1 ? 'next-select' : 'value';
}

/**
 * 出力前の簡易バリデーション。入力ミスの可能性を「警告」として集める
 * （ブロックはせず、利用者の確認後にそのまま出力できる）。
 *
 * @param {{rooms: Array}} formData 送信データ
 * @param {Array} measurementGroups /config の measurement_groups
 * @param {Object} validation /config の validation（mapping.json の validation）
 * @return {string[]} 警告メッセージの配列
 */
export function collectWarnings(formData, measurementGroups, validation) {
  const threshold = validation.slope_warning_threshold;
  const noValueOptions = validation.no_value_select_options || [];
  const requireSelectKeys = validation.require_select_keys || [];

  const warnings = [];
  (formData.rooms || []).forEach(function (room, i) {
    const label = '部屋 ' + (i + 1);
    const measurements = room.measurements || {};
    measurementGroups.forEach(function (g) {
      g.points.forEach(function (p) {
        const data = measurements[p.key] || {};
        const select = data.select;
        const where = label + ' の「' + g.group + ' ' + p.label + '」';

        // 柱など、必ず選択させたい計測点が未選択。
        if (
          requireSelectKeys.indexOf(p.key) !== -1 &&
          (select === undefined || String(select).trim() === '')
        ) {
          warnings.push(where + 'が未選択です。必ず選択してください。');
          return;
        }

        // 「傾斜無」「―」以外を選択しているのに数値が未入力 / 傾斜が大きい場合を確認。
        if (select && noValueOptions.indexOf(select) === -1) {
          const level = toNumber(data.digital_level);
          const diff = toNumber(data.diff);
          const distance = toNumber(data.distance);
          const hasLevel = !isNaN(level);
          const hasRatio = !isNaN(diff) && !isNaN(distance) && distance !== 0;

          if (!hasLevel && !hasRatio) {
            warnings.push(where + 'で向きを選択していますが、計測値が未入力です。');
            return;
          }

          // 傾斜（1000分率）＝ 水平器計測値 または 1000*差/距離。
          let slope = 0;
          if (hasLevel) slope = Math.max(slope, Math.abs(level));
          if (hasRatio) slope = Math.max(slope, Math.abs((1000 * diff) / distance));
          if (slope >= threshold) {
            const shown = Math.round(slope * 10) / 10;
            warnings.push(
              where + 'の傾斜が約 ' + shown + '/1000 です（' + threshold +
                '/1000 以上だと再検査）。入力ミスがないか確認してください。'
            );
          }
        }
      });
    });
  });
  return warnings;
}
