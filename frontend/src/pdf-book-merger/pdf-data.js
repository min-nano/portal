// pdf.js が頁を読むのに使う、PDF の外のデータ（CMap・標準フォント・画像の展開の wasm）。
//
// 渡さないと、pdf.js はそれが要る PDF の文字や画像を落とす。とくに Illustrator・
// InDesign で作ったカタログのような PDF は、日本語のフォントを埋め込んでいても、
// 文字の番号から Unicode への対応（ToUnicode）を持たず、Adobe-Japan1 の CMap で
// 引くことを前提にしている。CMap が無いと pdf.js はフォントを読めず、頁の文字が
// 描かれず、文字情報も空になる。
//
// pdf.js はこれらを「ディレクトリの URL ＋ ファイル名」で探すが、ビルドした
// ファイルは名前にハッシュが付くので、ファイル名 → URL の表を作って渡す
// （pdf.js の BinaryDataFactory と同じ形）。ファイルは /assets/ に置かれ、
// 要るときにだけ読まれる。
//
// 色の変換（qcms の wasm と CMYK の ICC）は、pdf.js が worker の中から決まった
// ファイル名で同期的に読むので、この形では渡せない（渡さなければ、pdf.js は
// 自前の近似で変換する）。

/** pdf.js の種類（cMapUrl など） → ファイル名 → URL。 */
const FILES = {
  cMapUrl: namesOf(import.meta.glob('/node_modules/pdfjs-dist/cmaps/*.bcmap', { query: '?url&no-inline', import: 'default', eager: true })),
  standardFontDataUrl: namesOf(
    import.meta.glob('/node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}', { query: '?url&no-inline', import: 'default', eager: true })
  ),
  // JPEG 2000（openjpeg）と JBIG2 の画像。白黒のスキャンによくある。
  wasmUrl: namesOf(
    import.meta.glob('/node_modules/pdfjs-dist/wasm/{openjpeg,jbig2}.wasm', { query: '?url&no-inline', import: 'default', eager: true })
  ),
};

function namesOf(urls) {
  return Object.fromEntries(Object.entries(urls).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url]));
}

/** ファイル名に当たる URL（無ければ null）。 */
export function bundledUrl(kind, filename) {
  return Object.hasOwn(FILES[kind] ?? {}, filename) ? FILES[kind][filename] : null;
}

/**
 * pdf.js の getDocument に BinaryDataFactory として渡す。pdf.js は worker から
 * 頼まれたファイルを、これで読んで渡す。
 */
export class BundledDataFactory {
  async fetch({ kind, filename }) {
    const url = bundledUrl(kind, filename);
    if (!url) throw new Error(`pdf.js のデータ（${kind}: ${filename}）を同梱していません`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`pdf.js のデータ（${filename}）を読めませんでした（HTTP ${response.status}）`);
    return new Uint8Array(await response.arrayBuffer());
  }
}
