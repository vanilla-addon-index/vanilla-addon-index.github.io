// Reports about live addons: anyone logged in sends them, admins read and close them.
// The database checks the caller's rights on every call; see the reports migration.
import { supabase } from './supabase';

// Must match the check on reports.reason in the reports migration.
export const REASONS = {
	broken: 'The link is dead or broken',
	'wrong-client': 'Not an addon for 1.12',
	duplicate: 'Already listed under another entry',
	harmful: 'Harmful or malicious',
	other: 'Something else'
} as const;
export type Reason = keyof typeof REASONS;

export const NOTE_MAX = 500;

export interface Report {
	id: number;
	addon_id: number;
	reason: Reason;
	note: string;
	reported_by_name: string | null;
	created_at: string;
}

export const reports = $state({
	// How many wait for an admin, for the count next to "Admin" and "Reports".
	open: 0
});

function client() {
	if (!supabase) throw new Error('Database is not configured.');
	return supabase;
}

export async function reportAddon(addonId: number, reason: Reason, note: string) {
	const { error } = await client().rpc('report_addon', { addon: addonId, reason, note });
	if (error) throw new Error(error.message);
}

/** The reports still waiting, oldest first. */
export async function loadReports() {
	const { data, error } = await client()
		.from('reports')
		.select('id, addon_id, reason, note, reported_by_name, created_at')
		.eq('status', 'open')
		.order('id')
		.limit(1000);
	if (error) throw new Error(error.message);
	reports.open = data.length;
	return data as Report[];
}

/** Counts the waiting reports without fetching them. Admins only; anyone else gets 0. */
export async function countReports() {
	if (!supabase) return;
	const { count } = await supabase.from('reports').select('id', { count: 'exact', head: true }).eq('status', 'open');
	reports.open = count ?? 0;
}

export async function decideReport(id: number, outcome: 'handled' | 'dismissed') {
	const { error } = await client().rpc('decide_report', { report: id, outcome });
	if (error) throw new Error(error.message);
	reports.open = Math.max(0, reports.open - 1);
}
