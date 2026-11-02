import type { Addon } from './types';

type Searchable = Pick<Addon, 'name' | 'description' | 'author' | 'versions'> & Partial<Pick<Addon, 'similar_addons'>>;
const compact = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Keep ordinary word matching, with space-insensitive matching for similar addon names. */
export function addonSearch(addon: Searchable, query: string) {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const text = `${addon.name} ${addon.description} ${addon.author} ${addon.versions.map(v => v.url).join(' ')}`.toLowerCase();
	const similar = (addon.similar_addons ?? '').split(',').map(s => s.trim()).filter(Boolean);
	const ordinary = words.every(word => text.includes(word));
	const wanted = compact(query);
	const nameMatch = wanted ? similar.find(name => compact(name).includes(wanted)) ?? '' : '';
	const combined = `${text} ${similar.join(' ').toLowerCase()}`;
	const combinedMatch = words.every(word => combined.includes(word));
	const hint = ordinary ? '' : nameMatch || (combinedMatch
		? similar.filter(name => words.some(word => name.toLowerCase().includes(word))).join(', ')
		: '');
	return { matches: ordinary || Boolean(nameMatch) || combinedMatch, hint };
}
