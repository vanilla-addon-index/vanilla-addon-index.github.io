import { asset } from '$app/paths';
import { auth } from './auth.svelte';
import { LOCAL } from './config';
import { tell } from './confirm.svelte';
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

type Row = Omit<Addon, 'owner_name'> & { profiles: { username: string } | null };

// Rows saved before versions existed carry only the single link.
const withVersions = <T extends Partial<Addon>>(row: T) => ({
	...row,
	versions: row.versions?.length ? row.versions : [{ url: row.repo_url ?? '', note: '' }],
	aliases: row.aliases ?? [],
	source: row.source ?? '',
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

const fetchAll = async () => (await fetchPaged<Row>('*, profiles(username)')).map(toAddon);

// What tells a snapshot row apart from the row as it is now, without sending its text.
// Grouping leaves "updated_at" alone, and the snapshot does not know who posted what.
type Outline = Pick<Addon, 'id' | 'updated_at' | 'group_id' | 'is_main'> & { profiles: { username: string } | null };

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
		fetchPaged<Outline>('id, updated_at, group_id, is_main, profiles(username)')
	]);
	// What this browser already holds counts too: rows loaded earlier in the visit or saved
	// by the last one. An admin approving imports by the hundred fetches each row once.
	const rows = new Map([...snapshot, ...store.addons].map((a) => [a.id, a]));
	const changed = outline.filter((o) => rows.get(o.id)?.updated_at !== o.updated_at).map((o) => o.id);
	if (changed.length > MAX_CHANGED) return fetchAll();

	for (let from = 0; from < changed.length; from += CHUNK) {
		const { data, error } = await supabase
			.from('addons')
			.select('*, profiles(username)')
			.in('id', changed.slice(from, from + CHUNK));
		if (error) throw error;
		for (const row of data as Row[]) rows.set(row.id, toAddon(row));
	}
	// The outline decides what exists and in which order; a deleted addon is not in it.
	return outline.flatMap(({ id, group_id, is_main, profiles }) => {
		const row = rows.get(id);
		return row ? [{ ...row, group_id, is_main, owner_name: profiles?.username ?? '' }] : [];
	});
}

const byName = (a: Addon, b: Addon) => a.name.localeCompare(b.name);

/**
 * Visitors read the daily snapshot, a static file that costs the database nothing. Someone
 * logged in posts, edits and reviews, so they get the list as it is now: the snapshot,
 * brought up to date by the database. Each source stands in for the other when it fails.
 */
export async function loadAddons() {
	const live = LOCAL || Boolean(auth.session);
	try {
		store.addons = await (live ? fetchLive() : fetchSnapshot());
		store.stale = false;
	} catch {
		try {
			store.addons = await (live ? fetchSnapshot() : fetchAll());
			store.stale = live;
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
		.select('*, profiles(username)')
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

export async function createAddon(input: AddonInput) {
	if (!supabase) throw new Error('Database is not configured.');
	// The database makes the address from the name; see the slugs migration.
	const { data, error } = await supabase.from('addons').insert(input).select('*, profiles(username)').single();
	if (error) throw new Error(explain(error));
	const addon = toAddon(data as Row);
	store.addons = [...store.addons, addon].sort(byName);
	writeCache();
	return addon;
}

export async function updateAddon(id: number, input: AddonInput) {
	if (!supabase) throw new Error('Database is not configured.');
	const previous = store.addons;
	// Optimistic: show the edit immediately, roll back if the database rejects it.
	store.addons = previous.map((a) => (a.id === id ? { ...a, ...input } : a));
	const { data, error } = await supabase
		.from('addons')
		.update(input)
		.eq('id', id)
		.select('*, profiles(username)')
		.single();
	if (error) {
		store.addons = previous;
		throw new Error(explain(error));
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
