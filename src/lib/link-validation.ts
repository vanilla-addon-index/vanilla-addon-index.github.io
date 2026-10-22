/** Specific guidance shared by repository link fields. Host policy stays with the caller. */
export function linkError(value: string): string {
	const link = value.trim();
	if (!link) return 'Paste a link to the addon’s repository, for example https://github.com/author/addon.';
	let url: URL;
	try { url = new URL(link); }
	catch { return 'Enter a complete link, for example https://github.com/author/addon.'; }
	if (url.protocol !== 'https:') return 'Use a secure link starting with https://, for example https://github.com/author/addon.';
	if (!url.hostname.includes('.') || url.username || url.password || /\s|\\/.test(link)) return 'Enter a valid repository link, for example https://github.com/author/addon.';
	return '';
}
