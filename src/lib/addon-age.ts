export const STALE_YEARS = 8;

/** Match the import review's calendar-year cutoff; unknown dates stay visible. */
export function isOlderAddon(date: string | null | undefined, now = new Date()): boolean {
	if (!date) return false;
	const year = new Date(date).getFullYear();
	return Number.isFinite(year) && year <= now.getFullYear() - STALE_YEARS;
}
