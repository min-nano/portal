// 計算実装（wasm）を読み込み、画面から呼べるようにする（ツール共通）。
//
// 計算そのもの・入力欄の文字列の解釈・表示する桁の丸めは、Rust で書いた
// 唯一の実装（リポジトリの core/）が持つ。その .wasm は **サーバが自分の
// 計算に使っているものと同じバイト列** で、/config が知らせる URL から
// 受け取る。だから「画面用の実装」と「サーバ用の実装」に分かれることがない。
// 面材張り大壁と必要壁量は、どちらもこの同じ .wasm を動かす。
//
// 編集中はここで計算するので、入力のたびの往復が無い（釘が増えても速い）。
// 保存のときはサーバも同じ計算をして、画面の値と突き合わせる。
//
// 下の computeAll() などは面材張り大壁のための便利メソッド。必要壁量は
// call({ op: 'wallQuantity', data }) をそのまま使う。
//
// 受け渡しの手順（線形メモリの確保・解放）は core/src/abi.rs にある。

// 応答の先頭に付く「本体の長さ」（u32 リトルエンディアン）のバイト数。
const LENGTH_PREFIX = 4;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 読み込んだ計算実装。call() で JSON の要求を渡し、JSON の応答を受け取る。 */
class Core {
  constructor(exports) {
    this.exports = exports;
    this.version = this.call({ op: 'config' }).version;
  }

  /**
   * 計算実装を呼ぶ。失敗（入力の不備など）は Error として投げる。
   * 文面はそのまま画面に出せる日本語。
   */
  call(request) {
    const { memory, nac_alloc: alloc, nac_call: run, nac_free: free } = this.exports;
    const input = encoder.encode(JSON.stringify(request));

    const inputPointer = alloc(input.length);
    let responsePointer;
    try {
      new Uint8Array(memory.buffer, inputPointer, input.length).set(input);
      responsePointer = run(inputPointer, input.length);
    } finally {
      free(inputPointer, input.length);
    }

    // メモリは呼び出しの中で広がることがあり、そのとき前の buffer は切り離
    // される。必ず呼び出しの後に読み直す。
    const length = new DataView(memory.buffer).getUint32(responsePointer, true);
    const body = decoder.decode(
      new Uint8Array(memory.buffer, responsePointer + LENGTH_PREFIX, length)
    );
    free(responsePointer, LENGTH_PREFIX + length);

    const response = JSON.parse(body);
    if (!response.ok) throw new Error(response.error);
    return response;
  }

  /**
   * 釘配列パターン（グレー本 3.2）と壁（同 3.3）をまとめて計算し、
   * { patterns, walls } を返す。計算できないものは ok: false で返る。
   *
   * 壁は釘配列パターンの計算結果を使うので、1 回の呼び出しで両方を返す
   * （画面が順番を気にせずに済む）。
   */
  computeAll(data) {
    const { patterns, walls } = this.call({ op: 'computeAll', data });
    return { patterns, walls };
  }

  /**
   * グレー本 表 3.2.1「標準的なサイズの面材の釘配列諸定数」の配列一覧。
   * 選ぶための情報だけで、釘座標は preset() で組み立てる。
   */
  presets() {
    return this.call({ op: 'presets' }).presets;
  }

  /** 一覧の id を、そのまま面材 1 枚の割り付けとして入れられる形にする。 */
  preset(id) {
    return this.call({ op: 'preset', data: { id } }).panel;
  }

  /** 割り付けの型（川型・山型・ロ型・日型）の一覧。 */
  arrangements() {
    return this.call({ op: 'arrangements' }).arrangements;
  }

  /**
   * グレー本 表 3.3.1「面材釘 1 本あたりの一面せん断の数値」の一覧。
   * 壁の入力欄へ読み込んだあとは、数値を手で直せる（4.5 の試験値を使う場合）。
   */
  materials() {
    return this.call({ op: 'materials' }).materials;
  }

  /**
   * グレー本 表 3.3.2「面材のせん断強度及び曲げヤング係数」の一覧。
   * JAS 2 級の合板を使うときなど、規格だけを差し替えるために使う。
   */
  grades() {
    return this.call({ op: 'grades' }).grades;
  }
}

/**
 * wasm のバイト列から計算実装を組み立てる。
 *
 * この .wasm は外部から何も import しない（wasm-bindgen のようなグルーを
 * 挟んでいない）ので、ブラウザでもサーバでも同じ手順で動く。
 */
export async function instantiateCore(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return new Core(instance.exports);
}

/**
 * 計算実装を受け取って組み立てる。
 *
 * @param {string} url /config が知らせる URL（内容のハッシュ付き）
 * @param {(url: string) => Promise<ArrayBuffer>} fetchBytes 取得のしかた
 */
export async function loadCore(url, fetchBytes) {
  try {
    return await instantiateCore(await fetchBytes(url));
  } catch (error) {
    throw new Error(`計算エンジンを読み込めませんでした: ${error.message}`);
  }
}
