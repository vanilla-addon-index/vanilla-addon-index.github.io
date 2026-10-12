// Writes the full addon list to static/addons.json, which the site is built with.
// The daily run is the site's offline fallback, and the read that keeps the free Supabase
// project from being paused for inactivity. The deploy keeps the latest one on the
// "snapshot" branch.
//
// The list is what a visitor may read: who posted or approved an addon is not in it.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { PUBLIC_ADDON_COLUMNS, SUPABASE_ANON_KEY, SUPABASE_URL } from '../src/lib/config.ts';

const FILE = 'static/addons.json';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
	console.log('Supabase is not configured, keeping the existing snapshot.');
	process.exit(0);
}

// The API returns at most 1000 rows per request.
const PAGE = 1000;
const addons = [];
for (let offset = 0; ; offset += PAGE) {
	const res = await fetch(
		// Names repeat; the id keeps the order fixed from one page to the next.
		`${SUPABASE_URL}/rest/v1/addons?select=${PUBLIC_ADDON_COLUMNS}&order=name,id&limit=${PAGE}&offset=${offset}`,
		{ headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
	);
	if (!res.ok) throw new Error(`Export failed: ${res.status} ${await res.text()}`);
	const page = await res.json();
	addons.push(...page);
	if (page.length < PAGE) break;
}

// A list far shorter than the last one is more likely a database that answered wrongly
// than a list that shrank: an empty answer would otherwise replace the snapshot and take
// every addon's page off the site. The last snapshot is kept and the run says so. If the
// list really is that much shorter, delete the "snapshot" branch on GitHub and deploy
// again: with nothing to measure against, the new list is taken as it is.
const last = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')).length : 0;
if (last >= 20 && addons.length < last / 2) {
	const problem = `The database lists ${addons.length} addons, far fewer than the ${last} in the last snapshot. The last snapshot is kept.`;
	// Shown on the run's page on GitHub, where a failed step that is allowed to fail is not.
	console.log(`::error title=Snapshot not replaced::${problem}`);
	throw new Error(problem);
}

writeFileSync(FILE, JSON.stringify(addons, null, '\t') + '\n');
console.log(`Exported ${addons.length} addons.`);
