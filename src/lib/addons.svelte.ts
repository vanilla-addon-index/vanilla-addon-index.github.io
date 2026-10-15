import { asset } from '$app/paths';
import { auth } from './auth.svelte';
import { LOCAL, PUBLIC_ADDON_COLUMNS } from './config';
import { tell } from './confirm.svelte';
import { mergeFresh, newestStamp, stillGone } from './fresh';
import { supabase } from './supabase';
import type { Addon, AddonInput } from './types';

// v3: imports have no owner.
const CACHE_KEY = 'addons-v3';

export const store = $state({
	addons: [] as Addon[],
	loaded: false,
	// True when someone logged in got the daily snapshot because the database was unreachable.
	stale: false
});

// A visitor's rows come without who posted or approved them.
type Row = Omit<Addon, 'owner_name' | 'owner' | 'approved_by'> &
	Partial<Pick<Addon, 'owner' | 'approved_by'>> & { profiles?: { username: string } | null };

// Everything for someone logged in; what a visitor may read otherwise. The database
// refuses a visitor who asks for more.
const columns = () => (auth.session ? '*, profiles:profiles!addons_owner_fkey(username)' : PUBLIC_ADDON_COLUMNS);

// Rows saved before versions existed carry only the single link.
const withVersions = <T extends Partial<Addon>>(row: T) => ({
	...row,
	versions: row.versions ?? (row.repo_url ? [{ url: row.repo_url, note: '' }] : []),
	repo_url: row.repo_url ?? '',
	aliases: row.aliases ?? [],
	source: row.source ?? '',
	code_update: row.code_update ?? null,
	shared: row.shared ?? false,
	pinned_link: row.pinned_link ?? null,
	separate_name: row.separate_name ?? false,
	owner: row.owner ?? null,
	approved_by: row.approved_by ?? null,
	group_id: row.group_id ?? null,
	is_main: row.is_main ?? false
});

const toAddon = ({ profiles, ...row }: Row): Addon => ({
	...withVersions(row),
	owner_name: profiles?.username ?? ''
});

/** Shows the list saved by the last visit, so the first paint does not wait for the network. */
export function readCache() {
	try {
		const cached = localStorage.getItem(CACHE_KEY);
		if (cached) {
			store.addons = JSON.parse(cached);
			store.loaded = true;
		}
	} catch {
		// Storage unavailable or corrupt: fall through to the network.
	}
}

function writeCache() {
	try {
		localStorage.setItem(CACHE_KEY, JSON.stringify(store.addons));
	} catch {
		// Ignore quota and private-mode errors.
	}
}

async function fetchSnapshot() {
	// The file is written by the deploy and is not in the repository, hence the cast.
	const res = await fetch(asset('addons.json' as Parameters<typeof asset>[0]));
	if (!res.ok) throw new Error('snapshot unavailable');
	return ((await res.json()) as Addon[]).map(withVersions);
}

const PAGE = 1000;

// When this browser last asked the database what is newer than the snapshot, and how long
// it waits before asking again. Browsing from page to page asks once, not every time.
const ASKED_KEY = 'fresh-at';
const ASK_EVERY = 5 * 60 * 1000;

// Addons deleted in this browser that the snapshot still lists; see mergeFresh.
const GONE_KEY = 'gone-v1';

function readGone(): number[] {
	try {
		const ids: unknown = JSON.parse(localStorage.getItem(GONE_KEY) ?? '[]');
		return Array.isArray(ids) ? ids.filter((id) => typeof id === 'number') : [];
	} catch {
		return [];
	}
}

function writeGone(ids: number[]) {
	try {
		localStorage.setItem(GONE_KEY, JSON.stringify(ids));
	} catch {
		// Ignore quota and private-mode errors.
	}
}

/**
 * The list for a visitor, and for a member who is not an admin: the snapshot, a static
 * file, with whatever was posted or edited since laid over it. The database is asked for
 * those few rows only, so the answer stays small however long the list is and however
 * many people ask. An addon deleted or regrouped since the snapshot shows as it was until
 * the next one, which is at most a couple of hours away.
 *
 * A member is also sent the addons they posted, which is how the site knows they are
 * theirs to edit: the snapshot does not say who posted what. And what they delete here is
 * remembered, so that their own delete shows at once like their own posts and edits do.
 *
 * Says whether the database answered; without it the snapshot stands alone.
 */
