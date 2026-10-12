// Nightly import job, run by .github/workflows/nightly.yml.
//   1. Reads the wiki and queues addons that are neither live nor already reviewed.
//   2. Trims the log and the trash of what is older than 90 days.
//   3. Counts the reports and suggestions waiting for an admin, for the workflow to tell
//      them about.
//   4. Asks GitHub about every queued and live repository (stars, last update, archived,
//      fork parent, current address, and the game version its .toc file declares) and
//      stores the answers for the review page.
//   5. Looks at the screenshots of each queued entry, once: keeps the wiki's that still
//      load, adds the ones in the repository's README, and stores them for the review.
//
// Needs NIGHTLY_TOKEN, and GITHUB_TOKEN for step 4. Without the token it does nothing, so
// the deploy keeps working before the secret is configured.
//
// The job signs in like any visitor. The token is what lets it do these few things and
// nothing else; see the nightly token migration, and `npm run nightly:token` to make one.
import { appendFileSync } from 'node:fs';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../src/lib/config.ts';
import { imagesIn, uncamo } from '../src/lib/github.ts';
import { hostAllowed } from '../src/lib/hosts.ts';
import { githubPlace } from '../src/lib/links.ts';
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
// READMEs are long; fewer of them go into one request.
const README_BATCH = 15;

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

// 1. Wiki -> queue. The database refuses a page that lists far fewer addons than it did
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

// 4. GitHub -> repo_stats.
if (!githubToken) {
	console.log('GITHUB_TOKEN is not set, skipping the repository stats.');
	process.exit(0);
}

// A key is a repository, or a folder in one for a repository that holds many addons.
// Each link comes as it was written, since its key leaves out the branch and has no capital
// letters: where to look for the .toc is read from the link itself. One key, one check.
const repos = [];
// Whether a picture is still there. Only a plain "gone" counts: a host that is slow, or
// that turns this job away while it serves browsers, gets the benefit of the doubt.
async function gone(image) {
	try {
		const res = await fetch(image, { signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'vanilla-addon-index' } });
		await res.body?.cancel();
		// imgur answers for a picture it has removed with a picture that says so.
		return res.status === 404 || res.status === 410 || /\/removed\./.test(res.url);
	} catch {
		return false;
	}
}

// The pictures a queued entry has from the wiki, with proxy addresses turned back into
// the real ones, and without those that are gone. A few at a time.
async function stillThere(images) {
	const real = [...new Set(images.map(uncamo))].filter((image) => image.startsWith('https://'));
	const kept = [];
	for (let i = 0; i < real.length; i += 5) {
		const batch = real.slice(i, i + 5);
		const dead = await Promise.all(batch.map(gone));
		kept.push(...batch.filter((_, n) => !dead[n]));
	}
	return kept;
}

// Queued entries whose pictures are to be looked at, and what was settled for each.
const pictures = [];
const links = await db('nightly_links');
const toLookAt = links.filter((l) => l.readme);
const wikiPictures = new Map();
for (let i = 0; i < toLookAt.length; i += 10) {
	await Promise.all(
		toLookAt.slice(i, i + 10).map(async (l) => wikiPictures.set(l.key, l.images?.length ? await stillThere(l.images) : []))
	);
}

for (const { key, url, readme } of links) {
	const place = githubPlace(url);
	// Not on GitHub: there is no README to read, so the pictures that are left are it.
	if (!place && readme) pictures.push({ key, images: wikiPictures.get(key) ?? [] });
	if (!place || repos.some((r) => r.key === key)) continue;
	// What the key has after the repository: the folder, as the stored address needs it.
	const folder = /^github\.com\/[^/]+\/[^/]+(\/.+)?$/.exec(key)?.[1] ?? '';
	// "readme": a queued entry whose pictures have not been looked at yet; "wiki": the
	// ones it has from the wiki that still load.
	repos.push({ key, ...place, folder, ref: place.ref || 'HEAD', readme, wiki: wikiPictures.get(key) ?? [] });
}

// One request to GitHub, tried up to three times: it now and then fails to answer a large
// request in time. Gives nothing when it still has not answered, and the run is marked as
// failed so that this is seen; whoever asked goes on without that batch.
async function github(query) {
	let problem = '';
	for (let attempt = 1; attempt <= 3; attempt++) {
		if (attempt > 1) await new Promise((wait) => setTimeout(wait, attempt * 5000));
		try {
			const res = await fetch('https://api.github.com/graphql', {
				method: 'POST',
				headers: { Authorization: `Bearer ${githubToken}`, 'User-Agent': 'vanilla-addon-index' },
				body: JSON.stringify({ query })
			});
			// The body of a failure can be a whole web page; its status says enough.
			if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
			// A repository or file that is gone comes back as null with an entry in "errors"; that is expected.
			const { data, errors = [] } = await res.json();
			if (!data) throw new Error(`GitHub returned no data: ${errors[0]?.message ?? 'no reason given'}`);
			// Which of the repositories asked for GitHub says do not exist. Anything else that came
			// back empty (a limit reached, a timeout on GitHub's side) is not an answer.
			const gone = new Set(errors.filter((e) => e.type === 'NOT_FOUND' && e.path?.length === 1).map((e) => e.path[0]));
			return { data, gone };
		} catch (error) {
			problem = error.message;
		}
	}
	console.error(`GitHub did not answer a request after three tries: ${problem}`);
	process.exitCode = 1;
	return null;
}

const repository = (r, n, fields) =>
	`r${n}: repository(owner: ${JSON.stringify(r.owner)}, name: ${JSON.stringify(r.name)}) { ${fields} }`;

