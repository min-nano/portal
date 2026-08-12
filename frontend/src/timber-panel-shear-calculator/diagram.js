// 釘配列図の縮尺と座標変換（描画そのものは form-dom.js が SVG に写す）。
//
// 工学座標（x は右・y は上、原点は面材の左下）を SVG 座標（y は下向き）へ
// 変換して返す。
//
// 「どこからどこまでを描くか」「目盛にどの値を出し、どう書くか」は計算実装
// （core/）が決めたもの（計算結果の diagram）をそのまま使う。計算書 PDF も
// 同じものを読むので、画面と計算書は縮尺だけが違う同じ図になる。描画範囲は
// 「面材枠 (0,0)-(W,H) と全釘」の外接矩形で、釘が面材からはみ出す配列でも
// 切り取らず、はみ出していることが見えるようになっている。

const PADDING = 44; // ラベル・目盛用の余白 [px]
const MAX_DIMENSION = 460; // 描画領域の長辺の目標サイズ [px]

/**
 * 釘配列図の幾何情報を作る。描けない入力（釘が無い・寸法が 0）なら null。
 *
 * @param {{x:number,y:number}[]} nails 釘座標 [mm]
 * @param {object|null} diagram 計算結果の diagram（面材寸法・範囲・目盛・中立軸）
 */
export function buildDiagram(nails, diagram) {
  if (!diagram || !nails || nails.length === 0) return null;
  const panelWidth = Number(diagram.panelWidth) || 0;
  const panelHeight = Number(diagram.panelHeight) || 0;
  if (!(panelWidth > 0) || !(panelHeight > 0)) return null;

  const { minX, maxX, minY, maxY } = diagram;
  const domainWidth = maxX - minX;
  const domainHeight = maxY - minY;

  const scale = MAX_DIMENSION / Math.max(domainWidth, domainHeight);
  const mapX = (x) => PADDING + (x - minX) * scale;
  // y は上下を反転して、原点が左下に見えるようにする。
  const mapY = (y) => PADDING + (maxY - y) * scale;

  return {
    svgWidth: domainWidth * scale + PADDING * 2,
    svgHeight: domainHeight * scale + PADDING * 2,
    frame: {
      x: mapX(0),
      y: mapY(panelHeight),
      width: panelWidth * scale,
      height: panelHeight * scale,
    },
    points: nails.map((nail, index) => ({
      index: index + 1,
      cx: mapX(nail.x),
      cy: mapY(nail.y),
      x: nail.x,
      y: nail.y,
    })),
    xTicks: diagram.xTicks.map((tick) => ({
      label: tick.label,
      position: mapX(tick.value),
    })),
    yTicks: diagram.yTicks.map((tick) => ({
      label: tick.label,
      position: mapY(tick.value),
    })),
    axes: diagram.axis
      ? {
          x: mapX(diagram.axis.x0),
          y: mapY(diagram.axis.y0),
          xLabel: diagram.axis.xLabel,
          yLabel: diagram.axis.yLabel,
        }
      : null,
    axisBottom: mapY(minY),
    axisLeft: mapX(minX),
  };
}
