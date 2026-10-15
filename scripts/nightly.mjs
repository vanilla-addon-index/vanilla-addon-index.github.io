// Nightly import job, run by .github/workflows/nightly.yml.
//   1. Reads the wiki and queues addons that are neither live nor already reviewed.
//   2. Trims the log and the trash of what is older than 90 days.
//   3. Counts the reports and suggestions waiting for an admin, for the workflow to tell
//      them about.
//   4. Asks GitHub, GitLab, Codeberg, gitea.com and OctoWoW about every queued and live repository
//      kept there (stars, last update, archived, fork parent, current address, and the
//      game version its .toc file declares) and stores the answers for the review page.
//      GitHub is asked with the workflow's own token; the others need none.
//   5. Looks at the screenshots of each queued entry, once: keeps the wiki's that still
//      load, adds the ones in the repository's README, and stores them for the review.
//
// Needs NIGHTLY_TOKEN and GITHUB_TOKEN. Missing configuration fails before any work.
//
// The job signs in like any visitor. The token is what lets it do these few things and
// nothing else; see the nightly token migration, and `npm run nightly:token` to make one.
import { appendFileSync } from 'node:fs';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../src/lib/config.ts';
import { githubCodeQuery, githubCodeUpdate } from '../src/lib/code-updates.ts';
import { forgeHostPath, askForge, forgePlace, forgeRepositoryEndpoint } from '../src/lib/forges.ts';
import { imagesIn, uncamo } from '../src/lib/github.ts';
import { hostAllowed } from '../src/lib/hosts.ts';
import { githubPlace } from '../src/lib/links.ts';
import { readWiki } from '../src/lib/wiki.ts';
import { askGithub, fieldFailed, groupChecks, githubRepositoryKey, sharedGithubChecks } from '../src/lib/nightly-github.ts';
import { request } from '../src/lib/request.ts';
import { NightlyMetrics } from '../src/lib/nightly-metrics.ts';
import { createForgeRequests } from '../src/lib/nightly-rest.ts';
import { runWorkers } from '../src/lib/nightly-workers.ts';
import { advanceGithubCache, githubCache, githubFiles, githubScope, gitOid, validDate } from '../src/lib/nightly-cache.ts';

const token = process.env.NIGHTLY_TOKEN;
const githubToken = process.env.GITHUB_TOKEN;
if (!token || !githubToken || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
	throw new Error('Nightly requires NIGHTLY_TOKEN, GITHUB_TOKEN and the public Supabase configuration.');
}

const metrics = new NightlyMetrics();
// Emit partial totals even on an unexpected failure; no network work happens at exit.
process.once('exit', () => {
	console.log('Nightly metrics: ' + JSON.stringify(metrics.snapshot()));
	if (process.env.GITHUB_STEP_SUMMARY) {
		try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, metrics.markdown()); }
		catch { console.error('Could not write the Nightly diagnostics summary.'); }
	}
});

const BATCH = 50;
// Each repository in the second pass asks for up to this many files.
const TOC_BATCH = 25;
const TOC_PATHS = 4;
// READMEs are long; fewer of them go into one request.
const README_BATCH = 15;
// Independent queues: at most two repository checks per unauthenticated host.
const FORGE_WORKERS = 2;

// Calls one of the job's database functions. The token travels in the body.
async function db(name, args = {}) {
	const phase = ['nightly_links', 'nightly_waiting'].includes(name) ? 'Database reads' : 'Database writes';
	const finished = metrics.start(phase, false);
	// These nightly RPCs are safe to replay after a lost response: imports are keyed,
	// stores replace known facts, and housekeeping only removes expired records.
	return request(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
		observe: metrics.observe(phase),
		init: {
			method: 'POST',
			headers: {
				apikey: SUPABASE_ANON_KEY,
				Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ token, ...args })
		},
		read: (response) => response.json(),
		errorMessage: async (response) => {
			const body = await response.json().catch(() => null);
			return typeof body?.message === 'string' ? body.message : '';
		}
	}).catch((error) => { throw new Error(`${name}: ${error.message}`); }).finally(finished);
}

const finishedWiki = metrics.start('Wiki');

