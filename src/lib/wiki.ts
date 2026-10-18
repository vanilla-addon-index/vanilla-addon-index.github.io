// Reads the addon list from the Turtle WoW wiki and turns each entry into a candidate
// for the import queue. Run by the nightly job and the dry run in scripts/.
import { MAX_IMAGES } from './config.ts';
import { uncamo } from './github.ts';
import { linkKey } from './links.ts';
import { request, type RequestMetrics } from './request.ts';

export const WIKI = 'https://turtle-wow.fandom.com';
export const WIKI_PAGE = 'Addons';
export const WIKI_NAME = 'Turtle WoW Wiki';

export interface Candidate {
	key: string;
	name: string;
	url: string;
	description: string;
	images: string[];
	// Other versions (forks) the wiki lists for the same addon.
	alts: string[];
	category: string;
	obsolete: boolean;
	// Name of the addon this one extends, for nested entries.
	parent: string | null;
	// Key of the entry this one is another version of, for the wiki's "Alt" links.
	group_key: string | null;
}

export interface WikiRead {
	revision: number;
	candidates: Candidate[];
	// Bullets that could not be turned into a candidate.
	problems: { problem: string; line: string }[];
	// Candidates that only appear in the SuperWoW and ClassicAPI tables.
	fromTables: number;
	// Links the wiki lists more than once.
	repeated: number;
}

const plain = (wikitext: string) =>
	wikitext
		.replace(/<nowiki>|<\/nowiki>|<big>|<\/big>|<br\s*\/?>/gi, '')
		.replace(/'{2,}/g, '')
		.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
		.replace(/\s+/g, ' ')
		.trim();

// [url label], [[url label]] and [url [label]] are all external links on this page.
const EXTERNAL = /\[+\s*(https?:\/\/[^\s\]]+)\s*((?:<nowiki>)?\s*\[?[^[\]]*\]?\s*(?:<\/nowiki>)?)\]+/g;
// A link to another page of the wiki. "[[https://… label]]" is not one: see EXTERNAL.
const INTERNAL = /^\[\[(?!https?:)([^\]|]+)(?:\|([^\]]+))?\]\]/;
//   |[url Name]
//   |Description
const TABLE_ROW = /^\|?\s*\[(https?:\/\/[^\s\]]+)\s+([^\]]+)\]/;

const httpsOnly = (urls: string[]) => urls.filter((u) => u.startsWith('https://'));

type Parsed = { entry: Candidate & { depth: number } } | { problem: string };

function parseBullet(line: string): Parsed {
	const depth = /^\*+/.exec(line)![0].length;
	// Square brackets inside <nowiki> are text, not link syntax.
	const body = line
		.slice(depth)
		.trim()
		.replace(/<nowiki>(.*?)<\/nowiki>/gi, (_, text: string) => text.replace(/\[/g, '(').replace(/\]/g, ')'));

	const links = [...body.matchAll(EXTERNAL)].map((m) => ({
		url: m[1],
		label: plain(m[2]).replace(/[[\]]/g, '').trim(),
		start: m.index,
		end: m.index + m[0].length
	}));

	let name: string;
	let url: string;
	let from: number;
	let extra = links;
	const internal = INTERNAL.exec(body);
	if (internal) {
		// The addon has its own page on the wiki instead of a repository.
		name = plain(internal[2] ?? internal[1]);
		url = `${WIKI}/wiki/${encodeURIComponent(internal[1].trim().replace(/ /g, '_'))}`;
		from = internal[0].length;
	} else if (links[0]?.start === 0) {
		name = links[0].label;
		url = links[0].url;
		from = links[0].end;
		extra = links.slice(1);
	} else {
		return { problem: 'does not start with a link' };
	}

	const description = plain(body.slice(from, extra[0]?.start ?? body.length)).replace(/^[-–—:\s]+/, '');

	const images: string[] = [];
	const alts: string[] = [];
	for (const link of extra) {
		const kind = link.label.replace(/[()]/g, '').trim();
		if (/^img/i.test(kind)) images.push(link.url);
		else if (/^alt/i.test(kind)) alts.push(link.url);
	}

	const obsolete = /\b(obsolete|deprecated|outdated|abandoned)\b/i.test(`${name} ${description}`);
	name = name.replace(/\s*\((obsolete|deprecated|outdated)\)\s*/i, '').trim();
	if (!name) return { problem: 'no name' };
	if (!url.startsWith('https://')) return { problem: 'link is not https' };

	return {
		entry: {
			key: linkKey(url),
			name,
			url,
			description,
			// A picture copied from a page on github.com came with the address of GitHub's image
			// proxy, which stops working; the address behind it does not.
			images: httpsOnly(images.map(uncamo)).slice(0, MAX_IMAGES),
			alts: httpsOnly(alts),
			category: '',
			obsolete,
			parent: null,
			group_key: null,
			depth
		}
	};
}

