import { MAX_UPDATE_AGE } from './addon-age';

const MAX_AGE_PREFERENCE = 'vanilla-addon-index:max-update-age';

export const preferences = $state({ maxUpdateAge: 0 });

export function loadPreferences() {
	try {
		const stored = localStorage.getItem(MAX_AGE_PREFERENCE);
		const years = stored === null ? 0 : Number(stored);
		preferences.maxUpdateAge = Number.isInteger(years) && years >= 0 ? Math.min(years, MAX_UPDATE_AGE) : 0;
	} catch { /* Storage can be disabled. */ }
}

export function savePreferences() {
	try { localStorage.setItem(MAX_AGE_PREFERENCE, String(preferences.maxUpdateAge)); } catch { /* The choice still applies for this visit. */ }
}
