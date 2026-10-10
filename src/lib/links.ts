// Canonical form of a link, so different spellings of one repository compare equal.
// public.link_key() in supabase/versions.sql has the same rules; keep the two in step.
export function linkKey(url: string): string {
	const u = url
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\/(www\.)?/, '');
	const github = /^github\.com\/[^/?#]+\/[^/?#]+/.exec(u);
	if (github) return github[0].replace(/\.git$/, '');
	return u
		.replace(/[?#].*$/, '')
		.replace(/\/-\/.*$/, '')
		.replace(/\/+$/, '')
		.replace(/\.git$/, '');
}

/** "owner" for a github.com/owner/repo link, otherwise the host. */
export function linkOwner(url: string): string {
	const [host, owner] = linkKey(url).split('/');
	return host === 'github.com' && owner ? owner : host;
}
/**
 * Who to credit an addon to in a list: the author it was posted with, or else the owner
 * of its GitHub repository. Empty when neither is known, unless a name is needed to tell
 * same-named addons apart, in which case the host stands in.
 */
export function creditFor(addon: { author: string; repo_url: string }, needed = false): string {
	if (addon.author) return addon.author;
	const [host, owner] = linkKey(addon.repo_url).split('/');
	if (host === 'github.com' && owner) return owner;
	return needed ? host : '';
}
