const AGE_PREFERENCE = 'vanilla-addon-index:hide-older';

export const preferences = $state({ hideOlder: false });

export function loadPreferences() {
	try { preferences.hideOlder = localStorage.getItem(AGE_PREFERENCE) === 'true'; } catch { /* Storage can be disabled. */ }
}

export function savePreferences() {
	try { localStorage.setItem(AGE_PREFERENCE, String(preferences.hideOlder)); } catch { /* The choice still applies for this visit. */ }
}
