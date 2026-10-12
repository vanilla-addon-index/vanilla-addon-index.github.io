// Reads the addon list from the Turtle WoW wiki and turns each entry into a candidate
// for the import queue. Run by the nightly job and the dry run in scripts/.
import { CATEGORIES, DEFAULT_CATEGORY, MAX_IMAGES } from './config.ts';
import { uncamo } from './github.ts';
import { linkKey } from './links.ts';

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

// First match wins, so the specific rules come before the broad ones: an addon for one
// class is filed under Class even though it is also about combat. The rules are tried on
// the name, the name with its joined-up words apart ("RaidSummon" is also "Raid Summon"),
// and the description. tests/wiki.test.mjs pins what they make of the whole wiki page.
const CATEGORY_RULES: [(typeof CATEGORIES)[number], RegExp][] = [
	['Libraries', /\b[Ll]ib[A-Z]\w+/],
	['Libraries', /\b(library|libraries|ace2|ace ?addon|embedded)\b/i],
	['Boss Mods', /\b(boss ?mods?|boss(es)?\b|bigwigs|dbm|deadly boss|encounters?\b|raid warnings?\b|loatheb|c'?thun|nefarian|four horsemen|4hm)/i],
	['Unit Frames', /\b(unit ?frames?|unitframes|raid ?frames?|party ?frames?|target ?frames?|player ?frames?|focus ?frames?|pet ?frames?|name ?plates?|plates|portraits?|health ?bars?)\b/i],
	['Action Bars', /\b(action ?bars?|action ?buttons?|bar mod|bongos|keybind(s|ings?)?|bindings?|buttons?)\b/i],
	['Bags & Inventory', /\b(bags?|inventory|bank|containers?|sort(s|ing)? (your )?items?|equipment|outfits?|outfitter|trinkets?|durability)\b/i],
	['Auction & Economy', /\b(auctions?|auctioneer|auctionator|ah|vendors?|vending|merchants?|gold|money|cash|prices?|sell(s|er)?|buy(s|ing)?|market|mail(box|s)?)\b/i],
	['Map & Minimap', /\b(mini-?maps?|world ?maps?|maps?|coordinates?|waypoints?|compass|flight|gather(er|ing)? nodes?)\b/i],
	['Quests & Leveling', /\b(quests?|questing|questie|leveling|level(s|ed)? ?up|xp|exp|experience|reputation|guides?|attune(ment)?s?|achievements?)\b/i],
	['Buffs & Debuffs', /\b(buffs?|debuffs?|auras?|dots?|hots?|crowd control|absor(b|ption)s?)\b/i],
	['Chat & Social', /\b(chat|chan(nel)?s?|whispers?|messenger|guild|friends?|social|emotes?|invites?|ignore|anti-?spam|spammers|goldspam|lfm|lfg|bulletin|translat(e|ion|or)|rp|role-?play(ing)?)\b/i],
	['Tooltip', /\b(game ?)?tool-?tips?\b/i],
	['Professions', /\b(professions?|trade ?skills?|craft(s|ing)?|recipes?|fishing|herbs?|herbalism|minerals?|mining|enchanting|disenchant(s|ing)?|alchemy|cooking)\b/i],
	['PvP', /\b(pvp|battlegrounds?|battlefield|bg|arena|honor|flags?|enemy players?)\b/i],
	['Class', /\b(warriors?|paladins?|pally|hunters?|rogues?|priests?|shamans?|mages?|warlocks?|druids?|feral|totems?|pets?|stance|shapeshift(ed|ing)?|shift|talents?|brainwash(er|ing)?|poisons?|shards?|soulstones?|curses?|librams?|combo points?|feign)\b/i],
	['Raid & Party', /\b(raids?|raider|party|loot(ing)?|rolls?|dkp|epgp|groups?|assignments?|ready check|heal(s|er|ers|ing)?|tanks?)\b/i],
	['Combat', /\b(combat|damage|dps|threat|aggro|cast(s|ing)? ?bars?|cast(s|ing)?|spells?|swing ?timers?|cooldowns?|meter|crit|attack|interrupts?|procs?|rage|energy|mana|kills?|taunts?)\b/i],
	// Late, so that an addon that only mentions macros is filed by what it is for.
	['Action Bars', /\bmacros?\b/i],
	['Interface Suites', /\b(full (ui|interface)|ui (replacement|overhaul|compilation|pack)|replacement for the original|complete (vanilla )?ui|comprehensive ui|interface suite|collection of interface)\b/i],
	// ElvUI, pfUI, SpartanUI: a name that ends in a capital "UI".
	['Interface Suites', /[a-zI]UI\b/]
];

// "AdvancedTradeSkillWindow2" -> "Advanced Trade Skill Window 2"
const apart = (name: string) => name.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/[_-]+/g, ' ');

const guessCategory = (name: string, description: string) => {
	const text = `${name} ${apart(name)} ${description}`;
	return CATEGORY_RULES.find(([, rule]) => rule.test(text))?.[0] ?? DEFAULT_CATEGORY;
};

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
			category: guessCategory(name, description),
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
				category: guessCategory(name, description),
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

	return { candidates: [...byKey.values()], problems, fromTables, repeated };
}

export async function readWiki(): Promise<WikiRead> {
	// origin=* lets a browser page call the API without the wiki's cookies.
	const res = await fetch(
		`${WIKI}/api.php?action=parse&page=${WIKI_PAGE}&prop=wikitext|revid&format=json&formatversion=2&origin=*`
	);
	if (!res.ok) throw new Error(`The wiki answered ${res.status}`);
	const { parse } = (await res.json()) as { parse: { wikitext: string; revid: number } };
	return { revision: parse.revid, ...parseWiki(parse.wikitext) };
}
