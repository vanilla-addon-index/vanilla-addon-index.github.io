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

/**
 * Where on GitHub a link points: the repository and, when the link names them, the branch
 * and the folder or file in it. In the spelling the link has, which is what GitHub needs:
 * a key is all lower case. Nothing for a link that is not to GitHub.
 */
export function githubPlace(url: string): { owner: string; name: string; ref: string; path: string } | null {
	const parts = /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)(?:\/(?:tree|blob)\/([^/?#]+)(?:\/([^?#]*))?)?/i.exec(url.trim());
	if (!parts) return null;
	const part = (text = '') => {
		try {
			return decodeURIComponent(text);
		} catch {
			return text;
		}
	};
	return {
		owner: parts[1],
		name: parts[2].replace(/\.git$/i, ''),
		// A link that names no branch is to the one the repository shows first.
		ref: part(parts[3]),
		path: part(parts[4]).replace(/\/+$/, '')
	};
}

// The sites whose links read host/owner/repository: every site a member's link may be on.
const OWNER_FIRST = ['github.com', 'gitlab.com', 'codeberg.org', 'gitea.com', 'octowow.st'];

/**
 * Who a repository belongs to, spelled the way its link spells it: "Artur91425" for
 * gitlab.com/Artur91425/Automaton. Nothing for a link that names no owner or is on some
 * other site. public.link_author() in the link author migration has the same rules, and
 * a test compares the two: change both or neither.
 */
export function linkAuthor(url: string): string {
	const parts = /^(?:https?:\/\/)?(?:www\.)?([^/?#]+)\/([^?#]*)/i.exec(url.trim());
	if (!parts) return '';
	const host = parts[1].toLowerCase();
	let path = parts[2].split('/').filter(Boolean);
	// octowow.st keeps its repositories under /git.
	if (host === 'octowow.st') path = path[0]?.toLowerCase() === 'git' ? path.slice(1) : [];
	return OWNER_FIRST.includes(host) && path.length >= 2 ? path[0] : '';
}

/** Who owns the repository a link points to, otherwise the host. */
export function linkOwner(url: string): string {
	return linkAuthor(url) || linkKey(url).split('/')[0];
}
/**
 * Who to credit an addon to in a list: the author it was posted with, or else the owner
 * of its repository. Empty when neither is known, unless a name is needed to tell
 * same-named addons apart, in which case the host stands in.
 */
export function creditFor(addon: { author: string; repo_url: string }, needed = false): string {
	return addon.author || linkAuthor(addon.repo_url) || (needed ? linkKey(addon.repo_url).split('/')[0] : '');
}
