// Deploy discovers import candidates and checks commit dates only for newly queued links.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../src/lib/config.ts';
import { githubCodeQuery, githubCodeUpdate } from '../src/lib/code-updates.ts';
import { forgeCodeUpdate, forgePlace } from '../src/lib/forges.ts';
import { githubPlace } from '../src/lib/links.ts';
import { askGithub, fieldFailed, githubRepositoryKey, sharedGithubChecks } from '../src/lib/nightly-github.ts';
import { createForgeRequests } from '../src/lib/nightly-rest.ts';
import { runWorkers } from '../src/lib/nightly-workers.ts';
import { readOctowow } from '../src/lib/octowow.ts';
import { readWiki } from '../src/lib/wiki.ts';
import { request } from '../src/lib/request.ts';

const BATCH = 25;

async function db(name, token, args) {
	return request(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
		init: {
			method: 'POST',
			headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ token, ...args })
		},
		read: response => response.json(),
		errorMessage: async (response) => {
			const body = await response.json().catch(() => null);
			return typeof body?.message === 'string' ? body.message : '';
		}
	}).catch(error => { throw new Error(`${name}: ${error.message}`); });
}

async function githubUpdates(links, token) {
	if (!links.length || !token) return [];
	const result = await sharedGithubChecks(
		links,
		(link) => JSON.stringify([githubRepositoryKey(link), link.ref, link.path]),
		([link]) => `nameWithOwner ${githubCodeQuery(link.ref, link.path)}`,
		(query) => askGithub(query, token).catch(() => null)
	);
	if (!result) return [];
	return links.flatMap(({ url, ref, path }, i) => {
		const alias = `r${i}`;
		const repo = result.data[alias];
		const update = repo?.nameWithOwner && !fieldFailed(result.errors, [alias, 'code']) && githubCodeUpdate(repo, ref, path);
		return update ? [{ url, date: update.date, history_url: update.url }] : [];
	});
}

async function seedDates(urls, token, githubToken) {
	const { ask } = createForgeRequests();
	let saved = 0;
	for (let i = 0; i < urls.length; i += BATCH) {
		const github = [];
		const forges = [];
		for (const url of urls.slice(i, i + BATCH)) {
			const place = githubPlace(url);
			if (place) github.push({ ...place, url, ref: place.ref || 'HEAD' });
			else {
				const forge = forgePlace(url);
				if (forge) forges.push({ url, place: forge });
			}
		}
		const updates = [];
		const [fromGithub] = await Promise.all([
			githubUpdates(github, githubToken),
			...['gitlab.com', 'codeberg.org', 'gitea.com', 'octowow.st'].map(host =>
				runWorkers(forges.filter(({ place }) => place.host === host), host === 'octowow.st' ? 1 : 2, async ({ url, place }) => {
					const update = await forgeCodeUpdate(place, ask);
					if (update) updates.push({ url, date: update.date, history_url: update.url });
				}))
		]);
		updates.push(...fromGithub);
		if (updates.length) saved += await db('seed_import_code_updates', token, { updates });
	}
	return saved;
}

export async function refreshImports(token, githubToken = process.env.GITHUB_TOKEN) {
	if (!token || !SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error('Import refresh requires NIGHTLY_TOKEN and public Supabase configuration.');
	const { candidates, revision, problems } = await readWiki();
	const wikiUrls = await db('queue_import_candidates', token, { items: candidates, source: 'wiki' });
	const octowow = await readOctowow();
	const octowowUrls = await db('queue_import_candidates', token, { items: octowow, source: 'octowow' });
	const urls = [...new Set([...wikiUrls, ...octowowUrls])];
	const saved = await seedDates(urls, token, githubToken);
	return `OctoWoW: ${octowow.length} candidates, ${octowowUrls.length} new entries. Wiki revision ${revision}: refreshed ${candidates.length} import candidates; ${wikiUrls.length} new entries. ` +
		`${problems.length} bullets could not be read. Saved commit dates for ${saved} of ${urls.length} new links.`;
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
