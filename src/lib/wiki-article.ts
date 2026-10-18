import { linkKey } from './links.ts';
import { hostAllowed } from './hosts.ts';
import { WIKI } from './wiki.ts';

export interface ArticleLink { url: string; recommended: boolean }

export function repositoryUrl(value: string): string | null {
	try {
		const url = new URL(value.trim());
		if (url.protocol !== 'https:' || url.username || url.password || !hostAllowed(url.href, 'link')) return null;
		if (url.pathname.split('/').filter(Boolean).length < 2) return null;
		url.hash = '';
		return url.href;
	} catch { return null; }
}

/** Only download/source sections are suggestions; dependencies and prose are excluded. */
export function articleLinks(text: string): ArticleLink[] {
	let section = false;
	const links = new Map<string, ArticleLink>();
	for (const line of text.split('\n')) {
		const heading = /^(={2,6})\s*(.*?)\s*\1\s*$/.exec(line.trim());
		if (heading) { section = /\b(git links?|downloads?|source(?: code)?|repositories|github|versions?|forks?)\b/i.test(heading[2]); continue; }
		if (!section || !/^\s*[*#|]/.test(line)) continue;
		for (const match of line.matchAll(/\[(https:\/\/[^\s\]]+)(?:\s+([^\]]*))?\]/g)) {
			const url = repositoryUrl(match[1]);
			if (!url || links.has(linkKey(url))) continue;
			const recommended = /\brecommended\b/i.test(line);
			links.set(linkKey(url), { url, recommended });
		}
	}
	return [...links.values()];
}

export async function readArticle(url: string): Promise<{ links: ArticleLink[]; revision: number }> {
	const page = new URL(url);
	if (page.origin !== WIKI || !page.pathname.startsWith('/wiki/')) throw new Error('Expected a Turtle WoW Wiki article.');
	const title = decodeURIComponent(page.pathname.slice(6));
	const response = await fetch(`${WIKI}/api.php?${new URLSearchParams({ action: 'parse', page: title, prop: 'wikitext|revid', format: 'json', formatversion: '2', origin: '*' })}`, { signal: AbortSignal.timeout(15000) });
	if (!response.ok) throw new Error('The wiki could not be read. Paste repository links below instead.');
	const data = await response.json();
	if (typeof data.parse?.wikitext !== 'string' || typeof data.parse?.revid !== 'number') throw new Error('No article text returned. Paste repository links below instead.');
	return { links: articleLinks(data.parse.wikitext), revision: data.parse.revid };
}
