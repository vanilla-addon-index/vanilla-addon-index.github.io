// Where to go back to after logging in. A "Log in" link carries the page it was clicked
// on; the login page keeps it in this tab's storage across the trip to GitHub or Discord,
// who send everyone back to the front page; and the first page to see the new login reads
// it and goes there.
import { resolve } from '$app/paths';

const KEY = 'after-login';
// A page remembered longer ago than this belongs to a login that was never finished.
const MAX_AGE = 10 * 60 * 1000;

/** The login page's address, carrying the page to come back to. */
export const loginHref = (from: Pick<URL, 'pathname' | 'search'>) => `${resolve('/login')}?next=${encodeURIComponent(from.pathname + from.search)}`;

/**
 * A page of this site, or nothing. Whatever is in the address bar could have been put
 * there by someone else's link, so it must never lead anywhere but here.
 */
export function ownPath(next: string | null | undefined): string | null {
	if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return null;
	// Coming back to the login page would only send them on to the front page.
	return next === '/login' || next.startsWith('/login?') ? null : next;
}

/** Keeps the page to return to, or forgets the last one when there is none. */
export function rememberReturn(next: string | null) {
	try {
		const path = ownPath(next);
		if (path) sessionStorage.setItem(KEY, JSON.stringify({ path, at: Date.now() }));
		else sessionStorage.removeItem(KEY);
	} catch {
		// Storage unavailable: they land on the front page, as they always used to.
	}
}

/** The page to return to, once: asking again gives nothing. */
export function takeReturn(): string | null {
	try {
		const kept = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as { path?: string; at?: number } | null;
		sessionStorage.removeItem(KEY);
		return kept && Date.now() - (kept.at ?? 0) < MAX_AGE ? ownPath(kept.path) : null;
	} catch {
		return null;
	}
}
