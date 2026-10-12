// Whether a link or a screenshot is on one of the sites members may use. The database
// decides; this is for saying so in the form before anything is sent.
// public.host_allowed() in the allowed hosts migration reads an address the same way,
// and a test compares the two: change both or neither.
import { IMAGE_HOSTS, LINK_HOSTS } from './config.ts';

const LISTS = { link: LINK_HOSTS, image: IMAGE_HOSTS } as const;

export function hostAllowed(url: string, kind: keyof typeof LISTS): boolean {
	// The site is what comes between "https://" and the first slash. An address that hides
	// another site in front of an "@", or uses a backslash, which browsers read as a
	// slash, is refused whatever it claims to be.
	const parts = /^https:\/\/([^/?#]+)([^?#]*)/.exec(url);
	if (!parts || url.includes('\\') || parts[1].includes('@')) return false;
	const host = parts[1]
		.replace(/:\d+$/, '')
		.replace(/^www\./i, '')
		.toLowerCase();
	const path = parts[2];
	return LISTS[kind].some((entry) => {
		// "*.name" stands for every site under that name.
		if (entry.startsWith('*.')) return host.endsWith(entry.slice(1));
		const slash = entry.indexOf('/');
		if (slash < 0) return host === entry;
		// "site/part" stands for that part of the site only, and an address that climbs
		// back out of it with ".." is not in it.
		const part = entry.slice(slash);
		return host === entry.slice(0, slash) && !/\.\.|%2e/i.test(path) && (path === part || path.startsWith(`${part}/`));
	});
}

/** "github.com, gitlab.com, codeberg.org", for telling someone which sites they may use. */
export const hostNames = (kind: keyof typeof LISTS) => LISTS[kind].join(', ');

