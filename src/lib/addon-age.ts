export const STALE_YEARS = 8;
// An age of 23 in 2026 includes updates from 2004 onward.
export const MAX_UPDATE_AGE = new Date().getFullYear() - 2004 + 1;

/** Match the import review's calendar-year cutoff; unknown dates stay visible. */
export function isOlderAddon(date: string | null | undefined, now = new Date(), years = STALE_YEARS): boolean {
	if (!date) return false;
	const year = new Date(date).getFullYear();
	return Number.isFinite(year) && year <= now.getFullYear() - years;
}
