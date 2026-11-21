import { auth } from './auth.svelte';
import { supabase } from './supabase';

const RECENT_MS = 60_000;
const empty = { imports: 0, reports: 0, edits: 0 };
type Counts = typeof empty;
type BadgeRequest = { user: string; changed: boolean };

const adminUser = () => auth.isAdmin && !auth.banned ? auth.session?.user.id : undefined;
let cached = $state.raw<{ user: string; counts: Counts }>();
let owner: string | undefined;
let lastRead = -Infinity;
let active: BadgeRequest | undefined;
let nextImportRead = 0;
let lastImportRead = 0;

export const adminBadgeCounts = () => cached && cached.user === adminUser() ? cached.counts : empty;

export function clearAdminBadges() {
	cached = undefined;
	owner = undefined;
	lastRead = -Infinity;
	active = undefined;
	lastImportRead = nextImportRead;
}

// The import page already reads its full queue summary. Reuse its pending count
// and keep earlier requests from overwriting a newer count that has arrived.
export function trackImportBadge() {
	const user = adminUser();
	const read = ++nextImportRead;
	return (imports: number) => {
		if (!user || adminUser() !== user || read <= lastImportRead || !Number.isFinite(imports)) return;
		lastImportRead = read;
		cached = { user, counts: { ...adminBadgeCounts(), imports } };
	};
}

export function refreshAdminBadges({ afterAction = false } = {}) {
	const user = adminUser();
	if (!user || !supabase) return;

	if (owner !== user) {
		owner = user;
		lastRead = -Infinity;
		active = undefined;
	}
	if (active) {
		if (afterAction) active.changed = true;
		return;
	}
	// Throttle retries too, so navigating during an outage does not keep querying.
	if (!afterAction && Date.now() - lastRead < RECENT_MS) return;
	lastRead = Date.now();
	const request = active = { user, changed: false };
	const updateImports = trackImportBadge();
	const query = supabase.rpc('admin_badge_counts');
	void (async () => {
		try {
			const { data, error } = await query;
			if (error || !data || request.changed || active !== request || adminUser() !== request.user) return;
			const { imports, reports, edits } = data as Counts;
			cached = { user, counts: { imports: adminBadgeCounts().imports, reports, edits } };
			updateImports(imports);
		} catch {
			// Keep the last available counts if the request cannot be completed.
		} finally {
			if (active === request) {
				active = undefined;
				if (request.changed && adminUser() === user) refreshAdminBadges({ afterAction: true });
			}
		}
	})();
}