// 1. Wiki -> queue. The database refuses a page that lists far fewer addons than it did
// the last time, which is what a page that no longer reads properly looks like.
try {
	const { candidates, revision, problems } = await readWiki(metrics.observe('Wiki'));
	const added = await db('queue_imports', { items: candidates });
	console.log(
		`Wiki revision ${revision}: ${candidates.length} addons listed, ${added} new in the queue, ` +
			`${problems.length} bullets could not be read.`
	);
} catch (error) {
	// The repositories are still checked; the run is marked as failed so that this is seen.
	console.error(`The wiki was not imported: ${error.message}`);
	process.exitCode = 1;
}

finishedWiki();

// 2. Housekeeping: what an addon looked like before an edit, and what is in the trash,
// are kept for 90 days.
try {
	const trimmed = await db('nightly_tidy');
	console.log(`Tidied up: ${trimmed} old log line${trimmed === 1 ? '' : 's'} trimmed.`);
} catch (error) {
	console.error(`Could not tidy up: ${error.message}`);
	process.exitCode = 1;
}

// 3. What is waiting for an admin: handed to the workflow, which tells them on GitHub.
// Only the two numbers leave the database.
try {
	const { reports, suggestions } = await db('nightly_waiting');
	console.log(`Waiting for an admin: ${reports} reports, ${suggestions} suggestions.`);
	if (process.env.GITHUB_OUTPUT) {
		appendFileSync(process.env.GITHUB_OUTPUT, `reports=${reports}\nsuggestions=${suggestions}\n`);
	}
} catch (error) {
	console.error(`Could not ask what is waiting: ${error.message}`);
	process.exitCode = 1;
}

// 4. GitHub and the other sites -> repo_stats.
// A key is a repository, or a folder in one for a repository that holds many addons.
// Each link comes as it was written, since its key leaves out the branch and has no capital
// letters: where to look for the .toc is read from the link itself. One key, one check.
const repos = [];
// The same for a repository on GitLab, Codeberg or gitea.com.
const elsewhere = [];
// Whether a picture is still there. Only a plain "gone" counts: a host that is slow, or
// that turns this job away while it serves browsers, gets the benefit of the doubt.
async function gone(image) {
	try {
		return await request(image, {
			observe: metrics.observe('Screenshots'),
			init: { headers: { 'User-Agent': 'vanilla-addon-index' } }, timeoutMs: 10_000, attempts: 2, accept: [404, 410],
			read: async (response) => {
				await response.body?.cancel();
				return response.status === 404 || response.status === 410 || /\/removed\./.test(response.url);
			}
		});
	} catch {
		return null;
	}
}

// The pictures a queued entry has from the wiki, with proxy addresses turned back into
// the real ones, and without those that are gone. A few at a time.
async function stillThere(images) {
	const real = [...new Set(images.map(uncamo))].filter((image) => image.startsWith('https://'));
	const kept = [];
	let complete = true;
	for (let i = 0; i < real.length; i += 5) {
		const batch = real.slice(i, i + 5);
		const dead = await Promise.all(batch.map(gone));
		if (dead.includes(null)) complete = false;
		kept.push(...batch.filter((_, n) => !dead[n]));
	}
	return { images: kept, complete };
}

// Queued entries whose pictures are to be looked at, and what was settled for each.
const pictures = [];
const incompletePictures = new Set();
const savePictures = (key, images) => {
	if (!incompletePictures.has(key)) pictures.push({ key, images });
};
const links = await db('nightly_links');
// Cache pruning is independent of repository checks and successful result saves.
try {
	metrics.count('cache_entries_pruned', await db('prune_repo_check_cache'));
} catch (error) {
	console.error(`Could not prune unused repository cache: ${error.message}`);
	process.exitCode = 1;
}
const toLookAt = links.filter((l) => l.readme);
const wikiPictures = new Map();
const finishedScreenshots = metrics.start('Screenshots');
for (let i = 0; i < toLookAt.length; i += 10) {
	await Promise.all(
		toLookAt.slice(i, i + 10).map(async (l) => {
			const checked = await stillThere(l.images ?? []);
			wikiPictures.set(l.key, checked.images);
			if (!checked.complete) incompletePictures.add(l.key);
		})
	);
	metrics.progress('Screenshots', Math.min(i + 10, toLookAt.length), toLookAt.length);
}

finishedScreenshots();
metrics.count('screenshot_checks_requested', toLookAt.length);
metrics.count('screenshot_checks_incomplete', incompletePictures.size);