async function fetchPublic(): Promise<{ list: Addon[]; reached: boolean }> {
	const snapshot = await fetchSnapshot();
	const me = auth.session?.user.id;
	const since = newestStamp(snapshot) || '1970-01-01';
	let fresh: Addon[] = [];
	let reached = true;
	let asked = 0;
	try {
		asked = Number(localStorage.getItem(ASKED_KEY)) || 0;
	} catch {
		// Storage unavailable: ask every time.
	}
	// A member's answer holds their own addons, so it is asked for on every load.
	if (supabase && (me || Date.now() - asked > ASK_EVERY)) {
		const query = supabase.from('addons').select(columns());
		const { data } = await (me ? query.or(`updated_at.gt."${since}",owner.eq.${me}`) : query.gt('updated_at', since))
			.order('updated_at', { ascending: false })
			.limit(PAGE);
		reached = Boolean(data);
		if (data) {
			fresh = (data as unknown as Row[]).map(toAddon);
			try {
				localStorage.setItem(ASKED_KEY, String(Date.now()));
			} catch {
				// Ignore quota and private-mode errors.
			}
		}
	}
	const gone = stillGone(readGone(), snapshot);
	writeGone(gone);
	// What an earlier visit fetched is in the list this browser kept.
	return { list: mergeFresh(snapshot, store.addons, fresh, gone), reached };
}

// The API returns at most 1000 rows per request.
async function fetchPaged<T>(columns: string) {
	if (!supabase) throw new Error('not configured');
	const rows: T[] = [];
	for (let from = 0; ; from += PAGE) {
		const { data, error } = await supabase
			.from('addons')
			.select(columns)
			// Names repeat; the id keeps the order fixed from one page to the next.
			.order('name')
			.order('id')
			.range(from, from + PAGE - 1);
		if (error) throw error;
		rows.push(...(data as T[]));
		if (data.length < PAGE) return rows;
	}
}

const fetchAll = async () => (await fetchPaged<Row>(columns())).map(toAddon);

// What tells a snapshot row apart from the row as it is now, without sending its text.
// Grouping leaves "updated_at" alone, and the snapshot does not know who posted what.
type Outline = Pick<Addon, 'id' | 'updated_at' | 'group_id' | 'is_main' | 'owner' | 'approved_by'> & {
	profiles: { username: string } | null;
};

// Ids per request when fetching changed rows, and how many changed rows are still worth
// fetching one by one rather than reading the whole table.
const CHUNK = 200;
const MAX_CHANGED = 400;

/**
 * The list as it is now, for the price of an outline: the text of every addon comes from
 * the daily snapshot and from earlier loads, and the database sends in full only the ones
 * posted or edited since.
 */
async function fetchLive() {
	if (!supabase) throw new Error('not configured');
	if (LOCAL) return fetchAll();
	const [snapshot, outline] = await Promise.all([
		fetchSnapshot().catch(() => [] as Addon[]),
		fetchPaged<Outline>('id, updated_at, group_id, is_main, owner, approved_by, profiles:profiles!addons_owner_fkey(username)')
	]);
	// What this browser already holds counts too: rows loaded earlier in the visit or saved
	// by the last one. An admin approving imports by the hundred fetches each row once.
	const rows = new Map([...snapshot, ...store.addons].map((a) => [a.id, a]));
	const changed = outline.filter((o) => rows.get(o.id)?.updated_at !== o.updated_at).map((o) => o.id);
	if (changed.length > MAX_CHANGED) return fetchAll();

	for (let from = 0; from < changed.length; from += CHUNK) {
		const { data, error } = await supabase
			.from('addons')
			.select('*, profiles:profiles!addons_owner_fkey(username)')
			.in('id', changed.slice(from, from + CHUNK));
		if (error) throw error;
		for (const row of data as Row[]) rows.set(row.id, toAddon(row));
	}
	// The outline decides what exists and in which order; a deleted addon is not in it.
	return outline.flatMap(({ id, group_id, is_main, owner, approved_by, profiles }) => {
		const row = rows.get(id);
		return row ? [{ ...row, group_id, is_main, owner, approved_by, owner_name: profiles?.username ?? '' }] : [];
	});
}

const byName = (a: Addon, b: Addon) => a.name.localeCompare(b.name);

