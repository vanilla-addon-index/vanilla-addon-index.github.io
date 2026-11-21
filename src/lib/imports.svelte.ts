import { loadAddons, plainName } from './addons.svelte';
import { supabase } from './supabase';
import { auth } from './auth.svelte';
import { refreshAdminBadges, trackImportBadge } from './admin-badges.svelte';
import type { Addon, AddonInput } from './types';
import type { Candidate } from './wiki';
import { readArticle, type ArticleLink } from './wiki-article.ts';
import { isWikiPage } from './import-review.ts';

export interface QueueItem extends Candidate {
	entry_type?: 'addon' | 'dll';
	source?: string;
	id: number;
	sort_name?: string;
	rejected_by_owner: boolean;
	status: 'pending' | 'approved' | 'rejected' | 'submitted' | 'dead';
	// Why the last approval attempt failed, if it did.
	problem: string | null;
	readme_checked_at?: string | null;
	wiki_source?: string | null;
	wiki_recommended?: boolean;
	mirror_source?: string | null;
	mirror_addon_id?: number | null;
	mirror_source_unavailable?: boolean;
	same_name_count?: number;
	review_bucket?: 'fine' | 'duplicate' | 'incomplete' | 'wiki';
	review_stats?: RepoStats | null;
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

export type QueueView = 'all' | 'fine' | 'duplicate' | 'wiki' | 'mirrors' | 'incomplete' | 'rejected' | 'dead';
interface Selection { view: QueueView; query: string; entryType: string }
type QueueCounts = Record<Exclude<QueueView, 'all'> | 'pending' | 'waiting' | 'approved' | 'submitted' | 'discord', number>;

const IMPORT_PAGE_SIZE = 50;
export const imports = $state({
	items: [] as QueueItem[],
	counts: {
		pending: 0, waiting: 0, approved: 0, rejected: 0, submitted: 0, dead: 0,
		fine: 0, duplicate: 0, wiki: 0, mirrors: 0, incomplete: 0, discord: 0
	} as QueueCounts,
	loaded: false,
	loading: false,
	wikiReading: {} as Record<number, boolean>,
	wikiErrors: {} as Record<number, string>
});

function client() {
	if (!supabase) throw new Error('Database is not configured.');
	return supabase;
}

let countsRequest = 0;

let selection: Selection = { view: 'all', query: '', entryType: '' };
let activeRequest: AbortController | undefined;
let cursor: { name: string; id: number } | undefined;
let hasMore = $state(false);

export function selectQueue(next: Selection) {
	activeRequest?.abort();
	selection = next;
	cursor = undefined;
	hasMore = false;
	imports.items = [];
	imports.loaded = false;
}

export async function loadQueue(refreshCounts = true, more = false) {
	if (!auth.isAdmin) return;
	activeRequest?.abort();
	const request = new AbortController();
	activeRequest = request;
	imports.loading = true;
	const { view, query, entryType } = selection;
	const decided = view === 'rejected' || view === 'dead';
	const after = more ? cursor : undefined;
	const read = refreshCounts ? ++countsRequest : countsRequest;
	const updateBadge = refreshCounts ? trackImportBadge() : undefined;
	try {
		let rows = client().from(decided ? 'decided_imports' : 'pending_imports')
			.select('id,sort_name,key,url,name,description,images,alts,category,obsolete,parent,group_key,status,problem,readme_checked_at,rejected_by_owner,wiki_source,wiki_recommended,source,entry_type' +
				(decided ? '' : ',mirror_source,mirror_addon_id,mirror_source_unavailable,same_name_count,review_bucket,review_stats'));
		if (!decided) rows = rows.eq('status', 'pending');
		if (view === 'all' || view === 'mirrors') rows = rows.eq('repository_missing', false);
		else rows = rows.eq('review_bucket', view);
		if (view === 'mirrors') rows = rows.not('mirror_source', 'is', null);
		if (entryType) rows = rows.eq('entry_type', entryType);
		for (const word of query.toLowerCase().split(/\s+/).filter(Boolean)) {
			// PostgreSQL's quoted regex mode searches for the rest of the pattern literally.
			rows = rows.filter('search_document', 'match', `(?q)${word}`);
		}
		if (after) {
			const name = '"' + after.name.replace(/["\\]/g, '\\$&') + '"';
			rows = rows.or(`sort_name.gt.${name},and(sort_name.eq.${name},id.gt.${after.id})`);
		}
		const [page, counts] = await Promise.all([
			rows.order('sort_name').order('id').limit(IMPORT_PAGE_SIZE + 1).abortSignal(request.signal),
			refreshCounts ? client().rpc('import_review_counts').abortSignal(request.signal) : undefined
		]);
		if (request.signal.aborted || !auth.isAdmin) return;
		if (page.error || counts?.error) throw new Error((page.error ?? counts?.error)!.message);
		const rowsFound = (page.data ?? []) as unknown as QueueItem[];
		const items = rowsFound.slice(0, IMPORT_PAGE_SIZE);
		if (counts?.data && read === countsRequest) {
			imports.counts = counts.data as QueueCounts;
			updateBadge?.(imports.counts.pending);
		}
		const last = items.at(-1);
		cursor = last && { name: last.sort_name ?? last.name.toLowerCase(), id: last.id };
		hasMore = rowsFound.length > IMPORT_PAGE_SIZE;
		imports.items = more ? [...new Map([...imports.items, ...items].map(item => [item.id, item])).values()] : items;
		imports.loaded = true;
		if (!decided) void expandWaitingArticles();
		return true;
	} finally {
		if (activeRequest === request) imports.loading = false;
	}
}

export function loadMoreImports() {
	if (!imports.loading && hasMore && cursor) return loadQueue(false, true);
}

export const hasMoreImports = () => hasMore;

const attemptedArticles = new Set<number>();
let expanding = false;
async function expandWaitingArticles() {
	if (expanding || !auth.isAdmin) return;
	expanding = true;
	try {
		const articles = imports.items.filter(item => isWikiPage(item.url) && !attemptedArticles.has(item.id));
		let changed = false;
		for (let i = 0; i < articles.length; i += 3) {
			const results = await Promise.all(articles.slice(i, i + 3).map(item => expandArticle(item, undefined, false)));
			changed = changed || results.some(Boolean);
		}
		if (changed) await loadQueue().catch(() => {});
	} finally { expanding = false; }
}

export async function expandArticle(item: QueueItem, pasted?: ArticleLink[], refresh = true) {
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
		if (refresh) await loadQueue();
		return true;
	} catch(e) { imports.wikiErrors[item.id] = (e as Error).message; return false; }
	finally { imports.wikiReading[item.id] = false; }
}

async function call<T>(name: string, args: Record<string, unknown>) {
	const { data, error } = await client().rpc(name, args);
	if (error) throw new Error(error.message);
	return data as T;
}

async function refreshQueueCounts() {
	const read = ++countsRequest;
	const updateBadge = trackImportBadge();
	const { data, error } = await client().rpc('import_review_counts');
	if (!error && data && read === countsRequest && auth.isAdmin) {
		imports.counts = data as QueueCounts;
		updateBadge(imports.counts.pending);
	}
}

async function afterPublish() {
	await loadAddons();
	// Publishing can change other entries' review categories. The All and
	// Confirmed mirrors lists already contain the right rows.
	if (['fine', 'duplicate', 'incomplete'].includes(selection.view)) await loadQueue();
	else await refreshQueueCounts();
}

// Takes entries out of the list at once, so the page does not wait for the database or
// redraw the whole queue. Returns a function that puts them back.
function settle(ids: number[], as: 'approved' | 'rejected') {
	const view = selection;
	const before = { items: imports.items, counts: { ...imports.counts } };
	const removed = before.items.filter(item => ids.includes(item.id));
	const moved = removed.length;
	const removedNames = new Map<string, number>();
	for (const item of removed) {
		const name = plainName(item.name);
		removedNames.set(name, (removedNames.get(name) ?? 0) + 1);
	}
	imports.items = before.items.filter(item => !ids.includes(item.id)).map(item => {
		const siblings = removedNames.get(plainName(item.name));
		return siblings && item.same_name_count ? { ...item, same_name_count: item.same_name_count - siblings } : item;
	});
	imports.counts.pending -= moved;
	imports.counts.waiting -= moved;
	imports.counts[as] += moved;
	for (const item of removed) {
		if (item.review_bucket) imports.counts[item.review_bucket]--;
		if (item.mirror_source) imports.counts.mirrors--;
		if (item.source === 'Discord') imports.counts.discord--;
	}
	return () => {
		if (selection !== view) return;
		imports.items = before.items;
		imports.counts = before.counts;
	};
}

/** Publishes entries as they are. Returns how many went live; the rest keep a reason. */
export async function approve(ids: number[]) {
	const undo = settle(ids, 'approved');
	try {
		const published = await call<number>('approve_imports', { ids });
		if (published < ids.length) await Promise.all([loadQueue(), loadAddons()]);
		else await afterPublish();
		return published;
	} catch (e) {
		await loadQueue().catch(undo);
		throw e;
	}
}

export async function reject(ids: number[]) {
	const undo = settle(ids, 'rejected');
	try {
		await call<number>('decide_imports', { ids, decision: 'rejected' });
		refreshAdminBadges({ afterAction: true });
	} catch (e) {
		await loadQueue().catch(undo);
		throw e;
	}
}

/** Puts rejected entries back in the queue. */
export async function restore(ids: number[]) {
	await call<number>('decide_imports', { ids, decision: 'pending' });
	if (selection.view === 'rejected') {
		imports.items = imports.items.filter(item => !ids.includes(item.id));
	}
	await refreshQueueCounts();
}

/** Publishes a queued entry straight into the group of an addon that is already live. */
export async function approveInto(item: QueueItem, addon: Addon) {
	const undo = settle([item.id], 'approved');
	try {
		await call('approve_into', { queue_id: item.id, target: addon.id });
		await afterPublish();
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
	await afterPublish();
}