for (const { key, url, readme, cache } of links) {
	const place = githubPlace(url);
	const other = place ? null : forgePlace(url);
	if (other && !elsewhere.some((r) => r.url === url)) {
		elsewhere.push({ key, url, place: other, readme, cache, wiki: wikiPictures.get(key) ?? [] });
	}
	// On a site that is not asked: there is no README to read, so the pictures that are
	// left are it.
	if (!place && !other && readme) savePictures(key, wikiPictures.get(key) ?? []);
	if (!place || repos.some((r) => r.url === url)) continue;
	// What the key has after the repository: the folder, as the stored address needs it.
	const folder = /^github\.com\/[^/]+\/[^/]+(\/.+)?$/.exec(key)?.[1] ?? '';
	// "readme": a queued entry whose pictures have not been looked at yet; "wiki": the
	// ones it has from the wiki that still load.
	const ref = place.ref || 'HEAD';
	const scope = githubScope(place.owner, place.name, ref, place.path);
	repos.push({ key, url, ...place, folder, ref, scope, previous: githubCache(cache, scope), readme, wiki: wikiPictures.get(key) ?? [] });
}

// One request to GitHub, tried up to three times: it now and then fails to answer a large
// request in time. Gives nothing when it still has not answered, and the run is marked as
// failed so that this is seen; whoever asked goes on without that batch.
async function github(query, phase) {
	try {
		return await askGithub(query, githubToken, metrics.observe(phase));
	} catch (error) {
		console.error('GitHub request failed after bounded retries: ' + error.message);
		process.exitCode = 1;
		return null;
	}
}

// First pass: mutable facts and branch IDs, then only the immutable checks not cached.
const stats = [];
const codeUpdates = [];
// One review row per key, as before; every exact branch/folder URL keeps its own date.
const reviewStats = new Map();
const pendingStats = [];
const saved = { stats: 0, dates: 0, pictures: 0, cache: 0 };
const pendingCache = [];
const savedDates = new Set();
metrics.count('commit_dates_left_unchanged', new Set([...repos, ...elsewhere].map((r) => r.url)).size);

// Save each completed batch before asking for more. Each store has its own failure
// boundary, so refused statistics cannot discard dates or completed screenshot checks.
// The request helper retries safe RPCs; successful batches are never replayed here.
let saving = Promise.resolve();
function saveProgress() {
	// All producers share one writer. A later checkpoint also drains results queued
	// while an earlier write was in flight, without overlapping database requests.
	saving = saving.then(flushProgress);
	return saving;
}
async function flushProgress() {
	for (const [name, field, pending, count] of [
		['store_repo_stats', 'stats', pendingStats, 'stats'],
		['store_code_updates', 'updates', codeUpdates, 'dates'],
		['store_queue_images', 'items', pictures, 'pictures'],
		['store_repo_check_cache', 'items', pendingCache, 'cache']
	]) {
		while (pending.length) {
			const batch = pending.splice(0, BATCH);
			try {
				metrics.count(`${count}_records_submitted`, batch.length);
				const result = await db(name, { [field]: batch, ...(count === 'stats' ? { report: true } : {}) });
				if (count === 'stats' && result && typeof result === 'object') {
					for (const key of ['accepted', 'facts_written', 'facts_unchanged', 'checks_written']) {
						if (Number.isSafeInteger(result[key]) && result[key] >= 0) metrics.count(`stats_${key}`, result[key]);
					}
				} else if (count === 'cache' && Number.isSafeInteger(result) && result >= 0) metrics.count('cache_rows_written', result);
				saved[count] += batch.length;
				metrics.count(`${count}_records_saved`, batch.length);
				if (count === 'dates') {
					for (const row of batch) if (!savedDates.has(row.url)) {
						savedDates.add(row.url);
						metrics.count('commit_dates_left_unchanged', -1);
					}
				}
			} catch (error) {
				metrics.count(`${count}_records_not_saved`, batch.length);
				console.error(`Could not save ${batch.length} completed checks: ${error.message}`);
				process.exitCode = 1;
			}
		}
	}
}

// Entries on unsupported hosts can already have completed their screenshot checks.
await saveProgress();
const withToc = [];
// Queued entries whose README is to be read.
const withReadme = [];
let unanswered = 0;
const cacheHit = (kind) => { metrics.count('cache_hits'); metrics.count(`${kind}_cache_hits`); };
function queueCache(r) {
	if (!r.state) return;
	const json = JSON.stringify(r.state);
	if (json === (r.queuedCache ?? JSON.stringify(r.previous))) return;
	pendingCache.push({ url: r.url, state: JSON.parse(json) });
	r.queuedCache = json;
}

