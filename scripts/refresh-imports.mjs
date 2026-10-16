// Lightweight Deploy refresh: only wiki parsing and queue updates, never repository checks.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../src/lib/config.ts';
import { readWiki } from '../src/lib/wiki.ts';
import { request } from '../src/lib/request.ts';

export async function refreshImports(token) {
	if (!token || !SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error('Import refresh requires NIGHTLY_TOKEN and public Supabase configuration.');
	const { candidates, revision, problems } = await readWiki();
	const added = await request(`${SUPABASE_URL}/rest/v1/rpc/queue_imports`, {
		init: {
			method: 'POST',
			headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ token, items: candidates })
		},
		read: response => response.json(),
		errorMessage: async response => {
			const body = await response.json().catch(() => null);
			return typeof body?.message === 'string' ? body.message : '';
		}
	});
	return `Wiki revision ${revision}: refreshed ${candidates.length} import candidates; ${added} new entries. ` +
		`${problems.length} bullets could not be read. Existing repository facts and screenshots were kept.`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const message = await refreshImports(process.env.NIGHTLY_TOKEN);
		console.log(message);
		if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Import refresh\n\n${message}\n`);
	} catch (error) {
		console.error(`Import refresh failed: ${error.message}`);
		process.exitCode = 1;
	}
}
