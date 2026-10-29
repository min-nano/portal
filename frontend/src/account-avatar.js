// ヘッダーのアバターに出す画像を、Clerk のユーザーから選ぶ。
//
// user.imageUrl は、本人の写真が無いときも Clerk の既定の人型アイコンを返す
// （hasImage が false）。それを出すより頭文字のほうが誰か分かるので、
// 既定のアイコンは使わない。
//
// 本人の写真が無くても、つないだ Google アカウントの写真は外部アカウント
// （externalAccounts）の側に残っていることがある（Clerk の設定や、開発
// インスタンスの共有の OAuth 資格情報では、プロフィール画像へ写されない）。
// そのときはそちらを使う。どちらも無ければ undefined（頭文字を出す）。

/**
 * @param {{ hasImage?: boolean, imageUrl?: string,
 *           externalAccounts?: { provider?: string, imageUrl?: string }[] }} user
 * @returns {string | undefined}
 */
export function avatarUrl(user) {
  if (user.hasImage && user.imageUrl) return user.imageUrl;
  const accounts = user.externalAccounts || [];
  const google = accounts.find((a) => a.provider === 'google' && a.imageUrl);
  return (google || accounts.find((a) => a.imageUrl))?.imageUrl || undefined;
}
