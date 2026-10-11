// Canonical form of a link, so different spellings of one repository compare equal.
// public.link_key() in the folder links migration has the same rules, and a test compares
// the two: change both or neither.
export function linkKey(url: string): string {
	const u = url
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\/(www\.)?/, '')
		.replace(/[?#].*$/, '');
	const github = /^github\.com\/[^/]+\/[^/]+/.exec(u);
	if (github) {
		const repo = github[0].replace(/\.git$/, '');
		// A link into a folder or file is that folder, since some repositories hold many
		// addons. The branch it is read from is not part of it; a link to a branch alone
		// is the repository.
		const folder = /^\/(?:tree|blob)\/[^/]+\/(.*[^/])\/*$/.exec(u.slice(github[0].length))?.[1];
		return folder ? `${repo}/${folder}` : repo;
	}
	return u
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
