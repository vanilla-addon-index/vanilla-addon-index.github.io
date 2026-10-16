import { readSort, type Sort } from './addon-sort.ts';

const AGE_PREFERENCE = 'vanilla-addon-index:hide-older';
const SORT_PREFERENCE = 'vanilla-addon-index:sort';

export const preferences = $state({ hideOlder: false, sort: 'name' as Sort });

export function loadPreferences() {
	try { preferences.hideOlder = localStorage.getItem(AGE_PREFERENCE) === 'true'; } catch { /* Storage can be disabled. */ }
	try { preferences.sort = readSort(localStorage.getItem(SORT_PREFERENCE)); } catch { /* Keep the choice for this visit. */ }
}

export function saveSort(sort: Sort) {
	preferences.sort = sort;
	try { localStorage.setItem(SORT_PREFERENCE, sort); } catch { /* The choice still applies for this visit. */ }
}

export function savePreferences() {
	try { localStorage.setItem(AGE_PREFERENCE, String(preferences.hideOlder)); } catch { /* The choice still applies for this visit. */ }
}
