import { linkKey } from './links.ts';
import type { Addon } from './types.ts';
import { WIKI } from './wiki.ts';

/** Internal wiki pages need manual source-link review, regardless of other matches. */
export function isWikiPage(url: string): boolean {
	try {
		const page = new URL(url), wiki = new URL(WIKI);
		return ['https:', 'http:'].includes(page.protocol) && page.hostname.replace(/^www\./, '') === wiki.hostname && page.pathname.startsWith('/wiki/');
	} catch { return false; }
}

export interface ReviewNote {
	href?: string;
	label: string;
	value: string;
	tone?: 'warning' | 'danger';
}

/** A fork is a grouping suggestion only when its parent identifies one live page. */
export function publishedForkParent(parent: string | null | undefined, addons: Addon[]): Addon | undefined {
 if (!parent) return undefined;
 const key = linkKey(parent);
 const matches = addons.filter(a => a.versions.some(v => linkKey(v.url) === key));
 return matches.length === 1 ? matches[0] : undefined;
}

// Only explicit port and variant labels may surround a complete addon name.
const VARIANT_LABELS = ['tw', 'twow', 't wo w', 't wow', 'turtle', 'turtle wow', 'turtle wo w', 'for turtle wow', 'for turtle wo w', 'octo',
 'vanilla', 'vanilla port', 'classic api', '1 12', '1 12 1', 'fixed', 'revamped', 'opaque'];

function nameForms(name: string): Set<string> {
 const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').toLowerCase().match(/[a-z0-9]+/g) ?? [];
 const forms = new Set<string>();
 const visit = (parts: string[]) => {
  const key = parts.join('');
  if (key.length < 3 || forms.has(key)) return;
  forms.add(key);
  for (const label of VARIANT_LABELS) {
   const tokens = label.split(' ');
   if (tokens.length >= parts.length) continue;
   if (tokens.every((word, i) => parts[i] === word)) visit(parts.slice(tokens.length));
   if (tokens.every((word, i) => parts[parts.length - tokens.length + i] === word)) visit(parts.slice(0, -tokens.length));
  }
 };
 visit(words);
 return forms;
}

/** Match complete names after removing known port labels; ambiguous matches stay manual. */
export function similarAddon(name: string, addons: Addon[]): Addon | undefined {
 const wanted = nameForms(name);
 const plain = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
 const candidates = addons.flatMap(addon => {
  if (plain(name) === plain(addon.name)) return [];
  const shared = [...nameForms(addon.name)].filter(form => wanted.has(form));
  return shared.length ? [{addon, length: Math.max(...shared.map(form => form.length))}] : [];
 }).sort((a,b) => b.length - a.length);
 return candidates.length && candidates[0].length !== candidates[1]?.length ? candidates[0].addon : undefined;
}
