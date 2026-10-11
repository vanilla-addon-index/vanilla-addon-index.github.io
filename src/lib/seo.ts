// What search engines and link previews are told about each page. The build writes it into
// the page (see src/hooks.server.ts); the pages use the same titles once they are running.
import { SITE_NAME, SITE_TAGLINE } from './config';
import type { Addon } from './types';

// Search results cut a description off at about this length.
const MAX_DESCRIPTION = 160;

function clip(text: string) {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > MAX_DESCRIPTION ? `${flat.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…` : flat;
}

export const HOME_TITLE = `${SITE_NAME} – addons for WoW 1.12.1 (Vanilla)`;
export const HOME_DESCRIPTION = `${SITE_TAGLINE} Browse and search community addons for World of Warcraft 1.12.1 (Vanilla), each with a link to its source.`;

// The words people search with: the addon's name, the game and its version.
export const addonTitle = (addon: Pick<Addon, 'name'>) => `${addon.name} – WoW 1.12.1 addon · ${SITE_NAME}`;

export function addonDescription(addon: Pick<Addon, 'name' | 'description' | 'category' | 'author'>) {
	const blurb = addon.description.trim().split('\n')[0].replace(/[.\s]+$/, '');
	const what = `${addon.category} addon for World of Warcraft 1.12.1 (Vanilla)${addon.author ? ` by ${addon.author}` : ''}.`;
	return clip(blurb ? `${blurb}. ${what}` : `${addon.name}: ${what}`);
}
