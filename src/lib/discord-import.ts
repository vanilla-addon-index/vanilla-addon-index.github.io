import { unzipSync, strFromU8 } from 'fflate';
import { repositoryUrl } from './wiki-article.ts';
import { linkKey } from './links.ts';

export interface DiscordCandidate {
	url: string;
	name: string;
	description: string;
}
export interface DiscordPreview {
	items: DiscordCandidate[];
	files: number;
	starters: number;
	skipped: number;
}
const LIMIT = 50 * 1024 * 1024;

/** Read only proven thread starters; array order and author identity do not prove an opener. */
export function discordMessages(data: unknown): DiscordCandidate[] | null {
	const messages = Array.isArray(data) ? data : (data as { messages?: unknown } | null)?.messages;
	if (!Array.isArray(messages)) throw new Error('Expected a Discord message array or an object containing messages.');
	const channel = (data as { channel?: { id?: string } } | null)?.channel?.id;
	const opener = messages.find(m => m && typeof m.id === 'string' && /^\d+$/.test(m.id) && m.id === (m.channel_id ?? channel) && typeof m.content === 'string');
	if (!opener) return null;
	const content: string = opener.content;
	const items = new Map<string, DiscordCandidate>();
	for (const match of content.matchAll(/https:\/\/[^\s<>\[\]()`"*]+/g)) {
		const url = repositoryUrl(match[0].replace(/[.,;:!?]+$/, ''));
		if (!url) continue;
		const key = linkKey(url);
		// Use the repository name; a Discord headline often includes a full marketing description.
		const address = new URL(url);
		const parts = address.pathname.split('/').filter(Boolean);
		const octowow = address.hostname.replace(/^www\./, '') === 'octowow.st';
		if (octowow && parts.length < 3) continue;
		const name = decodeURIComponent(parts[octowow ? 2 : 1]).replace(/\.git$/i, '').slice(0, 120);
		items.set(key, { url, name, description: content.trim().slice(0, 5000) });
	}
	return [...items.values()];
}

/** ZIP contents stay in memory; attachments and non-JSON files are never extracted. */
export function readDiscordExport(filename: string, bytes: Uint8Array): DiscordPreview {
	if (bytes.length > LIMIT) throw new Error('Choose an export smaller than 50 MB.');
	let files: Record<string, Uint8Array>;
	if (/\.zip$/i.test(filename)) {
		let size = 0;
		files = unzipSync(bytes, { filter(entry) {
			if (!entry.name.toLowerCase().endsWith('.json')) return false;
			size += entry.originalSize;
			if (size > LIMIT) throw new Error('The expanded JSON exceeds 50 MB.');
			return true;
		} });
	} else if (/\.json$/i.test(filename)) files = { [filename]: bytes };
	else throw new Error('Choose a ZIP or JSON export.');
	const result: DiscordPreview = { items: [], files: 0, starters: 0, skipped: 0 };
	const items = new Map<string, DiscordCandidate>();
	for (const [name, contents] of Object.entries(files)) {
		result.files++;
		let found;
		try { found = discordMessages(JSON.parse(strFromU8(contents).replace(/^\uFEFF/, ''))); }
		catch { throw new Error(`Could not read Discord messages in ${name}. Nothing was imported.`); }
		if (found === null) { result.skipped++; continue; }
		result.starters++;
		for (const item of found) if (!items.has(linkKey(item.url))) items.set(linkKey(item.url), item);
	}
	if (!result.files) throw new Error('No JSON exports found.');
	result.items = [...items.values()];
	return result;
}
