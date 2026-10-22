import { loadAddons } from './addons.svelte';
import { supabase } from './supabase';
import { auth } from './auth.svelte';
import type { Addon, AddonInput } from './types';
import type { Candidate } from './wiki';
import { readArticle, type ArticleLink } from './wiki-article.ts';
import { isWikiPage } from './import-review.ts';

export interface QueueItem extends Candidate {
	source?: string;
	id: number;
	rejected_by_owner: boolean;
	status: 'pending' | 'approved' | 'rejected' | 'submitted' | 'dead';
	// Why the last approval attempt failed, if it did.
	problem: string | null;
	wiki_source?: string | null;
	wiki_recommended?: boolean;
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
	counts: { pending: 0, approved: 0, rejected: 0, submitted: 0, dead: 0 },
	loaded: false,
	// Entries an admin turned down. Fetched only when that list is opened.
	rejected: [] as QueueItem[],
	rejectedLoaded: false,
	dead: [] as QueueItem[],
	wikiReading: {} as Record<number, boolean>,
	wikiErrors: {} as Record<number, string>
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
	let query = client()
		.from('import_queue')
		.select('id', { count: 'exact', head: true })
		.eq('status', status);
	if (status === 'approved') query = query.eq('wiki_expanded', false);
	const { count: n, error } = await query;
	if (error) throw new Error(error.message);
	return n ?? 0;
}

export async function loadQueue() {
	const [items, stats, pending, approved, rejected, submitted, dead] = await Promise.all([
		all<QueueItem>('import_queue', ['status', 'pending']),
		all<RepoStats>('repo_stats_current'),
		count('pending'),
		count('approved'),
		count('rejected'),
		count('submitted'),
		all<QueueItem>('import_queue', ['status', 'dead'])
	]);
	imports.items = items.sort(byName);
	imports.stats = Object.fromEntries(stats.map((s) => [s.key, s]));
	imports.dead = dead.sort(byName);
	imports.counts = { pending, approved, rejected, submitted, dead: dead.length };
	imports.loaded = true;
	void expandWaitingArticles();
}

const attemptedArticles = new Set<number>();
let expanding = false;
async function expandWaitingArticles() {
	if (expanding || !auth.isAdmin) return;
	expanding = true;
	try {
		const articles = imports.items.filter(item => isWikiPage(item.url) && !attemptedArticles.has(item.id));
		for (let i = 0; i < articles.length; i += 3) {
			await Promise.all(articles.slice(i, i + 3).map(item => expandArticle(item)));
		}
	} finally { expanding = false; }
}

export async function expandArticle(item: QueueItem, pasted?: ArticleLink[]) {
	attemptedArticles.add(item.id);
	imports.wikiReading[item.id] = true;
	imports.wikiErrors[item.id] = '';
	try {
		const article = pasted ? null : await readArticle(item.url);
		const links = pasted ?? article!.links;
		if (!links.length) throw new Error('No download links found. Paste repository links below or open the wiki article to check.');
		const nameKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
		const changedTitle = article?.redirected && article.title && nameKey(article.title) !== nameKey(item.name);
		await call('expand_wiki_article', { queue_id: item.id, links,
			article_name: changedTitle ? article.title : null,
			article_description: changedTitle ? article.description : null });
		await loadQueue();
	} catch(e) { imports.wikiErrors[item.id] = (e as Error).message; }
	finally { imports.wikiReading[item.id] = false; }
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
		if (imports.rejectedLoaded) imports.rejected = [...imports.rejected, ...turnedDown.map(item => ({ ...item, status: 'rejected' as const, rejected_by_owner: auth.isOwner }))].sort(byName);
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
	imports.items = [...imports.items, ...back.map((item) => ({ ...item, status: 'pending' as const, rejected_by_owner: false }))].sort(byName);
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
	await call('publish_import', { queue_id: item.id, input, destination: into?.id ?? null });
	settle([item.id], 'approved');
	await loadAddons();
}
