// Calls behind the admin panel's Log, Trash and Users tabs. The database checks the
// caller's rights on every one of them; see the moderation migration.
import { PROVIDER_NAMES } from './config';
import { linkKey } from './links';
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
		// For deletes: where in the trash the addon went.
		trash_id?: number;
		// For group changes: how the addons involved were grouped before, which is what
		// undoing the line restores.
		groups_before?: unknown[];
		// For "undid a group change": the log line that was undone.
		undid?: number;
		// For "declined to group": the addon it was not grouped with.
		target?: string;
		// For emptying the trash: what was removed for good.
		names?: string[];
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
	deleted?: boolean;
	addons: number;
	// What the account logs in with, e.g. ['github'].
	providers?: string[];
}

/** How an account logs in, for display: "GitHub", or "Discord, GitHub" once linked. */
export const loginsOf = (user: UserRow) => (user.providers ?? []).map((p) => PROVIDER_NAMES[p] ?? p).join(', ');

/** What each tab last loaded, kept while the site stays open. */
export const remembered: { log?: LogEntry[]; users?: UserRow[] } = {};

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
	'group.undo': 'undid a group change of',
	'group.decline': 'declined to group',
	'trash.purge': 'removed for good from the trash:',
	'report.create': 'reported',
	'report.handle': 'handled a report about',
	'report.dismiss': 'dismissed a report about',
	'report.reopen': 'reopened a report about',
	'import.approve': 'approved the import of',
	'import.submitted': 'submitted a link already waiting for import:',
	'import.reject': 'rejected the import of',
	'import.requeue': 'put back in the import queue',
	'account.delete': 'deleted',
	'user.admin': 'made an admin of',
	'user.unadmin': 'took the admin rights of',
	'user.ban': 'banned',
	'user.unban': 'unbanned',
	'user.autosuspend': 'was suspended automatically:',
	'user.rollback': 'rolled back everything done by'
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

/** What narrows the log down. The database does the searching, so it covers every line ever written. */
export interface LogFilter {
	// The first part of the action: 'addon', 'group', 'import', 'report', 'user' or 'trash'.
	kind?: string;
	// Lines about one addon: its history.
	addonId?: number;
	// Lines by one account, by its exact name.
	by?: string;
	recoveryId?: string;
	// Part of an addon's or an account's name.
	q?: string;
}

/** Newest first. Pass the id of the oldest line already shown to get the ones before it. */
export async function loadLog(filter: LogFilter = {}, before?: number) {
	let query = client().from('activity_log').select('*');
	if (filter.kind) query = query.like('action', `${filter.kind}.%`);
	if (filter.addonId) query = query.eq('addon_id', filter.addonId);
	if (filter.by) query = query.eq('actor_name', filter.by);
	if (filter.recoveryId) query = query.eq('recovery_actor', filter.recoveryId);
	const text = filter.q?.trim();
	if (text) {
		// Quoted, so a comma or bracket in what was typed is searched for, not read as syntax.
		const pattern = `"*${text.replace(/[\\"]/g, '\\$&')}*"`;
		query = query.or(`subject.ilike.${pattern},actor_name.ilike.${pattern}`);
	}
	if (before) query = query.lt('id', before);
	const { data, error } = await query.order('id', { ascending: false }).limit(LOG_PAGE);
	if (error) throw new Error(error.message);
	return data as LogEntry[];
}

/** The latest lines by an account, and the ones about it (bans and suspensions). */
export async function loadLogAbout(user: { id: string; username: string; deleted?: boolean }) {
	const latest = () => client().from('activity_log').select('*').order('id', { ascending: false }).limit(50);
	const [by, about] = await Promise.all([
		latest().eq(user.deleted ? 'recovery_actor' : 'actor', user.id),
		user.deleted ? Promise.resolve({ data: [], error: null }) : latest().like('action', 'user.%').eq('subject', user.username)
	]);
	if (by.error || about.error) throw new Error((by.error ?? about.error)!.message);
	const lines = new Map([...by.data, ...about.data].map((line: LogEntry) => [line.id, line]));
	return [...lines.values()].sort((a, b) => b.id - a.id).slice(0, 50);
}

export interface TrashPage {
 items: TrashEntry[];
 total: number;
 matching: number;
 more: boolean;
}

/** Search all stored entries; the timestamp/id cursor stays valid after a restore. */
export const loadTrash = (search = '', before?: Pick<TrashEntry, 'id' | 'deleted_at'>) =>
 call<TrashPage>('list_trash', { search, before_time: before?.deleted_at ?? null, before_id: before?.id ?? null });

