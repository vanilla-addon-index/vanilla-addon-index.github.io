import type { Addon, CodeUpdate } from './types';

export function formatUpdateDate(date?: string): string | undefined {
	const timestamp = updateTimestamp(date);
	return timestamp === -Infinity ? undefined : new Date(timestamp).toISOString().slice(0, 10);
}

export function updateTimestamp(date?: string): number {
	const timestamp = Date.parse(date ?? '');
	return Number.isFinite(timestamp) ? timestamp : -Infinity;
}

export function newestCodeUpdate(updates: Iterable<CodeUpdate | null | undefined>): CodeUpdate | undefined {
	let newest: CodeUpdate | undefined;
	let latest = -Infinity;
	for (const update of updates) {
		if (!update) continue;
		const timestamp = updateTimestamp(update.date);
		if (timestamp > latest) {
			latest = timestamp;
			newest = update;
		}
	}
	return newest;
}

export function latestAddonCodeUpdate(addon: Partial<Pick<Addon, 'code_update' | 'link_code_updates'>>): CodeUpdate | undefined {
	return newestCodeUpdate([addon.code_update, ...Object.values(addon.link_code_updates ?? {})]);
}
