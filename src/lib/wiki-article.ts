import { linkKey, repositoryLink } from './links.ts';
import { hostAllowed } from './hosts.ts';
import { WIKI } from './wiki.ts';

export interface ArticleLink { url: string; recommended: boolean }

export function repositoryUrl(value: string): string | null {
	try {
		const url = new URL(value.trim());
		if (url.protocol !== 'https:' || url.username || url.password || !hostAllowed(url.href, 'link')) return null;
		if (url.pathname.split('/').filter(Boolean).length < 2) return null;
		url.hash = '';
		return repositoryLink(url.href);
	} catch { return null; }
}

/** Only download/source sections are suggestions; dependencies and prose are excluded. */
export function articleLinks(text: string): ArticleLink[] {
	let section: 'source' | 'install' | null = null;
	const links = new Map<string, ArticleLink>();
	const installation = new Map<string, ArticleLink>();
	for (const line of text.split('\n')) {
		const heading = /^(={2,6})\s*(.*?)\s*\1\s*$/.exec(line.trim());
		if (heading) {
			section = /\b(git links?|downloads?|source(?: code)?|repositories|github|versions?|forks?)\b/i.test(heading[2]) ? 'source'
				: /\b(installation|how to install)\b/i.test(heading[2]) ? 'install' : null;
			continue;
		}
		if (!section) continue;
		for (const match of line.matchAll(/\[(https:\/\/[^\s\]]+)(?:\s+([^\]]*))?\]/g)) {
			const url = repositoryUrl(match[1]);
			const found = section === 'source' ? links : installation;
			if (!url || found.has(linkKey(url))) continue;
			const recommended = /\brecommended\b/i.test(line);
			found.set(linkKey(url), { url, recommended });
		}
	}
	// Prefer the curated source list. Installation is a fallback, never extra versions.
	return [...(links.size ? links : installation).values()];
}

export async function readArticle(url: string): Promise<{ links: ArticleLink[]; revision: number; title?: string; redirected: boolean; description: string }> {
	const page = new URL(url);
	if (page.origin !== WIKI || !page.pathname.startsWith('/wiki/')) throw new Error('Expected a Turtle WoW Wiki article.');
	const title = decodeURIComponent(page.pathname.slice(6));
	const response = await fetch(`${WIKI}/api.php?${new URLSearchParams({ action: 'parse', page: title, prop: 'wikitext|revid', format: 'json', formatversion: '2', origin: '*', redirects: '1' })}`, { signal: AbortSignal.timeout(15000) });
	if (!response.ok) throw new Error('The wiki could not be read. Paste repository links below instead.');
	const data = await response.json();
	if (typeof data.parse?.wikitext !== 'string' || typeof data.parse?.revid !== 'number') throw new Error('No article text returned. Paste repository links below instead.');
	if (/^\s*#redirect\b/i.test(data.parse.wikitext)) throw new Error('The wiki redirect could not be resolved. Open the article to check its download links.');
	const description = data.parse.wikitext.split(/\n\s*\n|\n\s*==/)[0]
		.replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, '$1')
		.replace(/\[https?:\/\/[^\s\]]+\s+([^\]]+)\]/g, '$1')
		.replace(/'{2,}|<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 5000);
	return { links: articleLinks(data.parse.wikitext), revision: data.parse.revid,
		title: typeof data.parse.title === 'string' ? data.parse.title : undefined,
		redirected: Array.isArray(data.parse.redirects) && data.parse.redirects.length > 0, description };
}