function applyGithubDetails(r, repo, errors, alias, history, tree) {
	if (history) {
		const checked = repo && !fieldFailed(errors, [alias, 'code']) && Array.isArray(repo.code?.history?.nodes);
		const update = checked ? githubCodeUpdate(repo, r.ref, r.path) : null;
		if (update) codeUpdates.push({ url: r.url, date: update.date, history_url: update.url });
		else metrics.count('github_history_checks_without_result');
		if (r.state && checked && (repo.code.history.nodes.length === 0 || validDate(repo.code.history.nodes[0]?.committedDate))) {
			r.state.history = { date: update?.date ?? null };
		}
	}
	if (!tree || !r.row) return;
	const checked = repo && !fieldFailed(errors, [alias, 'top']) && (repo.top === null || Array.isArray(repo.top?.entries));
	if (!checked) { metrics.count('github_directory_checks_failed'); return; }
	const selection = githubFiles(repo.top?.entries ?? [], r.path, TOC_PATHS);
	const { paths, signature, readme } = selection;
	if (r.state && (repo.top === null || gitOid(repo.top?.oid)) && selection.entries.every((e) => gitOid(e.oid))) {
		r.state.tree = { oid: repo.top?.oid ?? null, entries: selection.entries };
	}
	if (!paths.length) {
		r.row.interface_checked = true;
		if (r.state) r.state.toc = { signature: '[]', interface: null, files: [] };
	} else if (signature && r.state?.toc?.signature === signature) {
		r.row.interface = r.state.toc.interface;
		r.row.interface_checked = true;
		cacheHit('github_toc');
	} else {
		// An unread or incomplete .toc must not clear the previously known version.
		withToc.push({ ...r, paths, signature, source: r });
	}
	if (r.readme) {
		const file = readme ? `${r.path ? r.path + '/' : ''}${readme.name}` : null;
		if (!file) savePictures(r.key, r.wiki);
		else if (gitOid(readme.oid) && r.state?.readme?.file === file && r.state.readme.oid === readme.oid) {
			savePictures(r.key, [...new Set([...r.wiki, ...r.state.readme.images])].slice(0, 5));
			cacheHit('github_readme');
		} else withReadme.push({ ...r, full: repo.nameWithOwner, file, fileOid: readme.oid, source: r });
	}
}

