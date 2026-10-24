import type { AddonInput } from './types.ts';

const singleLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const escapeText = (text: string) => singleLine(text).replace(/[&<>\[\]{}|']/g, char => `&#${char.charCodeAt(0)};`);
const safeUrl = (text: string) => {
	try {
		const url = new URL(text.trim());
		return /^https?:$/.test(url.protocol) ? url.href.replace(/[\[\]{}|']/g, char => encodeURIComponent(char).replace(/'/g, '%27')) : '';
	} catch { return ''; }
};

export function wikiSubmission(addon: AddonInput) {
	const name = singleLine(addon.name);
	const description = singleLine(addon.description);
	const url = safeUrl(addon.versions[0]?.url ?? '');
	const images = addon.images.map(safeUrl).filter(Boolean);
	return {
		name, description, url, images,
		href: 'https://turtle-wow.fandom.com/wiki/Addons?veaction=edit',
		markup: `${url ? `[${url} ${escapeText(name)}]` : escapeText(name)} - ${escapeText(description)}${images.map((image, i) => ` [${image} [Img${i + 1}]]`).join('')}`
	};
}
