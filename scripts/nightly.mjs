// Nightly import job, run by .github/workflows/deploy.yml.
//   1. Reads the wiki and queues addons that are neither live nor already reviewed.
//   2. Asks GitHub about every queued and live repository (stars, last update, archived,
//      fork parent, current address, and the game version its .toc file declares) and
//      stores the answers for the review page.
//
// Needs SUPABASE_SECRET_KEY, and GITHUB_TOKEN for step 2. Without the secret key it does
// nothing, so the deploy keeps working before the secret is configured.
import { SUPABASE_URL } from '../src/lib/config.ts';
import { readWiki } from '../src/lib/wiki.ts';

const secret = process.env.SUPABASE_SECRET_KEY;
const githubToken = process.env.GITHUB_TOKEN;
if (!secret || !SUPABASE_URL) {
	console.log('SUPABASE_SECRET_KEY is not set, skipping the import job.');
	process.exit(0);
}

const PAGE = 1000;
const BATCH = 50;
// Each repository in the second pass asks for up to this many files.
const TOC_BATCH = 25;
const TOC_PATHS = 4;

async function db(path, init = {}) {
	const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
		...init,
		headers: {
			apikey: secret,
			Authorization: `Bearer ${secret}`,
			'Content-Type': 'application/json',
			...init.headers
		}
	});
	if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
	// A write that asks for nothing back (Prefer: return=minimal) answers 201 with an empty body.
	const body = await res.text();
	return body ? JSON.parse(body) : null;
}

// The API returns at most 1000 rows per request.
async function all(path) {
	const rows = [];
	for (let offset = 0; ; offset += PAGE) {
		const page = await db(`${path}&limit=${PAGE}&offset=${offset}`);
		rows.push(...page);
		if (page.length < PAGE) return rows;
	}
}

// 1. Wiki -> queue.
const { candidates, revision } = await readWiki();
const added = await db('rpc/queue_imports', { method: 'POST', body: JSON.stringify({ items: candidates }) });
console.log(`Wiki revision ${revision}: ${candidates.length} addons listed, ${added} new in the queue.`);

// 2. GitHub -> repo_stats.
if (!githubToken) {
	console.log('GITHUB_TOKEN is not set, skipping repository stats.');
	process.exit(0);
}

const queued = await all('import_queue?select=key&status=eq.pending&order=key');
const live = await all('addons?select=link_keys&order=id');
const repos = [...new Set([...queued.map((q) => q.key), ...live.flatMap((a) => a.link_keys)])]
	.map((key) => /^github\.com\/([\w.-]+)\/([\w.-]+)$/.exec(key))
	.filter(Boolean)
	.map(([key, owner, name]) => ({ key, owner, name }));

async function github(query) {
	const res = await fetch('https://api.github.com/graphql', {
		method: 'POST',
		headers: { Authorization: `Bearer ${githubToken}`, 'User-Agent': 'vanilla-addon-index' },
		body: JSON.stringify({ query })
	});
	if (!res.ok) throw new Error(`GitHub answered ${res.status}: ${await res.text()}`);
	// A repository or file that is gone comes back as null with an entry in "errors"; that is expected.
	const { data } = await res.json();
	if (!data) throw new Error('GitHub returned no data.');
	return data;
}

const repository = (r, n, fields) =>
	`r${n}: repository(owner: ${JSON.stringify(r.owner)}, name: ${JSON.stringify(r.name)}) { ${fields} }`;

// First pass: the facts, and what sits at the top of each repository.
const stats = [];
const withToc = [];
for (let i = 0; i < repos.length; i += BATCH) {
	const batch = repos.slice(i, i + BATCH);
	// One aliased field per repository, so a whole batch costs one request.
	const data = await github(
		`{${batch
			.map((r, n) =>
				repository(
					r,
					n,
					'nameWithOwner stargazerCount pushedAt isArchived parent { nameWithOwner } top: object(expression: "HEAD:") { ... on Tree { entries { name type } } }'
				)
			)
			.join(' ')}}`
	);
	batch.forEach((r, n) => {
		const repo = data[`r${n}`];
		const row = {
			key: r.key,
			stars: repo?.stargazerCount ?? 0,
			pushed_at: repo?.pushedAt ?? null,
			archived: repo?.isArchived ?? false,
			fork_of: repo?.parent ? `github.com/${repo.parent.nameWithOwner.toLowerCase()}` : null,
			// GitHub answers for an old address with the repository's current one.
			canonical: repo ? `github.com/${repo.nameWithOwner.toLowerCase()}` : null,
			interface: null,
			missing: !repo,
			checked_at: new Date().toISOString()
		};
		stats.push(row);

		// An addon's .toc is at the top, or one folder down in a folder of the same name.
		const entries = repo?.top?.entries ?? [];
		const atTop = entries.filter((e) => e.type === 'blob' && /\.toc$/i.test(e.name)).map((e) => e.name);
		const nested = entries
			.filter((e) => e.type === 'tree' && !e.name.startsWith('.'))
			.map((e) => `${e.name}/${e.name}.toc`);
		const paths = (atTop.length ? atTop : nested).slice(0, TOC_PATHS);
		if (paths.length) withToc.push({ ...r, row, paths });
	});
}

// Second pass: read those .toc files for the "## Interface:" line.
for (let i = 0; i < withToc.length; i += TOC_BATCH) {
	const batch = withToc.slice(i, i + TOC_BATCH);
	const data = await github(
		`{${batch
			.map((r, n) =>
				repository(
					r,
					n,
					r.paths
						.map((p, f) => `f${f}: object(expression: ${JSON.stringify(`HEAD:${p}`)}) { ... on Blob { text } }`)
						.join(' ')
				)
			)
			.join(' ')}}`
	);
	batch.forEach((r, n) => {
		const found = r.paths
			.map((_, f) => /^##\s*Interface:\s*(\d+)/im.exec(data[`r${n}`]?.[`f${f}`]?.text ?? '')?.[1])
			.filter(Boolean)
			.map(Number);
		// A repository can ship .toc files for several clients; the 1.12 one is what matters.
		if (found.length) r.row.interface = found.includes(11200) ? 11200 : found[0];
	});
}

for (let i = 0; i < stats.length; i += PAGE) {
	await db('repo_stats', {
		method: 'POST',
		headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
		body: JSON.stringify(stats.slice(i, i + PAGE))
	});
}
console.log(
	`Checked ${stats.length} repositories: ${stats.filter((s) => s.missing).length} no longer exist, ` +
		`${stats.filter((s) => s.canonical && s.canonical !== s.key).length} have moved, ` +
		`${stats.filter((s) => s.interface !== null).length} have a readable .toc.`
);