async function checkGithub() {
	const finishedMetadata = metrics.start('GitHub metadata');
	const repositoryGroups = groupChecks(repos, githubRepositoryKey);
	let metadataCompleted = 0;
	for (let i = 0; i < repositoryGroups.length; i += BATCH) {
		const groups = repositoryGroups.slice(i, i + BATCH);
		const batch = groups.flat();
		metadataCompleted += batch.length;
		metrics.count('github_repository_checks_requested', groups.length);
		metrics.count('github_metadata_checks_requested', batch.length);
		const answer = await sharedGithubChecks(batch, githubRepositoryKey, (members) => {
			const refs = [...new Set(members.map((r) => r.ref))];
			for (const r of members) r.headField = refs.indexOf(r.ref) ? `head${refs.indexOf(r.ref)}` : 'head';
			return `id nameWithOwner stargazerCount pushedAt isArchived parent { nameWithOwner } ${refs.map((ref, n) => `${n ? `head${n}` : 'head'}: object(expression: ${JSON.stringify(ref)}) { ... on Commit { oid } }`).join(' ')}`;
		}, (query) => github(query, 'GitHub metadata'), (saved) => metrics.count('github_metadata_fields_shared', saved));
		if (!answer) {
			unanswered += batch.length;
			metrics.count('github_metadata_checks_failed', batch.length);
			metrics.count('github_history_checks_without_result', batch.length);
			metrics.progress('GitHub metadata', metadataCompleted, repos.length);
			continue;
		}
		const detail = [];
		const { data, gone, errors } = answer;
		batch.forEach((r, n) => {
			const alias = `r${n}`;
			const repo = data[alias];
			if (!repo && !gone.has(alias)) { metrics.count('github_metadata_checks_failed'); return unanswered++; }
			if (repo) {
				r.state = !fieldFailed(errors, [alias, r.headField]) ? advanceGithubCache(r.previous, r.scope, repo.id, repo.nameWithOwner, repo[r.headField]?.oid) : undefined;
				r.readRef = r.state?.head ?? r.ref;
			}
			const valid = !repo || !['nameWithOwner', 'stargazerCount', 'pushedAt', 'isArchived', 'parent'].some((field) => fieldFailed(errors, [alias, field]) || !(field in repo));
			if (valid) {
				const row = {
					key: r.key, stars: repo?.stargazerCount ?? 0, pushed_at: repo?.pushedAt ?? null,
					archived: repo?.isArchived ?? false,
					fork_of: repo?.parent ? `github.com/${repo.parent.nameWithOwner.toLowerCase()}` : null,
					canonical: repo ? `github.com/${repo.nameWithOwner.toLowerCase()}${r.folder}` : null,
					interface: null, interface_checked: !repo, missing: !repo
				};
				r.row = row;
				stats.push(row);
				if (!reviewStats.has(row.key)) { reviewStats.set(row.key, row); pendingStats.push(row); }
			} else { metrics.count('github_metadata_checks_failed'); unanswered++; }
			if (!repo) { metrics.count('github_history_checks_without_result'); return; }
			if (r.state?.history) {
				const date = r.state.history.date;
				applyGithubDetails(r, { ...repo, code: { history: { nodes: date ? [{ committedDate: date }] : [] } } }, [], alias, true, false);
				cacheHit('github_history');
			}
			if (r.state?.tree && r.row) {
				applyGithubDetails(r, { ...repo, top: r.state.tree }, [], alias, false, true);
				cacheHit('github_directory');
			}
			r.wantHistory = !r.state?.history;
			r.wantTree = Boolean(r.row) && !r.state?.tree;
			if (r.wantHistory || r.wantTree) detail.push(r);
		});
		// Follow-ups are pinned to the checked commit, never to a branch that may have moved.
		// Save this batch before moving to the next metadata batch, including on cold starts.
		if (detail.length) {
			const finished = metrics.start('GitHub history + files', false);
			metrics.count('github_history_checks_requested', detail.filter((r) => r.wantHistory).length);
			const details = await sharedGithubChecks(detail, (r) => JSON.stringify([githubRepositoryKey(r), r.readRef, r.path]), (members) => {
				const r = members[0];
				return `nameWithOwner ${members.some((m) => m.wantHistory) ? githubCodeQuery(r.readRef, r.path) : ''} ${members.some((m) => m.wantTree) ? `top: object(expression: ${JSON.stringify(`${r.readRef}:${r.path}`)}) { ... on Tree { oid entries { name type oid } } }` : ''}`;
			}, (query) => github(query, 'GitHub history + files'), (saved) => metrics.count('github_detail_fields_shared', saved));
			if (details) detail.forEach((r, n) => { applyGithubDetails(r, details.data[`r${n}`], details.errors, `r${n}`, r.wantHistory, r.wantTree); queueCache(r); });
			else {
				metrics.count('github_history_checks_without_result', detail.filter((r) => r.wantHistory).length);
				metrics.count('github_directory_checks_failed', detail.filter((r) => r.wantTree).length);
			}
			finished();
		}
		await saveProgress();
		metrics.progress('GitHub metadata', metadataCompleted, repos.length);
	}
	finishedMetadata();

	// Second pass: read those .toc files for the "## Interface:" line.
	const finishedToc = metrics.start('GitHub .toc');
	const tocKey = (r) => JSON.stringify([githubRepositoryKey(r), r.readRef, r.paths]);
	const tocGroups = groupChecks(withToc, tocKey);
	let tocCompleted = 0;
	for (let i = 0; i < tocGroups.length; i += TOC_BATCH) {
		const batch = tocGroups.slice(i, i + TOC_BATCH).flat();
		tocCompleted += batch.length;
		metrics.count('github_toc_files_requested', batch.reduce((n, r) => n + r.paths.length, 0));
		const answer = await sharedGithubChecks(batch, tocKey, (members) => {
			const r = members[0];
			return r.paths.map((p, f) => `f${f}: object(expression: ${JSON.stringify(`${r.readRef}:${p}`)}) { ... on Blob { oid text } }`).join(' ');
		}, (query) => github(query, 'GitHub .toc'), (saved) => metrics.count('github_toc_fields_shared', saved));
		// Other facts can still be stored, but incomplete file reads cannot clear a game version.
		if (!answer) {
			for (const r of batch) r.row.interface_checked = false;
			unanswered += batch.length;
			metrics.count('github_toc_checks_failed', batch.length);
			metrics.progress('GitHub .toc', tocCompleted, withToc.length);
			continue;
		}
		const { data, errors } = answer;
		batch.forEach((r, n) => {
			r.row.interface_checked = r.paths.every((_, f) => !fieldFailed(errors, [`r${n}`, `f${f}`]) &&
				(data[`r${n}`]?.[`f${f}`] === null || typeof data[`r${n}`]?.[`f${f}`]?.text === 'string'));
			if (!r.row.interface_checked) {
				metrics.count('github_toc_checks_failed');
				return;
			}
			const found = r.paths
				.map((_, f) => /^##\s*Interface:\s*(\d+)/im.exec(data[`r${n}`]?.[`f${f}`]?.text ?? '')?.[1])
				.filter(Boolean)
				.map(Number);
			// A repository can ship .toc files for several clients; the 1.12 one is what matters.
			if (found.length) r.row.interface = found.includes(11200) ? 11200 : found[0];
			if (r.state && r.signature) {
				r.state.toc = { signature: r.signature, interface: r.row.interface,
					files: r.paths.map((path, f) => ({ path, oid: data[`r${n}`]?.[`f${f}`]?.oid ?? null })) };
				queueCache(r.source);
			}
		});
		for (const { row } of batch) {
			if (reviewStats.get(row.key) === row && row.interface_checked) pendingStats.push(row);
		}
		await saveProgress();
		metrics.progress('GitHub .toc', tocCompleted, withToc.length);
	}
	finishedToc();

	// Third pass: the READMEs of queued entries that have no screenshot, for the pictures in
	// them. Kept to the sites a screenshot may be on, like any other. An entry GitHub gave
	// no answer about is left for the next run.
	const finishedReadme = metrics.start('GitHub README');
	const readmeKey = (r) => JSON.stringify([githubRepositoryKey(r), r.readRef, r.file]);
	const readmeGroups = groupChecks(withReadme, readmeKey);
	let readmeCompleted = 0;
	for (let i = 0; i < readmeGroups.length; i += README_BATCH) {
		const batch = readmeGroups.slice(i, i + README_BATCH).flat();
		readmeCompleted += batch.length;
		metrics.count('github_readme_checks_requested', batch.length);
		const answer = await sharedGithubChecks(batch, readmeKey, (members) => {
			const r = members[0];
			return `readme: object(expression: ${JSON.stringify(`${r.readRef}:${r.file}`)}) { ... on Blob { oid text } }`;
		}, (query) => github(query, 'GitHub README'), (saved) => metrics.count('github_readme_fields_shared', saved));
		if (!answer) {
			metrics.count('github_readme_checks_failed', batch.length);
			metrics.progress('GitHub README', readmeCompleted, withReadme.length);
			continue;
		}
		batch.forEach((r, n) => {
			const repo = answer.data[`r${n}`];
			if (!repo || fieldFailed(answer.errors, [`r${n}`, 'readme']) ||
				(repo.readme !== null && typeof repo.readme?.text !== 'string')) {
				metrics.count('github_readme_checks_failed');
				return;
			}
			// Where the README is served from, so that a picture kept next to it resolves.
			const base = `https://raw.githubusercontent.com/${r.full}/${r.ref}/${r.file}`;
			const found = imagesIn(repo.readme?.text ?? '', base).filter((image) => hostAllowed(image, 'image'));
			if (r.state && gitOid(r.fileOid)) {
				r.state.readme = { file: r.file, oid: r.fileOid, images: found.slice(0, 5) };
				queueCache(r.source);
			}
			// The wiki's first, since someone chose those; then the README's, each picture once.
			savePictures(r.key, [...new Set([...r.wiki, ...found])].slice(0, 5));
		});
		await saveProgress();
		metrics.progress('GitHub README', readmeCompleted, withReadme.length);
	}
	finishedReadme();
}

async function checkOtherHosts() {
	// Each host has its own bounded queue; a slow check cannot hold up another host
	// or a free worker. Requests within each repository remain sequential.
	// One shared request per endpoint, including in-flight work. Conditional
	// repository responses persist independently of branch results in the existing private cache.
	const forgeRequests = createForgeRequests({
		previous: elsewhere.flatMap((r) => r.cache?.http?.endpoint === forgeRepositoryEndpoint(r.place) ? [r.cache.http] : []),
		observe: (url) => metrics.observe(new URL(url).hostname === 'gitlab.com' ? 'GitLab' : new URL(url).hostname === 'codeberg.org' ? 'Codeberg' : 'Gitea'),
		hit: cacheHit
	});

	let silent = 0;
	const finishedOtherHosts = metrics.start('Other hosts');
	let completed = 0;
	const queues = ['gitlab.com', 'codeberg.org', 'gitea.com', 'octowow.st'].map((host) =>
		runWorkers(elsewhere.filter((r) => r.place.host === host), host === 'octowow.st' ? 1 : FORGE_WORKERS, async ({ key, url, place, readme, wiki, cache }) => {
			try {
				let branchState;
				const facts = await askForge(place, forgeRequests.ask, readme, {
					previous: cache, save: (state) => { branchState = state; }, hit: cacheHit
				});
				const http = forgeRequests.metadata(forgeRepositoryEndpoint(place));
				const state = { ...(branchState ?? cache ?? { version: 1, kind: 'forge-http' }) };
				delete state.http;
				if (http) state.http = http;
				if ((branchState || http || cache?.http) && JSON.stringify(state) !== JSON.stringify(cache)) pendingCache.push({ url, state });
				// No answer: what was stored last time stays, and its pictures wait for the next run.
				if (!facts) {
					metrics.count('other_host_metadata_checks_failed');
					return silent++;
				}
				if (!facts.code_update) metrics.count('other_host_history_checks_without_result');
				if (!facts.interface_checked) metrics.count('other_host_toc_checks_failed');
				if (readme && !facts.readme_checked) metrics.count('other_host_readme_checks_failed');
				if (facts.code_update) codeUpdates.push({ url, date: facts.code_update.date, history_url: facts.code_update.url });
				const asked = `${forgeHostPath(place.host)}/${place.project}`.toLowerCase();
				const now = `${forgeHostPath(place.host)}/${facts.project}`.toLowerCase();
				const row = {
					key,
					stars: facts.stars,
					pushed_at: facts.pushed_at,
					archived: facts.archived,
					fork_of: facts.fork_of ? `${forgeHostPath(place.host)}/${facts.fork_of}`.toLowerCase() : null,
					// A renamed or moved repository answers with its current address. What the key
					// has after the repository stays on it.
					canonical: facts.missing ? null : now !== asked && key.startsWith(asked) ? now + key.slice(asked.length) : key,
					interface: facts.interface,
					interface_checked: facts.interface_checked,
					missing: facts.missing
				};
				stats.push(row);
				if (!reviewStats.has(key)) {
					reviewStats.set(key, row);
					pendingStats.push(row);
				}
				if (!readme || facts.missing || !facts.readme_checked) return;
				const found = facts.readme ? imagesIn(facts.readme.text, facts.readme.base).filter((image) => hostAllowed(image, 'image')) : [];
				savePictures(key, [...new Set([...wiki, ...found])].slice(0, 5));
			} finally {
				await saveProgress();
				metrics.progress('Other hosts', ++completed, elsewhere.length);
			}
		})
	);
	const outcomes = await Promise.allSettled(queues);
	finishedOtherHosts();
	if (elsewhere.length) {
		console.log(
			`Asked GitLab, Codeberg, gitea.com and OctoWoW about ${elsewhere.length} repositories` +
				(silent ? `; ${silent} got no answer, and what was known about those is kept.` : '.')
		);
	}

	for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
}

// Start every independent host before waiting for any of them. Settle all work so
// an unexpected host failure cannot discard other hosts' completed checkpoints.
const outcomes = await Promise.allSettled([checkGithub(), checkOtherHosts()]);
for (const outcome of outcomes) if (outcome.status === 'rejected') {
	console.error('Repository processing failed: ' + outcome.reason.message);
	process.exitCode = 1;
}
await saveProgress();

console.log(`Processed ${saved.stats} repository fact records, commit dates for ${saved.dates} addon links, and ${saved.pictures} completed screenshot checks; unanswered checks retain their last known facts.`);

console.log(
	`Checked ${stats.length} repositories: ${stats.filter((s) => s.missing).length} no longer exist, ` +
		`${stats.filter((s) => s.canonical && s.canonical !== s.key).length} have moved, ` +
		`${stats.filter((s) => s.interface !== null).length} have a readable .toc.` +
		(unanswered ? ` GitHub gave no answer about ${unanswered}; what was known about those is kept.` : '')
);
