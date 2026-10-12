// What a visitor's list is made of: the snapshot the site was built with, and whatever
// was posted or edited since, which the database is asked for. Kept apart from the rest
// so that it can be tested without a browser; see tests/fresh.test.mjs.

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
export function mergeFresh<T extends Stamped>(snapshot: T[], kept: T[], fresh: T[]): T[] {
	const since = newestStamp(snapshot);
	const rows = new Map(snapshot.map((row) => [row.id, row]));
	for (const row of [...kept.filter((k) => k.updated_at > since), ...fresh]) rows.set(row.id, row);
	return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}
