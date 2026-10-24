// Display hints only; every visit still checks the account's current database state.
export function cachedFavorite(user: string | undefined, addon: number): boolean | undefined {
	if (!user) return;
	try {
		const value = JSON.parse(localStorage.getItem(`favorite-v1:${user}:${addon}`) ?? 'null');
		return typeof value === 'boolean' ? value : undefined;
	} catch { return; }
}

export function cacheFavorite(user: string, addon: number, saved: boolean) {
	try { localStorage.setItem(`favorite-v1:${user}:${addon}`, JSON.stringify(saved)); }
	catch { /* Storage may be unavailable. */ }
}

export function cachedProfileId(): string | undefined {
	try {
		const profile = JSON.parse(localStorage.getItem('profile-v2') ?? 'null');
		return typeof profile?.id === 'string' ? profile.id : undefined;
	} catch { return; }
}
