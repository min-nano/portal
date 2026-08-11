// 釘配列図の幾何計算（描画そのものは form-dom.js が SVG に写す）。
//
// GAS 版 index.html の diagram 算出をそのまま移した。工学座標（x は右・
// y は上、原点は面材の左下）を SVG 座標（y は下向き）へ変換して返す。
//
// 描画ドメインは「面材枠 (0,0)-(W,H) と全釘」の外接矩形にする。釘が面材から
// はみ出す配列でも切り取らず、はみ出していることが見えるようにするため。
//
// 釘座標はバックエンドが解釈した結果（/calculations の応答）をそのまま
// 受け取るので、この画面が座標の書式を解釈し直すことはない。

const PADDING = 44; // ラベル・目盛用の余白 [px]
const MAX_DIMENSION = 460; // 描画領域の長辺の目標サイズ [px]

/**
 * 釘配列図の幾何情報を作る。描けない入力（釘が無い・寸法が 0）なら null。
 *
 * @param {{x:number,y:number}[]} nails 釘座標 [mm]
 * @param {number} width  面材の幅 W [mm]
 * @param {number} height 面材の高さ H [mm]
 * @param {{x0:number,y0:number}|null} result 弾性中立軸（無ければ軸を描かない）
 */
export function buildDiagram(nails, width, height, result) {
  const panelWidth = Number(width) || 0;
  const panelHeight = Number(height) || 0;
  if (!(panelWidth > 0) || !(panelHeight > 0) || !nails || nails.length === 0) {
    return null;
  }

  const xs = nails.map((nail) => nail.x);
  const ys = nails.map((nail) => nail.y);
  const minX = Math.min(0, ...xs);
  const maxX = Math.max(panelWidth, ...xs);
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(panelHeight, ...ys);
  const domainWidth = maxX - minX;
  const domainHeight = maxY - minY;

  const scale = MAX_DIMENSION / Math.max(domainWidth, domainHeight);
  const mapX = (x) => PADDING + (x - minX) * scale;
  // y は上下を反転して、原点が左下に見えるようにする。
  const mapY = (y) => PADDING + (maxY - y) * scale;

  const unique = (values) => Array.from(new Set(values)).sort((a, b) => a - b);

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
    xTicks: unique(xs).map((x) => ({ value: x, position: mapX(x) })),
    yTicks: unique(ys).map((y) => ({ value: y, position: mapY(y) })),
    axes: result
      ? {
          x: mapX(result.x0),
          y: mapY(result.y0),
          x0: result.x0,
          y0: result.y0,
          top: mapY(maxY),
          bottom: mapY(minY),
          left: mapX(minX),
          right: mapX(maxX),
        }
      : null,
    axisBottom: mapY(minY),
    axisLeft: mapX(minX),
  };
}