/** Puts a trashed addon back and returns its address. */
export const restoreAddon = (trashId: number) => call<string>('restore_addon', { trash_id: trashId });

/** Removes trashed addons for good. Owner only. */
export const purgeTrash = (ids: number[]) => call<number>('purge_trash', { ids });

export interface RollbackStep {
	kind: 'restore' | 'revert' | 'delete' | 'unapprove' | 'requeue' | 'ungroup' | 'unban' | 'dismiss' | 'withdraw' | 'reopen';
	// The addon or account the step is about.
	subject: string;
	// For a revert: how many edits by other people, made since, go with it.
	others?: number;
}

export interface Rollback {
	steps: RollbackStep[];
	// What could not be undone, and why.
	skipped: { action: string; subject: string; why: string }[];
}

// What each step reads as, before the name of what it is about.
export const ROLLBACK_TEXT: Record<RollbackStep['kind'], string> = {
	restore: 'Restore',
	revert: 'Put back as it was:',
	delete: 'Move to the trash:',
	unapprove: 'Send back to the import queue:',
	requeue: 'Put the rejected import back in the queue:',
	ungroup: 'Undo a group change of',
	unban: 'Lift the ban on',
	dismiss: 'Dismiss their report about',
	reopen: 'Reopen the report about',
	withdraw: 'Withdraw their group suggestion for'
};

/**
 * Undoes everything an account did since a moment, newest first. With preview, nothing is
 * changed and the answer lists what a real run would do. See the rollback migration.
 */
export const rollbackAccount = (id: string, since: Date, preview: boolean) =>
	call<Rollback>('rollback_account', { target: id, since: since.toISOString(), preview });

/** Which trash entries still exist, so the log only offers to restore what can be restored. */
export async function loadTrashIds(ids: number[]) {
 const unique = [...new Set(ids)];
 const batches: number[][] = [];
 for (let i = 0; i < unique.length; i += 100) batches.push(unique.slice(i, i + 100));
 const answers = await Promise.all(batches.map(batch => client().from('addon_trash').select('id').in('id', batch)));
 const error = answers.find(answer => answer.error)?.error;
 if (error) throw new Error(error.message);
 return new Set(answers.flatMap(answer => (answer.data ?? []).map((row: { id: number }) => row.id)));
}

/** Puts the addons of a logged group change back the way they were grouped before it. */
export const undoGrouping = (logId: number) => call<null>('undo_grouping', { log_id: logId });

/** Undoes an approval: the addon goes to the trash and its entry is back in the import queue. */
export const unapproveImport = (addonId: number) => call<null>('unapprove_import', { target: addonId });

/** Puts a rejected import back in the queue, found by its link. False when it was not rejected any more. */
export async function requeueImport(url: string) {
	const { data, error } = await client()
		.from('import_queue')
		.select('id')
		.eq('key', linkKey(url))
		.eq('status', 'rejected')
		.maybeSingle();
	if (error) throw new Error(error.message);
	if (!data) return false;
	await call<number>('decide_imports', { ids: [data.id], decision: 'pending' });
	return true;
}

/** Lifts the ban on the account with this name. False when there is no such account. */
export async function unbanByName(username: string) {
	const user = (await listUsers(username)).find((u) => u.username === username);
	if (!user) return false;
	await setBanned(user.id, false);
	return true;
}

/** Sets an addon back to how it was before the edit in this log line. */
export const revertEdit = (logId: number) => call<null>('revert_addon', { log_id: logId });

export const listUsers = (search: string) => call<UserRow[]>('list_users', { search });

/** Bans or unbans. What the account posted or imported stays up either way. */
export const setBanned = (id: string, value: boolean) => call<null>('set_banned', { target: id, value });

/** Makes an account an admin, or an ordinary member again. Owner only. */
export const setAdmin = (id: string, value: boolean) => call<null>('set_admin', { target: id, value });

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

export interface DeletedAccount { id: string; deleted_at: string; actions: number }
/** Owner-only discovery of pseudonymous recovery records; no login or username is retained. */
export const listDeletedAccounts = (target: string | null = null, beforeId: string | null = null) =>
 call<DeletedAccount[]>('list_deleted_accounts', { target, before_id: beforeId });

/** Owner-only recovery of the exact report decision in this audit entry. */
export const reopenReport = (logId: number) => call<boolean>('reopen_report', { log_id: logId });