// First pass: the facts, and what sits at the top of each repository.
const stats = [];
const withToc = [];
// Queued entries whose README is to be read.
const withReadme = [];
let unanswered = 0;
for (let i = 0; i < repos.length; i += BATCH) {
	const batch = repos.slice(i, i + BATCH);
	// One aliased field per repository, so a whole batch costs one request.
	const answer = await github(
		`{${batch
			.map((r, n) =>
				repository(
					r,
					n,
					`nameWithOwner stargazerCount pushedAt isArchived parent { nameWithOwner } top: object(expression: ${JSON.stringify(`${r.ref}:${r.path}`)}) { ... on Tree { entries { name type } } }`
				)
			)
			.join(' ')}}`
	);
	// No answer about the whole batch: see below.
	if (!answer) {
		unanswered += batch.length;
		continue;
	}
	const { data, gone } = answer;
	batch.forEach((r, n) => {
		const repo = data[`r${n}`];
		// No answer about this one: what was stored about it last time stays as it is,
		// rather than a live repository being marked as gone.
		if (!repo && !gone.has(`r${n}`)) return unanswered++;
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

		// An addon's .toc is at the top of what the link points to (the repository, a branch
		// of it, or a folder in it), or one folder down in a folder of the same name. For a
		// folder of a collection the facts above are still the whole repository's.
		const within = r.path ? `${r.path}/` : '';
		const entries = repo?.top?.entries ?? [];
		const atTop = entries.filter((e) => e.type === 'blob' && /\.toc$/i.test(e.name)).map((e) => `${within}${e.name}`);
		const nested = entries
			.filter((e) => e.type === 'tree' && !e.name.startsWith('.'))
			.map((e) => `${within}${e.name}/${e.name}.toc`);
		const paths = (atTop.length ? atTop : nested).slice(0, TOC_PATHS);
		if (paths.length) withToc.push({ ...r, row, paths });

		// The README sits in the same place, under one of a few spellings.
		if (r.readme && repo) {
			const file = entries.find((e) => e.type === 'blob' && /^readme(\.(md|markdown|mdown|txt|rst))?$/i.test(e.name))?.name;
			// Without one there is nothing to add to the wiki's, and it is not looked for again.
			if (file) withReadme.push({ ...r, full: repo.nameWithOwner, file: `${within}${file}` });
			else pictures.push({ key: r.key, images: r.wiki });
		}
	});
}

// Second pass: read those .toc files for the "## Interface:" line.
for (let i = 0; i < withToc.length; i += TOC_BATCH) {
	const batch = withToc.slice(i, i + TOC_BATCH);
	const answer = await github(
		`{${batch
			.map((r, n) =>
				repository(
					r,
					n,
					r.paths
						.map((p, f) => `f${f}: object(expression: ${JSON.stringify(`${r.ref}:${p}`)}) { ... on Blob { text } }`)
						.join(' ')
				)
			)
			.join(' ')}}`
	);
	// Without their .toc files these are not stored at all, so that the game version known
	// from last time is not replaced by "unknown".
	if (!answer) {
		for (const r of batch) stats.splice(stats.indexOf(r.row), 1);
		unanswered += batch.length;
		continue;
	}
	const { data } = answer;
	batch.forEach((r, n) => {
		const found = r.paths
			.map((_, f) => /^##\s*Interface:\s*(\d+)/im.exec(data[`r${n}`]?.[`f${f}`]?.text ?? '')?.[1])
			.filter(Boolean)
			.map(Number);
		// A repository can ship .toc files for several clients; the 1.12 one is what matters.
		if (found.length) r.row.interface = found.includes(11200) ? 11200 : found[0];
	});
}

// Third pass: the READMEs of queued entries that have no screenshot, for the pictures in
// them. Kept to the sites a screenshot may be on, like any other. An entry GitHub gave
// no answer about is left for the next run.
for (let i = 0; i < withReadme.length; i += README_BATCH) {
	const batch = withReadme.slice(i, i + README_BATCH);
	const answer = await github(
		`{${batch
			.map((r, n) => repository(r, n, `readme: object(expression: ${JSON.stringify(`${r.ref}:${r.file}`)}) { ... on Blob { text } }`))
			.join(' ')}}`
	);
	if (!answer) continue;
	batch.forEach((r, n) => {
		const repo = answer.data[`r${n}`];
		if (!repo) return;
		// Where the README is served from, so that a picture kept next to it resolves.
		const base = `https://raw.githubusercontent.com/${r.full}/${r.ref}/${r.file}`;
		const found = imagesIn(repo.readme?.text ?? '', base).filter((image) => hostAllowed(image, 'image'));
		// The wiki's first, since someone chose those; then the README's, each picture once.
		pictures.push({ key: r.key, images: [...new Set([...r.wiki, ...found])].slice(0, 5) });
	});
}
if (pictures.length) {
	try {
		const given = await db('store_queue_images', { items: pictures });
		console.log(`Looked at the screenshots of ${pictures.length} queued entries: ${given} have pictures now.`);
	} catch (error) {
		console.error(`Could not store the screenshots found in READMEs: ${error.message}`);
		process.exitCode = 1;
	}
}

await db('store_repo_stats', { stats });
console.log(
	`Checked ${stats.length} repositories: ${stats.filter((s) => s.missing).length} no longer exist, ` +
		`${stats.filter((s) => s.canonical && s.canonical !== s.key).length} have moved, ` +
		`${stats.filter((s) => s.interface !== null).length} have a readable .toc.` +
		(unanswered ? ` GitHub gave no answer about ${unanswered}; what was known about those is kept.` : '')
);
