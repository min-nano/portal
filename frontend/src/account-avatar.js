// ヘッダーのアバターに出す画像を、Clerk のユーザーから選ぶ。
//
// user.imageUrl は、本人の写真が無いときは Clerk の既定の人型アイコンを返す
// （hasImage が false）。ただ、つないだ Google アカウントの写真が外部
// アカウント（externalAccounts）の側に残っていることがある（Clerk の設定や、
// 開発インスタンスの共有の OAuth 資格情報では、プロフィール画像へ写されない）。
// そのときはそちらを優先し、どちらも無ければ既定のアイコンを使う。

/**
 * @param {{ hasImage?: boolean, imageUrl?: string,
 *           externalAccounts?: { provider?: string, imageUrl?: string }[] }} user
 * @returns {string | undefined}
 */
export function avatarUrl(user) {
  if (user.hasImage && user.imageUrl) return user.imageUrl;
  const accounts = user.externalAccounts || [];
  const google = accounts.find((a) => a.provider === 'google' && a.imageUrl);
  return (google || accounts.find((a) => a.imageUrl))?.imageUrl || user.imageUrl || undefined;
}
