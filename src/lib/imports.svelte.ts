import { createAddon, groupAddons, loadAddons } from './addons.svelte';
import { supabase } from './supabase';
import type { Addon, AddonInput } from './types';
import { type Candidate, readWiki } from './wiki';

export interface QueueItem extends Candidate {
	id: number;
	status: 'pending' | 'approved' | 'rejected';
	// Why the last approval attempt failed, if it did.
	problem: string | null;
}


export interface RepoStats {
	key: string;
	stars: number;
	pushed_at: string | null;
	archived: boolean;
	fork_of: string | null;
	missing: boolean;
	// The number in the addon's .toc file; 11200 means 1.12. Null when no .toc was found.
	interface: number | null;
	// The repository's current address, which differs from the key after a rename.
	canonical: string | null;
}

export const imports = $state({
	items: [] as QueueItem[],
	// What GitHub says about each repository, by link key. Empty until the nightly job has run.
	stats: {} as Record<string, RepoStats>,
	counts: { pending: 0, approved: 0, rejected: 0 },
	loaded: false,
	// Entries an admin turned down. Fetched only when that list is opened.
	rejected: [] as QueueItem[],
	rejectedLoaded: false
});

const PAGE = 1000;

function client() {
	if (!supabase) throw new Error('Database is not configured.');
	return supabase;
}

// The API returns at most 1000 rows per request.
async function all<T>(table: string, filter?: [string, string]): Promise<T[]> {
	const rows: T[] = [];
	for (let from = 0; ; from += PAGE) {
		let query = client().from(table).select('*');
		if (filter) query = query.eq(filter[0], filter[1]);
		const { data, error } = await query.order('key').range(from, from + PAGE - 1);
		if (error) throw new Error(error.message);
		rows.push(...(data as T[]));
		if (data.length < PAGE) return rows;
	}
}

async function count(status: QueueItem['status']) {
	const { count: n, error } = await client()
		.from('import_queue')
		.select('id', { count: 'exact', head: true })
		.eq('status', status);
	if (error) throw new Error(error.message);
	return n ?? 0;
}

export async function loadQueue() {
	const [items, stats, pending, approved, rejected] = await Promise.all([
		all<QueueItem>('import_queue', ['status', 'pending']),
		all<RepoStats>('repo_stats'),
		count('pending'),
		count('approved'),
		count('rejected')
	]);
	imports.items = items.sort(byName);
	imports.stats = Object.fromEntries(stats.map((s) => [s.key, s]));
	imports.counts = { pending, approved, rejected };
	imports.loaded = true;
}

const byName = (a: QueueItem, b: QueueItem) => a.name.localeCompare(b.name);

export async function loadRejected() {
	imports.rejected = (await all<QueueItem>('import_queue', ['status', 'rejected'])).sort(byName);
	imports.rejectedLoaded = true;
}

async function call<T>(name: string, args: Record<string, unknown>) {
	const { data, error } = await client().rpc(name, args);
	if (error) throw new Error(error.message);
	return data as T;
}

/** Reads the wiki and queues every addon that is neither live nor already reviewed. */
export async function fetchFromWiki() {
	const { candidates } = await readWiki();
	const added = await call<number>('queue_imports', { items: candidates });
	await loadQueue();
	return { found: candidates.length, added };
}

// Takes entries out of the list at once, so the page does not wait for the database or
// redraw the whole queue. Returns a function that puts them back.
function settle(ids: number[], as: 'approved' | 'rejected') {
	const before = { items: imports.items, counts: { ...imports.counts } };
	imports.items = imports.items.filter((item) => !ids.includes(item.id));
	const moved = before.items.length - imports.items.length;
	imports.counts.pending -= moved;
	imports.counts[as] += moved;
	return () => {
		imports.items = before.items;
		imports.counts = before.counts;
	};
}

/** Publishes entries as they are. Returns how many went live; the rest keep a reason. */
export async function approve(ids: number[]) {
	const undo = settle(ids, 'approved');
	try {
		const published = await call<number>('approve_imports', { ids });
		// Some stayed behind with a reason: fetch the queue again to show it.
		if (published < ids.length) await loadQueue();
		await loadAddons();
		return published;
	} catch (e) {
		await loadQueue().catch(undo);
		throw e;
	}
}

export async function reject(ids: number[]) {
	const turnedDown = imports.items.filter((item) => ids.includes(item.id));
	const undo = settle(ids, 'rejected');
	try {
		await call<number>('decide_imports', { ids, decision: 'rejected' });
		if (imports.rejectedLoaded) imports.rejected = [...imports.rejected, ...turnedDown].sort(byName);
	} catch (e) {
		await loadQueue().catch(undo);
		throw e;
	}
}

/** Puts rejected entries back in the queue. */
export async function restore(ids: number[]) {
	const back = imports.rejected.filter((item) => ids.includes(item.id));
	await call<number>('decide_imports', { ids, decision: 'pending' });
	imports.rejected = imports.rejected.filter((item) => !ids.includes(item.id));
	imports.items = [...imports.items, ...back.map((item) => ({ ...item, status: 'pending' as const }))].sort(byName);
	imports.counts.rejected -= back.length;
	imports.counts.pending += back.length;
}

/** Publishes a queued entry straight into the group of an addon that is already live. */
export async function approveInto(item: QueueItem, addon: Addon) {
	const undo = settle([item.id], 'approved');
	try {
		await call('approve_into', { queue_id: item.id, target: addon.id });
		await loadAddons();
	} catch (e) {
		await loadQueue().catch(undo);
		throw e;
	}
}

/**
 * Publishes a queued entry as an admin changed it on the review page, optionally straight
 * into the group of a live addon. It is posted like any addon, then marked as imported.
 */
export async function publishEdited(item: QueueItem, input: AddonInput, into?: Addon) {
	const addon = await createAddon(input);
	await call('mark_imported', { queue_id: item.id, target: addon.id, credit: true });
	settle([item.id], 'approved');
	// Either one reloads the list, which brings in the credit and the wiki's own grouping.
	if (into) await groupAddons([into.id, addon.id]);
	else await loadAddons();
}
