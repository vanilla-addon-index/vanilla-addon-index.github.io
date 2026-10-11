// Calls behind the admin panel's Log, Trash and Users tabs. The database checks the
// caller's rights on every one of them; see supabase/moderation.sql.
import { PROVIDER_NAMES } from './config';
import { supabase } from './supabase';
import type { Addon } from './types';

export interface LogEntry {
	id: number;
	at: string;
	actor_name: string | null;
	action: string;
	// The addon or account the line is about.
	subject: string | null;
	addon_id: number | null;
	details: {
		// For edits: the fields that changed, the whole entry as it was before, and the new
		// value of each changed field (missing on lines logged before that was recorded).
		changed?: string[];
		before?: Record<string, unknown>;
		after?: Record<string, unknown>;
		reason?: string;
		trashed?: boolean;
		url?: string;
	} | null;
}

export interface TrashEntry {
	id: number;
	name: string;
	reason: 'delete' | 'merge' | 'ban';
	deleted_by_name: string | null;
	deleted_at: string;
	addon: Pick<Addon, 'slug' | 'description' | 'versions' | 'images' | 'category'>;
}

export interface UserRow {
	id: string;
	username: string;
	joined: string;
	banned: boolean;
	role: 'owner' | 'admin' | 'member';
	addons: number;
	// What the account logs in with, e.g. ['github']. Missing until supabase/user-providers.sql has been run.
	providers?: string[];
}

/** How an account logs in, for display: "GitHub", or "Discord, GitHub" once linked. */
export const loginsOf = (user: UserRow) => (user.providers ?? []).map((p) => PROVIDER_NAMES[p] ?? p).join(', ');

/** What each tab last loaded, kept while the site stays open. */
export const remembered: { log?: LogEntry[]; trash?: TrashEntry[]; users?: UserRow[] } = {};

// What each action reads as, after the name of who did it.
export const ACTION_TEXT: Record<string, string> = {
	'addon.create': 'posted',
	'addon.update': 'edited',
	'addon.revert': 'reverted an edit of',
	'addon.delete': 'deleted',
	'addon.merge': 'merged away',
	'addon.purge': 'trashed (with a ban)',
	'addon.restore': 'restored',
	'group.add': 'grouped versions under',
	'group.remove': 'removed from its group',
	'group.main': 'made the main version',
	'group.suggest': 'suggested a group for',
	'report.create': 'reported',
	'report.handle': 'handled a report about',
	'report.dismiss': 'dismissed a report about',
	'import.approve': 'approved the import of',
	'import.reject': 'rejected the import of',
	'import.requeue': 'put back in the import queue',
	'user.ban': 'banned',
	'user.unban': 'unbanned',
	'user.autosuspend': 'was suspended automatically:'
};

export const TRASH_DAYS = 90;
export const LOG_PAGE = 100;

function client() {
	if (!supabase) throw new Error('Database is not configured.');
	return supabase;
}

async function call<T>(name: string, args: Record<string, unknown>) {
	const { data, error } = await client().rpc(name, args);
	if (error) throw new Error(error.message);
	return data as T;
}

/** Newest first. Pass the id of the oldest line already shown to get the ones before it. */
export async function loadLog(before?: number) {
	let query = client().from('activity_log').select('*');
	if (before) query = query.lt('id', before);
	const { data, error } = await query.order('id', { ascending: false }).limit(LOG_PAGE);
	if (error) throw new Error(error.message);
	return data as LogEntry[];
}

/** The latest lines by an account, and the ones about it (bans and suspensions). */
export async function loadLogAbout(user: { id: string; username: string }) {
	const latest = () => client().from('activity_log').select('*').order('id', { ascending: false }).limit(50);
	const [by, about] = await Promise.all([
		latest().eq('actor', user.id),
		latest().like('action', 'user.%').eq('subject', user.username)
	]);
	if (by.error || about.error) throw new Error((by.error ?? about.error)!.message);
	const lines = new Map([...by.data, ...about.data].map((line: LogEntry) => [line.id, line]));
	return [...lines.values()].sort((a, b) => b.id - a.id).slice(0, 50);
}

export async function loadTrash() {
	const { data, error } = await client()
		.from('addon_trash')
		.select('*')
		.order('deleted_at', { ascending: false })
		.limit(1000);
	if (error) throw new Error(error.message);
	return data as TrashEntry[];
}

/** Puts a trashed addon back and returns its address. */
export const restoreAddon = (trashId: number) => call<string>('restore_addon', { trash_id: trashId });

/** Removes trashed addons for good. Owner only. */
export const purgeTrash = (ids: number[]) => call<number>('purge_trash', { ids });

/** Sets an addon back to how it was before the edit in this log line. */
export const revertEdit = (logId: number) => call<null>('revert_addon', { log_id: logId });

export const listUsers = (search: string) => call<UserRow[]>('list_users', { search });

/** Bans or unbans. With trash, everything the account posted is moved to the trash too. */
export const setBanned = (id: string, value: boolean, trash: boolean) =>
	call<null>('set_banned', { target: id, value, trash });

export interface Suggestion {
	id: number;
	// The addon suggested as a version, and the addon it would join.
	addon_id: number;
	target_id: number;
	kind: 'user' | 'auto';
	suggested_by_name: string | null;
	status: 'pending' | 'accepted' | 'rejected';
}

/** Every suggestion ever made, decided or not: the decided ones say which pairs not to offer again. */
export async function loadSuggestions() {
	const { data, error } = await client().from('group_suggestions').select('*').order('id').limit(5000);
	if (error) throw new Error(error.message);
	return data as Suggestion[];
}

export const decideSuggestion = (id: number, accept: boolean) =>
	call<null>('decide_suggestion', { suggestion: id, accept });

/** Turns down a pair the site spotted by itself, so it is not offered again. */
export const dismissPair = (addonId: number, targetId: number) =>
	call<null>('dismiss_pair', { addon: addonId, target: targetId });

/** Which repositories GitHub says are forks, and of what: link key -> key of the parent. */
export async function loadForks() {
	const { data, error } = await client()
		.from('repo_stats')
		.select('key, fork_of')
		.not('fork_of', 'is', null)
		.limit(5000);
	if (error) throw new Error(error.message);
	return new Map((data as { key: string; fork_of: string }[]).map((row) => [row.key, row.fork_of]));
}