function section(wikitext: string, from: string, to: string) {
	const start = wikitext.indexOf(from);
	const end = wikitext.indexOf(to, start + from.length);
	if (start < 0 || end < 0) throw new Error(`The wiki page no longer has the section "${from}"`);
	return wikitext.slice(start + from.length, end);
}

function splitAt(text: string, heading: RegExp): [string, string] {
	const at = text.search(heading);
	return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at)];
}

export function parseWiki(wikitext: string): Omit<WikiRead, 'revision'> {
	const list = section(wikitext, '===Full Addons List===', '==SuperWoW Addons==');
	const superwow = section(wikitext, '==SuperWoW Addons==', '==ClassicAPI Addons==');
	const classicapi = section(wikitext, '==ClassicAPI Addons==', '==Further Addons Collections==');
	const [superRequired, superOptional] = splitAt(superwow, /gain additional features/i);
	const [classicRequired, classicOptional] = splitAt(classicapi, /gain additional features/i);
	const tables = [superRequired, superOptional, classicRequired, classicOptional];

	const byKey = new Map<string, Candidate>();
	const problems: WikiRead['problems'] = [];
	const parents: string[] = [];
	let repeated = 0;
	for (const line of list.split('\n')) {
		if (!line.startsWith('*')) continue;
		const parsed = parseBullet(line);
		if ('problem' in parsed) {
			problems.push({ problem: parsed.problem, line });
			continue;
		}
		const { depth, ...entry } = parsed.entry;
		// A nested bullet is an extension of the bullet above it.
		parents[depth] = entry.name;
		entry.parent = depth > 1 ? (parents[depth - 1] ?? null) : null;
		// The same repository listed twice on the wiki becomes one candidate.
		if (byKey.has(entry.key)) repeated++;
		else byKey.set(entry.key, entry);
	}

	// The SuperWoW and ClassicAPI sections are tables, and list addons the main list lacks.
	let fromTables = 0;
	for (const text of tables) {
		const lines = text.split('\n');
		lines.forEach((line, i) => {
			const row = TABLE_ROW.exec(line);
			if (!row || !row[1].startsWith('https://')) return;
			const key = linkKey(row[1]);
			if (byKey.has(key)) return;
			const next = lines[i + 1] ?? '';
			const description = /^\|(?!-|\})/.test(next) ? plain(next.slice(1)) : '';
			const name = plain(row[2]);
			byKey.set(key, {
				key,
				name,
				url: row[1],
				description,
				images: [],
				alts: [],
				category: '',
				obsolete: false,
				parent: null,
				group_key: null
			});
			fromTables++;
		});
	}

	// Each "Alt" link is another version of its entry. The wiki gives it no name or
	// description of its own, so it starts with the entry's name for an admin to adjust.
	for (const main of [...byKey.values()]) {
		for (const url of main.alts) {
			const key = linkKey(url);
			if (byKey.has(key)) continue;
			byKey.set(key, {
				key,
				name: main.name,
				url,
				description: '',
				images: [],
				alts: [],
				category: main.category,
				obsolete: false,
				parent: null,
				group_key: main.key
			});
		}
	}

	// Normalize display names across
	// bullets, tables, alternative versions and parent references alike.
	const candidates = [...byKey.values()].map((entry) => ({
		...entry,
		name: entry.name.replace(/\s+/g, ''),
		parent: entry.parent?.replace(/\s+/g, '') ?? null
	}));
	return { candidates, problems, fromTables, repeated };
}

export async function readWiki(observe?: (metrics: RequestMetrics) => void): Promise<WikiRead> {
	// origin=* lets a browser page call the API without the wiki's cookies.
	const { parse } = await request<{ parse: { wikitext: string; revid: number } }>(
		`${WIKI}/api.php?action=parse&page=${WIKI_PAGE}&prop=wikitext|revid&format=json&formatversion=2&origin=*`,
		{ observe, read: (response) => response.json() }
	);
	return { revision: parse.revid, ...parseWiki(parse.wikitext) };
}
