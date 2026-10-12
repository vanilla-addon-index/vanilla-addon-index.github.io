// Nightly import job, run by .github/workflows/nightly.yml.
//   1. Asks GitHub who the organization's public members are: they are the site's admins.
//   2. Reads the wiki and queues addons that are neither live nor already reviewed.
//   3. Trims the log and the trash of what is older than 90 days.
//   4. Asks GitHub about every queued and live repository (stars, last update, archived,
//      fork parent, current address, and the game version its .toc file declares) and
//      stores the answers for the review page.
//
// Needs NIGHTLY_TOKEN, and GITHUB_TOKEN for steps 1 and 4. Without the token it does nothing, so
// the deploy keeps working before the secret is configured.
//
// The job signs in like any visitor. The token is what lets it do these few things and
// nothing else; see the nightly token and org members migrations, and `npm run nightly:token` to make one.
import { GITHUB_ORG, SUPABASE_ANON_KEY, SUPABASE_URL } from '../src/lib/config.ts';
import { readWiki } from '../src/lib/wiki.ts';

const token = process.env.NIGHTLY_TOKEN;
const githubToken = process.env.GITHUB_TOKEN;
if (!token || !SUPABASE_URL) {
	console.log('NIGHTLY_TOKEN is not set, skipping the import job.');
	process.exit(0);
}

const BATCH = 50;
// Each repository in the second pass asks for up to this many files.
const TOC_BATCH = 25;
const TOC_PATHS = 4;

// Calls one of the job's database functions. The token travels in the body.
async function db(name, args = {}) {
	const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
		method: 'POST',
		headers: {
			apikey: SUPABASE_ANON_KEY,
			Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ token, ...args })
	});
	if (!res.ok) throw new Error(`${name}: ${res.status} ${await res.text()}`);
	return res.json();
}

// 1. GitHub -> organization members. First, and on its own: the list stops counting after
// three days, so a wiki that is down must not keep it from being refreshed.
if (githubToken) {
	try {
		const ids = [];
		for (let page = 1; ; page++) {
			const res = await fetch(`https://api.github.com/orgs/${GITHUB_ORG}/public_members?per_page=100&page=${page}`, {
				headers: { Authorization: `Bearer ${githubToken}`, 'User-Agent': 'vanilla-addon-index' }
			});
			if (!res.ok) throw new Error(`GitHub answered ${res.status}: ${await res.text()}`);
			const members = await res.json();
			ids.push(...members.map((m) => m.id));
			if (members.length < 100) break;
		}
		const stored = await db('store_org_members', { ids });
		console.log(`The organization has ${stored} public member${stored === 1 ? '' : 's'}.`);
	} catch (error) {
		// The rest still runs; the run is marked as failed so that this is seen.
		console.error(`Could not refresh the organization's members: ${error.message}`);
		process.exitCode = 1;
	}
}

// 2. Wiki -> queue. The database refuses a page that lists far fewer addons than it did
// the last time, which is what a page that no longer reads properly looks like.
try {
	const { candidates, revision, problems } = await readWiki();
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

// 3. Housekeeping: what an addon looked like before an edit, and what is in the trash,
// are kept for 90 days.
try {
	const trimmed = await db('nightly_tidy');
	console.log(`Tidied up: ${trimmed} old log line${trimmed === 1 ? '' : 's'} trimmed.`);
} catch (error) {
	console.error(`Could not tidy up: ${error.message}`);
	process.exitCode = 1;
}

// 4. GitHub -> repo_stats.
if (!githubToken) {
	console.log('GITHUB_TOKEN is not set, skipping the organization members and repository stats.');
	process.exit(0);
}

// A key is a repository, or a folder in one for a repository that holds many addons.
const repos = (await db('nightly_repos'))
	.map((key) => /^github\.com\/([\w.-]+)\/([\w.-]+)(\/.+)?$/.exec(key))
	.filter(Boolean)
	.map(([key, owner, name, folder = '']) => ({ key, owner, name, folder }));

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
			canonical: repo ? `github.com/${repo.nameWithOwner.toLowerCase()}${r.folder}` : null,
			interface: null,
			missing: !repo
		};
		stats.push(row);

		// An addon's .toc is at the top, or one folder down in a folder of the same name.
		// For a folder of a collection the facts above are the whole repository's, and its
		// .toc is not looked for: the key no longer has the folder's capital letters.
		if (r.folder) return;
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

await db('store_repo_stats', { stats });
console.log(
	`Checked ${stats.length} repositories: ${stats.filter((s) => s.missing).length} no longer exist, ` +
		`${stats.filter((s) => s.canonical && s.canonical !== s.key).length} have moved, ` +
		`${stats.filter((s) => s.interface !== null).length} have a readable .toc.`
);
