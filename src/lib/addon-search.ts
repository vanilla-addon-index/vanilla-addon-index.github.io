import type { Addon } from './types';

type Searchable = Pick<Addon, 'name' | 'description' | 'author' | 'versions'> & Partial<Pick<Addon, 'similar_addons'>>;
const compact = (lowercase: string) => lowercase.replace(/[^a-z0-9]/g, '');

export function prepareAddonQuery(query: string) {
	const lowercase = query.toLowerCase();
	return { words: lowercase.split(/\s+/).filter(Boolean), compactName: compact(lowercase) };
}

export function prepareAddonSearch(addon: Searchable) {
	const text = `${addon.name} ${addon.description} ${addon.author} ${addon.versions.map(v => v.url).join(' ')}`.toLowerCase();
	const similar = (addon.similar_addons ?? '').split(',').map(name => name.trim()).filter(Boolean).map(name => {
		const lowercase = name.toLowerCase();
		return { name, lowercase, compactName: compact(lowercase) };
	});
	return { text, similar, similarText: similar.map(entry => entry.lowercase).join(' ') };
}

type PreparedAddon = ReturnType<typeof prepareAddonSearch>;
type PreparedQuery = ReturnType<typeof prepareAddonQuery>;

const similarNameMatch = (addon: PreparedAddon, { compactName }: PreparedQuery) =>
	compactName ? addon.similar.find(entry => entry.compactName.includes(compactName)) : undefined;

const matchesWords = (addon: PreparedAddon, { words }: PreparedQuery) =>
	words.every(word => addon.text.includes(word) || addon.similarText.includes(word));

export function matchesAddonSearch(addon: PreparedAddon, query: PreparedQuery) {
	return matchesWords(addon, query) || Boolean(similarNameMatch(addon, query));
}

/** Keep ordinary word matching, with space-insensitive matching for similar addon names. */
export function addonSearch(addon: Searchable, query: string) {
	const prepared = prepareAddonSearch(addon);
	const terms = prepareAddonQuery(query);
	if (terms.words.every(word => prepared.text.includes(word))) return { matches: true, hint: '' };
	const nameMatch = similarNameMatch(prepared, terms);
	if (nameMatch) return { matches: true, hint: nameMatch.name };
	if (!matchesWords(prepared, terms)) return { matches: false, hint: '' };
	const hint = prepared.similar
		.filter(entry => terms.words.some(word => entry.lowercase.includes(word)))
		.map(entry => entry.name)
		.join(', ');
	return { matches: true, hint };
}