/**
 * Visitors read the snapshot, a static file that costs the database nothing, and ask the
 * database only for what was posted or edited since. Someone logged in posts, edits and
 * reviews, so they get the list exactly as it is now: the snapshot, brought up to date by
 * the database, deletions included. Each source stands in for the other when it fails.
 */
export async function loadAddons() {
	const loggedIn = Boolean(auth.session);
	// Admins review, group and delete, so they get the list exactly as it is now.
	const exact = LOCAL || (loggedIn && auth.isAdmin);
	try {
		if (exact) {
			store.addons = await fetchLive();
			store.stale = false;
		} else {
			const { list, reached } = await fetchPublic();
			store.addons = list;
			// Someone logged in is told when posting will not work; a visitor has no need to know.
			store.stale = loggedIn && !reached;
		}
	} catch {
		try {
			store.addons = await (exact ? fetchSnapshot() : fetchAll());
			store.stale = exact;
		} catch {
			// Keep whatever the cache gave us.
		}
	}
	store.loaded = true;
	writeCache();
}

/**
 * Asks the database for one addon by its address. The snapshot is up to a day old, so a
 * link to an addon posted since then would otherwise lead visitors to "not found".
 */
export async function fetchAddon(slug: string) {
	if (!supabase || !/^[a-z0-9-]+$/.test(slug)) return;
	const { data } = await supabase
		.from('addons')
		.select(columns())
		.or(`slug.eq.${slug},aliases.cs.{${slug}}`)
		.limit(1);
	const row = (data as Row[] | null)?.[0];
	if (!row) return;
	store.addons = [...store.addons.filter((a) => a.id !== row.id), toAddon(row)].sort(byName);
}

export const slugify = (name: string) =>
	name
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');

function explain(error: { code?: string; message: string }) {
	// An hourly or daily limit; see the limits migration. Said in a pop-up, since it is not
	// something wrong with what was typed.
	if (error.code === 'LIMIT') tell('Limit reached', error.message);
	if (error.code === '42501') return 'You are not allowed to do that.';
	return error.message;
}

export async function createAddon(input: AddonInput, split?: { target: number; link: string }) {
	if (!supabase) throw new Error('Database is not configured.');
	// The database makes the address from the name; see the slugs migration.
	const { data: id, error } = await supabase.rpc(split ? 'split_addon_link' : 'submit_addon', split ? { ...split, input } : { input });
	if (error) throw new Error(explain(error));
	const { data, error: readError } = await supabase.from('addons').select('*, profiles:profiles!addons_owner_fkey(username)').eq('id', id).single();
	if (readError) throw new Error(explain(readError));
	const addon = toAddon(data as Row);
	store.addons = [...store.addons.filter((a) => a.id !== addon.id), addon].sort(byName);
	writeCache();
	return addon;
}

/**
 * Saves an edit of the addon as it was when the form was filled: "since" is its
 * "updated_at" then. If someone else has edited it in the meantime, nothing is saved, so
 * their edit is not quietly overwritten by a form that never showed it.
 */
export async function updateAddon(id: number, input: AddonInput, since: string) {
	if (!supabase) throw new Error('Database is not configured.');
	const previous = store.addons;
	// Optimistic: show the edit immediately, roll back if the database rejects it.
	store.addons = previous.map((a) => (a.id === id ? { ...a, ...input } : a));
	const { data, error } = await supabase
		.from('addons')
		.update(input)
		.eq('id', id)
		.eq('updated_at', since)
		.select('*, profiles:profiles!addons_owner_fkey(username)')
		.maybeSingle();
	if (error || !data) {
		store.addons = previous;
		if (error) throw new Error(explain(error));
		// No row matched: it changed, it is gone, or it is not this account's to edit.
		await fetchAddon((previous.find((a) => a.id === id) ?? { slug: '' }).slug);
		throw new Error(
			'This addon was changed by someone else while you were editing it, so your changes were not saved. Open it again to see how it is now, then make your changes there.'
		);
	}
	const addon = toAddon(data as Row);
	store.addons = store.addons.map((a) => (a.id === id ? addon : a));
	writeCache();
	return addon;
}

