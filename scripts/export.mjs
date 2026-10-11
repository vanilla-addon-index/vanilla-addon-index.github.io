// Writes the full addon list to static/addons.json, which the site is built with.
// The daily run is a backup (kept on the "snapshot" branch by the deploy), the site's
// offline fallback, and the read that keeps the free Supabase project from being paused
// for inactivity.
import { writeFileSync } from 'node:fs';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../src/lib/config.ts';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
	console.log('Supabase is not configured, keeping the existing snapshot.');
	process.exit(0);
}

// The API returns at most 1000 rows per request.
const PAGE = 1000;
const rows = [];
for (let offset = 0; ; offset += PAGE) {
	const res = await fetch(
		// Names repeat; the id keeps the order fixed from one page to the next.
		`${SUPABASE_URL}/rest/v1/addons?select=*,profiles(username)&order=name,id&limit=${PAGE}&offset=${offset}`,
		{ headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
	);
	if (!res.ok) throw new Error(`Export failed: ${res.status} ${await res.text()}`);
	const page = await res.json();
	rows.push(...page);
	if (page.length < PAGE) break;
}

const addons = rows.map(({ profiles, ...row }) => ({
	...row,
	owner_name: profiles?.username ?? ''
}));

writeFileSync('static/addons.json', JSON.stringify(addons, null, '\t') + '\n');
console.log(`Exported ${addons.length} addons.`);
