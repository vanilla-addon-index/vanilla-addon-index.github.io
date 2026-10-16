// What a visitor's list is made of: the snapshot the site was built with, and whatever
// was posted or edited since, which the database is asked for. Kept apart from the rest
// so that it can be tested without a browser; see tests/app/fresh.test.mjs.

type Stamped = { id: number; name: string; updated_at: string };

/**
 * The moment the snapshot stands for: the newest "updated" stamp in it. Anything the
 * database holds with a later one was posted or edited after the snapshot was taken.
 * The stamps all come from the database in one format, so they compare as text.
 */
export const newestStamp = (snapshot: Pick<Stamped, 'updated_at'>[]) =>
	snapshot.reduce((newest, row) => (row.updated_at > newest ? row.updated_at : newest), '');

/**
 * The snapshot with the newer rows laid over it: a row with an id the snapshot has
 * replaces it, any other is added. "kept" is what this browser fetched on an earlier
 * visit and "fresh" what it fetched just now; of the kept ones only those still newer
 * than the snapshot count, so that one deleted since drops out with the next snapshot
 * instead of staying in this browser for good. Sorted by name, like the snapshot.
 */
export function mergeFresh<T extends Stamped>(snapshot: T[], kept: T[], fresh: T[], gone: number[] = []): T[] {
	const since = newestStamp(snapshot);
	const rows = new Map(snapshot.map((row) => [row.id, row]));
	for (const row of [...kept.filter((k) => k.updated_at > since), ...fresh]) rows.set(row.id, row);
	// What was deleted in this browser, which the snapshot still lists.
	for (const id of gone) rows.delete(id);
	return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Of the addons deleted in this browser, the ones worth remembering: those the snapshot
 * still lists. Once a snapshot no longer has one there is nothing left to hide, and an
 * id restored from the trash by then is free to show again.
 */
export function stillGone(gone: number[], snapshot: Pick<Stamped, 'id'>[]): number[] {
	const listed = new Set(snapshot.map((row) => row.id));
	return [...new Set(gone)].filter((id) => listed.has(id));
}
