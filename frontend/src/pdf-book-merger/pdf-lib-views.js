// pdf-lib に、PDF の中のバイト列を写させない（書籍スキャン PDF 結合ツール）。
//
// pdf-lib は、PDF を読むとストリーム（スキャンの画像など）の中身を 1 つずつ
// 写し取り（ByteStream.slice）、頁を別の文書へ写すときにもう 1 度写す
// （PDFRawStream.clone）。数百 MB のスキャンの本を結合すると、元のファイル・
// 読んだ文書・写した文書・書き出した PDF で、本の何倍ものメモリを使い、
// iPhone・iPad ではページごと落ちた。
//
// pdf-lib はストリームの中身を読むだけで書き換えないので、写さずに元の
// バイト列の一部（subarray）を指させる。元のバイト列は、どのみち手元に
// 持っている（結合し直せるように）。これを読み込んだ時点で、pdf-lib 全体に効く。

import { PDFParser, PDFRawStream } from 'pdf-lib';

// ByteStream は公開されていないので、読み手の持っているものからたどる。
const ByteStream = PDFParser.forBytesWithOptions(new Uint8Array(0)).bytes.constructor;

ByteStream.prototype.slice = function slice(start, end) {
  return this.bytes.subarray(start, end);
};

PDFRawStream.prototype.clone = function clone(context) {
  return PDFRawStream.of(this.dict.clone(context), this.contents);
};
