// Content-Disposition ヘッダーの解釈（DOM・認証に依存しない純粋関数）。

/** Content-Disposition の filename*（RFC 5987）からファイル名を取り出す。 */
export function fileNameFromDisposition(disposition) {
  const match = /filename\*=UTF-8''([^;]+)/i.exec(disposition || '');
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