export async function deleteAddon(id: number) {
	if (!supabase) throw new Error('Database is not configured.');
	const previous = store.addons;
	store.addons = previous.filter((a) => a.id !== id);
	// .select() makes a delete blocked by row-level security visible as zero rows.
	const { data, error } = await supabase.from('addons').delete().eq('id', id).select('id');
	if (error || !data?.length) {
		store.addons = previous;
		throw new Error(error ? explain(error) : 'You are not allowed to do that.');
	}
	// The snapshot lists it until the next one is taken; this browser knows better.
	writeGone([...readGone(), id]);
	writeCache();
}

async function groupCall(name: string, args: Record<string, unknown>) {
	if (!supabase) throw new Error('Database is not configured.');
	const { error } = await supabase.rpc(name, args);
	if (error) throw new Error(explain(error));
	await loadAddons();
}

// Admins only; the database enforces it. See the groups migration.

/** Puts addons in one group. The first decides which group, and which version stays main. */
export const groupAddons = (ids: number[]) => groupCall('group_addons', { ids });
export const ungroupAddon = (id: number) => groupCall('ungroup_addon', { target: id });
export const setMain = (id: number) => groupCall('set_main', { target: id });
export const pinLink = (id: number, link: string | null) => groupCall('pin_addon_link', { target: id, link });
export const mergeAddons = (source: number, target: number) => groupCall('merge_addons', { source_id: source, target_id: target });

/** The poster's request that an addon be grouped as a version of another, for an admin to decide. */
export async function suggestGroup(addonId: number, targetId: number) {
	if (!supabase) throw new Error('Database is not configured.');
	const { error } = await supabase.rpc('suggest_group', { addon: addonId, target: targetId });
	if (error) throw new Error(explain(error));
}

export interface OwnSuggestion {
	// The addon this one was suggested as a version of.
	target_id: number;
	status: 'pending' | 'accepted' | 'rejected';
}

/**
 * The poster's suggestions for an addon and what became of them. The database only shows
 * them to whoever made them and to admins; anyone else gets an empty list.
 */
export async function suggestionsFor(addonId: number) {
	if (!supabase) return [];
	const { data } = await supabase
		.from('group_suggestions')
		.select('target_id, status')
		.eq('addon_id', addonId)
		.eq('kind', 'user');
	return (data ?? []) as OwnSuggestion[];
}

/** An addon's whole group, main version first; just the addon itself when it has none. */
export const groupOf = (addon: Addon) =>
	addon.group_id === null
		? [addon]
		: store.addons
				.filter((a) => a.group_id === addon.group_id)
				.sort((a, b) => Number(b.is_main) - Number(a.is_main) || a.name.localeCompare(b.name));

// Names compare without case, spaces or punctuation: "Big Wigs" is "bigwigs".
export const plainName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The best few matches for what has been typed into an "addon" search box. */
export function searchAddons(query: string, exclude: (addon: Addon) => boolean, limit = 6) {
	const wanted = plainName(query);
	if (!wanted) return [];
	return store.addons
		.filter((a) => !exclude(a) && plainName(a.name).includes(wanted))
		.sort((a, b) => plainName(a.name).indexOf(wanted) - plainName(b.name).indexOf(wanted) || a.name.localeCompare(b.name))
		.slice(0, limit);
}

/** Finds an addon by its address, including the addresses of addons merged into it. */
export const findAddon = (slug: string | undefined) =>
	store.addons.find((a) => a.slug === slug) ?? store.addons.find((a) => slug && a.aliases.includes(slug));

export interface Owned {
	// Addons the account submitted itself.
	posted: Addon[];
	// Imports it approved as an admin: they belong to nobody, and it did not write them.
	imported: Addon[];
}

/** What an account has in the list, with its own posts apart from imports it approved. */
export function ownedBy(id: string | undefined): Owned {
	if (!id) return { posted: [], imported: [] };
	return {
		posted: store.addons.filter((a) => a.owner === id),
		imported: store.addons.filter((a) => a.approved_by === id)
	};
}

/** ["3 addons posted", "120 imports approved"], leaving out the imports when there are none. */
export function ownedText({ posted, imported }: Owned) {
	const count = (n: number, word: string, verb: string) => `${n} ${word}${n === 1 ? '' : 's'} ${verb}`;
	return [
		posted.length || !imported.length ? count(posted.length, 'addon', 'posted') : '',
		imported.length ? count(imported.length, 'import', 'approved') : ''
	].filter(Boolean);
}
