// What search engines and link previews are told about each page. The build writes it into
// the page (see src/hooks.server.ts); the pages use the same titles once they are running.
import { SITE_NAME } from './config';
import type { Addon } from './types';

// Search results cut a description off at about this length.
const MAX_DESCRIPTION = 160;

function clip(text: string) {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > MAX_DESCRIPTION ? `${flat.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…` : flat;
}

export const HOME_TITLE = `${SITE_NAME} – addons for WoW 1.12.1 (Vanilla)`;
export const HOME_DESCRIPTION = 'Powered by the Turtle WoW Wiki · Refreshed daily.';
export const HOME_PREVIEW_TITLE = 'Addons for WoW 1.12.1 (Vanilla)';

export const ABOUT_TITLE = `About and privacy · ${SITE_NAME}`;
export const ABOUT_DESCRIPTION = `What ${SITE_NAME} is, who runs it, and what it stores about visitors and accounts.`;

// The words people search with: the addon's name, the game and its version.
export const addonTitle = (addon: Pick<Addon, 'name'>) => `${addon.name} – WoW 1.12.1 addon · ${SITE_NAME}`;

export function addonDescription(addon: Pick<Addon, 'name' | 'description' | 'author' | 'shared'>) {
	const blurb = addon.description.trim().split('\n')[0].replace(/[.\s]+$/, '');
	const description = blurb ? `${blurb}${/[!?]$/.test(blurb) ? '' : '.'}` : `${addon.name}.`;
	const author = addon.shared ? '' : addon.author.trim().replace(/\.+$/, '');
	return clip(`${description}${author ? ` By ${author}.` : ''}`);
}
