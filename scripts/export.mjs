// Writes the full addon list to static/addons.json.
// The daily run is a backup, the site's offline fallback, and the read that keeps
// the free Supabase project from being paused for inactivity.
import { writeFileSync } from 'node:fs';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../src/lib/config.ts';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
	console.log('Supabase is not configured, keeping the existing snapshot.');
	process.exit(0);
}

const res = await fetch(`${SUPABASE_URL}/rest/v1/addons?select=*,profiles(username)&order=name`, {
	headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
});
if (!res.ok) throw new Error(`Export failed: ${res.status} ${await res.text()}`);

const addons = (await res.json()).map(({ profiles, ...row }) => ({
	...row,
	owner_name: profiles?.username ?? ''
}));

writeFileSync('static/addons.json', JSON.stringify(addons, null, '\t') + '\n');
console.log(`Exported ${addons.length} addons.`);
