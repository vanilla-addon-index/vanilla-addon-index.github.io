import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { askGithub, fieldFailed } from '../../src/lib/nightly-github.ts';

// Runs the actual importer with local answers for every endpoint. No hosted writes.
function run(scenario, configured = true, details = false, summaryPath = '') {
	const script = `
const scenario = ${JSON.stringify(scenario)};
const calls = [];
let metadataBatches = 0;
const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
globalThis.fetch = async (url, init = {}) => {
 if (url.includes('turtle-wow.fandom.com/api.php')) return json({parse: {revid: 1, wikitext: '===Full Addons List===\\n* [https://github.com/a/addon Addon] description\\n==SuperWoW Addons==\\n==ClassicAPI Addons==\\n==Further Addons Collections=='}});
 if (url.includes('/rest/v1/rpc/')) {
  const name = url.split('/').at(-1);
  const {token, ...args} = JSON.parse(init.body);
  calls.push({name, args});
  if (scenario === name + '-failure') return json({message:'Store refused for this test'}, 400);
  if (name === 'store_code_updates' && scenario === 'batched-store-failure' && calls.filter((c) => c.name === name).length === 1) {
   calls.at(-1).failed = true; return json({message:'First date batch refused'}, 400);
  }
  if (name === 'nightly_links' && ['batched', 'batched-store-failure', 'late-stop'].includes(scenario)) return json(Array.from({length:101}, (_, i) => ({key:'github.com/a/addon'+i, url:'https://github.com/a/addon'+i, readme:true, images:[]})));
  if (name === 'nightly_links' && scenario === 'branches') return json([
   {key:'github.com/a/addon', url:'https://github.com/a/addon', readme:false},
   {key:'github.com/a/addon', url:'https://github.com/a/addon/tree/other', readme:false}
  ]);
  if (name === 'nightly_links' && ['forge-batched', 'forge-late-stop'].includes(scenario)) return json(Array.from({length:9}, (_, i) => ({key:'codeberg.org/a/addon'+i, url:'https://codeberg.org/a/addon'+i, readme:true, images:[]})));
  if (name === 'nightly_links') return json([{key: 'github.com/a/addon', url: 'https://github.com/a/addon', category_item: scenario.startsWith('category-') ? {name:'ChatThing', description:'Chat addon', category_context:{}} : undefined, readme: !['already-checked', 'category-all'].includes(scenario), images: scenario === 'image-failure' ? ['https://i.imgur.com/wiki.png'] : []}]);
  if (name === 'nightly_waiting') return json({reports:0, suggestions:0});
  return json(0);
 }
 if (url.startsWith('https://codeberg.org/api/')) {
  calls.push({name:'forge', url});
  if (url.includes('/addon8') && scenario === 'forge-late-stop') {console.log('__RESULT__' + JSON.stringify(calls)); process.exit(2);}
  if (url.includes('/commits?')) return json([{commit:{committer:{date:'2024-01-01T00:00:00Z'}}}]);
  if (url.includes('/contents/')) return json([]);
  return json({full_name: /repos\\/(a\\/addon\\d+)/.exec(url)[1], default_branch:'main', stars_count:1});
 }
 if (url === 'https://i.imgur.com/wiki.png') return new Response('refused', {status:403});
 if (url === 'https://api.github.com/graphql') {
  const query = JSON.parse(init.body).query;
  calls.push({name:'github', phase:query.includes('stargazerCount') ? 'metadata' : query.includes('code:') || query.includes('top:') ? 'details' : query.includes('f0:') ? 'toc' : 'readme'});
  if (query.includes('stargazerCount') || query.includes('code:') || query.includes('top:')) {
   if (query.includes('stargazerCount') && ++metadataBatches === 3 && scenario === 'late-stop') {console.log('__RESULT__' + JSON.stringify(calls)); process.exit(2);}
   const repo = {description:'A damage meter',nameWithOwner:'a/addon',stargazerCount:3,pushedAt:'2026-01-01T00:00:00Z',isArchived:false,parent:null,
    code:{history:{nodes:[{committedDate:'2024-01-01T00:00:00Z'}]}},
    top:{entries: scenario === 'confirmed-absence' ? [] : [{name:'Addon.toc',type:'blob'},{name:'README.md',type:'blob'}]}};
   if (scenario === 'directory-failure') {repo.top=null; return json({data:{r0:repo},errors:[{type:'INTERNAL',path:['r0','top']}]});}
   if (scenario === 'metadata-failure') {repo.stargazerCount=null; return json({data:{r0:repo},errors:[{type:'INTERNAL',path:['r0','stargazerCount']}]});}
   if (scenario === 'history-failure') {repo.code=null; return json({data:{r0:repo},errors:[{type:'INTERNAL',path:['r0','code']}]});}
   const data = Object.fromEntries([...query.matchAll(/r(\\d+): repository\\(owner: "([^"]+)", name: "([^"]+)"/g)].map(([, n, owner, name]) => ['r'+n, {...repo, nameWithOwner:owner+'/'+name}]));
   return json({data});
  }
  if (query.includes('f0:')) return ['toc-failure', 'category-toc-failure'].includes(scenario)
   ? json({data:{r0:{f0:null}},errors:[{type:'INTERNAL',path:['r0','f0']}]})
   : json({data:Object.fromEntries([...query.matchAll(/r(\\d+): repository/g)].map(([, n]) => ['r'+n, {f0:{text:'## Interface: 11200\\n## Notes: Tracks damage'}}]))});
  if (query.includes('readme:')) return ['readme-failure', 'category-readme-failure'].includes(scenario)
   ? json({data:{r0:{readme:null}},errors:[{type:'INTERNAL',path:['r0','readme']}]})
   : json({data:Object.fromEntries([...query.matchAll(/r(\\d+): repository/g)].map(([, n]) => ['r'+n, {readme:{text:'No screenshots in this README.'}}]))});
 }
 throw new Error('Unexpected endpoint: '+url);
};
await import(${JSON.stringify(new URL('../../scripts/nightly.mjs', import.meta.url).href)});
console.log('__RESULT__' + JSON.stringify(calls));
`;
	const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
		encoding: 'utf8', timeout: 10_000,
		env: { ...process.env, NIGHTLY_TOKEN: configured ? 'dummy-nightly-token' : '', GITHUB_TOKEN: 'dummy-github-token', GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: summaryPath }
	});
	if (!configured) return result;
	const expectedStatus = scenario.endsWith('late-stop') ? 2 : scenario === 'batched-store-failure' || scenario.endsWith('-failure') && scenario.startsWith('store_') ? 1 : 0;
	assert.equal(result.status, expectedStatus, result.stderr + result.stdout);
	const calls = JSON.parse(result.stdout.split('__RESULT__')[1].split('\n')[0]);
	return details ? {calls, metrics: JSON.parse(result.stdout.split('Nightly metrics: ')[1].split('\n')[0]), stdout: result.stdout} : calls;
}

test('partial GitHub directory and file failures preserve versions and do not complete failed README checks', () => {
	for (const scenario of ['directory-failure', 'toc-failure', 'readme-failure', 'image-failure']) {
		const calls = run(scenario);
		const row = calls.filter((c) => c.name === 'store_repo_stats').at(-1).args.stats[0];
		assert.equal(row.interface_checked, !['directory-failure', 'toc-failure'].includes(scenario), scenario);
		assert.equal(row.stars, 3);
		if (scenario !== 'toc-failure') assert.ok(!calls.some((c) => c.name === 'store_queue_images'), scenario);
		assert.equal(calls.find((c) => c.name === 'store_code_updates').args.updates.length, 1);
	}
});

test('confirmed absence can clear an old version and finish a screenshot check', () => {
	const calls = run('confirmed-absence');
	const row = calls.filter((c) => c.name === 'store_repo_stats').at(-1).args.stats[0];
	assert.equal(row.interface, null);
	assert.equal(row.interface_checked, true);
	assert.deepEqual(calls.find((c) => c.name === 'store_queue_images').args.items[0].images, []);
});

test('a failed repository field cannot overwrite known facts with defaults', () => {
	const calls = run('metadata-failure');
	assert.ok(!calls.some((c) => c.name === 'store_repo_stats'));
	assert.equal(calls.find((c) => c.name === 'store_code_updates').args.updates.length, 1);
});

test('missing nightly configuration fails instead of silently skipping the import', () => {
	const result = run('confirmed-absence', false);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Nightly requires/);
	assert.ok(!result.stdout.includes('__RESULT__'));
});

test('completed metadata and dates survive a later interruption before file checks', () => {
	const calls = run('late-stop');
	const facts = calls.filter((c) => c.name === 'store_repo_stats').flatMap((c) => c.args.stats);
	const dates = calls.filter((c) => c.name === 'store_code_updates').flatMap((c) => c.args.updates);
	assert.equal(facts.length, 100);
	assert.equal(dates.length, 100);
	assert.equal(new Set(dates.map((row) => row.url)).size, 100);
	assert.ok(facts.every((row) => row.interface_checked === false));
	assert.ok(!calls.some((c) => c.phase === 'toc'));
});

test('facts, dates and completed screenshots are saved in bounded batches between network phases', () => {
	const calls = run('batched');
	for (const [name, field] of [['store_repo_stats', 'stats'], ['store_code_updates', 'updates'], ['store_queue_images', 'items']]) {
		const writes = calls.filter((c) => c.name === name);
		assert.ok(writes.length > 1, name);
		assert.ok(writes.every((c) => c.args[field].length <= 50), name);
	}
	const firstWrite = calls.findIndex((c) => c.name === 'store_repo_stats');
	const secondMetadata = calls.findIndex((c, i) => i > 0 && c.phase === 'metadata' && calls.slice(0, i).some((before) => before.phase === 'metadata'));
	assert.ok(firstWrite < secondMetadata);
	const firstToc = calls.findIndex((c) => c.phase === 'toc');
	const initialFacts = calls.slice(0, firstToc).filter((c) => c.name === 'store_repo_stats').flatMap((c) => c.args.stats);
	assert.equal(initialFacts.length, 101);
	assert.ok(initialFacts.every((row) => row.interface_checked === false));
	const completed = calls.slice(firstToc).filter((c) => c.name === 'store_repo_stats').flatMap((c) => c.args.stats);
	assert.equal(completed.length, 101);
	assert.ok(completed.every((row) => row.interface_checked && row.interface === 11200));
	assert.equal(calls.filter((c) => c.name === 'store_queue_images').flatMap((c) => c.args.items).length, 101);
});

test('each failed store leaves other result types and later phases running', () => {
	for (const failed of ['store_repo_stats', 'store_code_updates', 'store_queue_images']) {
		const calls = run(failed + '-failure');
		for (const name of ['store_repo_stats', 'store_code_updates', 'store_queue_images']) {
			assert.ok(calls.some((c) => c.name === name), `${failed} must not block ${name}`);
		}
		assert.ok(calls.some((c) => c.phase === 'readme'), failed);
	}
});

test('a rejected checkpoint does not block subsequent batches of the same result type', () => {
	const {calls, metrics} = run('batched-store-failure', true, true);
	const dates = calls.filter((c) => c.name === 'store_code_updates');
	assert.deepEqual(dates.map((c) => c.args.updates.length), [50, 50, 1]);
	assert.equal(dates.filter((c) => !c.failed).flatMap((c) => c.args.updates).length, 51);
	assert.equal(metrics.counters.dates_records_not_saved, 50);
	assert.equal(metrics.counters.commit_dates_left_unchanged, 50);
	assert.equal(metrics.counters.pictures_records_saved, 101);
});

test('branch links retain separate dates while only the first branch supplies review facts', () => {
	const calls = run('branches');
	const facts = calls.filter((c) => c.name === 'store_repo_stats').flatMap((c) => c.args.stats);
	assert.equal(facts.length, 2); // Metadata, then the completed .toc of the first branch only.
	assert.equal(new Set(facts.map((row) => row.key)).size, 1);
	assert.equal(calls.filter((c) => c.name === 'store_code_updates').flatMap((c) => c.args.updates).length, 2);
});

test('other-host checkpoints survive an interruption while another worker is active', () => {
	const calls = run('forge-late-stop');
	for (const [name, field] of [['store_repo_stats', 'stats'], ['store_code_updates', 'updates'], ['store_queue_images', 'items']]) {
		const writes = calls.filter((c) => c.name === name);
		// Seven checks have checkpointed before a worker starts the ninth.
		// The eighth may be between its independent stores at interruption.
		const rows = writes.flatMap((c) => c.args[field]);
		assert.ok(rows.length >= 7 && rows.length <= 8, name);
		assert.equal(new Set(rows.map((row) => row.key ?? row.url)).size, rows.length, name);
	}
});

test('a subsequent run skips screenshot work already marked complete by the database', () => {
	assert.ok(run('success').some((c) => c.name === 'store_queue_images'));
	const resumed = run('already-checked');
	assert.ok(!resumed.some((c) => c.phase === 'readme' || c.name === 'store_queue_images'));
	assert.ok(resumed.some((c) => c.name === 'store_code_updates'));
});

test('diagnostics distinguish network requests, field failures, unchanged dates and host work', () => {
	const {metrics, stdout} = run('success', true, true);
	assert.equal(metrics.phases['GitHub metadata'].attempts, 1);
	assert.equal(metrics.phases['GitHub .toc'].attempts, 1);
	assert.equal(metrics.phases['GitHub README'].attempts, 1);
	assert.equal(metrics.phases['Database reads'].attempts, 2);
	assert.equal(metrics.phases['Database writes'].attempts, 7);
	assert.equal(metrics.counters.commit_dates_left_unchanged, 0);
	assert.equal(metrics.counters.cache_hits, 0);
	assert.match(stdout, /\[Nightly\] GitHub metadata 1\/1/);
	assert.ok(!stdout.includes('dummy-nightly-token') && !stdout.includes('dummy-github-token'));
	const partial = run('history-failure', true, true).metrics;
	assert.equal(partial.phases['GitHub history + files'].failedRequests, 0);
	assert.equal(partial.counters.github_history_checks_without_result, 1);
	assert.equal(partial.counters.commit_dates_left_unchanged, 1);
	const refused = run('store_code_updates-failure', true, true).metrics;
	assert.equal(refused.phases['Database writes'].failedRequests, 1);
	assert.equal(refused.counters.commit_dates_left_unchanged, 1);
	const forge = run('forge-batched', true, true).metrics;
	assert.equal(forge.phases.Codeberg.attempts, 27);
	assert.equal(forge.phases.GitLab.attempts, 0);
	assert.equal(forge.counters.dates_records_saved, 9);
});

test('the job summary is written after both success and a late interruption', () => {
	const dir = mkdtempSync(join(tmpdir(), 'nightly-summary-'));
	try {
		for (const scenario of ['success', 'late-stop']) {
			const path = join(dir, scenario + '.md');
			run(scenario, true, false, path);
			const summary = readFileSync(path, 'utf8');
			assert.match(summary, /Nightly import diagnostics/);
			assert.match(summary, /Database writes/);
			assert.match(summary, scenario === 'late-stop' ? /\| dates_records_saved \| 100 \|/ : /\| dates_records_saved \| 1 \|/);
			assert.ok(!summary.includes('dummy-nightly-token') && !summary.includes('dummy-github-token'));
		}
	} finally {
		rmSync(dir, {recursive: true, force: true});
	}
});

test('GraphQL errors apply only to the affected field, its parents or children', () => {
	const errors = [{path:['r0','top','entries']}];
	assert.equal(fieldFailed(errors, ['r0','top']), true);
	assert.equal(fieldFailed(errors, ['r0','code']), false);
	assert.equal(fieldFailed(errors, ['r1','top']), false);
	assert.equal(fieldFailed([{path:['r0']}], ['r0','f0']), true);
	assert.equal(fieldFailed([{}], ['r0','top']), true);
});

test('HTTP 200 GraphQL rate-limit errors honour the reset instead of repeatedly sending queries', async () => {
	const fetcher = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => {
		calls++;
		return new Response(JSON.stringify({errors:[{type:'RATE_LIMITED',message:'API rate limit exceeded'}]}), {
			headers: {'retry-after':'3600'}
		});
	};
	try {
		await assert.rejects(askGithub('{ viewer { login } }', 'dummy'), /budget/);
		await assert.rejects(askGithub('{ viewer { login } }', 'dummy'), /budget/);
		assert.equal(calls, 1);
	} finally {
		globalThis.fetch = fetcher;
	}
});

test('Nightly prepares the schema first and only reuses preparation after it succeeds', () => {
	const nightly = readFileSync(new URL('../../.github/workflows/nightly.yml', import.meta.url), 'utf8');
	const deploy = readFileSync(new URL('../../.github/workflows/publish.yml', import.meta.url), 'utf8');
	const prepare = readFileSync(new URL('../../.github/workflows/prepare.yml', import.meta.url), 'utf8');
	const job = (yaml, name) => yaml.split(`\n  ${name}:\n`)[1]?.split(/\n  [\w-]+:\n/)[0];
	assert.match(job(nightly, 'prepare'), /uses: \.\/\.github\/workflows\/prepare.yml/);
	assert.match(job(nightly, 'import'), /needs: prepare/);
	assert.match(job(nightly, 'deploy'), /needs\.prepare\.result == 'success'/);
	assert.match(job(nightly, 'deploy'), /prepared: true/);
	assert.match(job(prepare, 'migrate'), /needs: check/);
	assert.match(job(prepare, 'migrate'), /exit 1/);
	assert.ok(!job(prepare, 'check').includes('SUPABASE_DB_PASSWORD'));
	assert.ok(!job(prepare, 'migrate').includes('npm ci'));
	assert.match(job(deploy, 'build'), /needs: prepare/);
	assert.match(job(deploy, 'build'), /needs\.prepare\.result == 'success'/);
});


test('every queued import gets category evidence even with an existing guess and completed screenshots', () => {
 const calls = run('category-all');
 const stored = calls.filter(c => c.name === 'store_category_context').flatMap(c => c.args.items);
 const context = Object.assign({}, ...stored.map(i => i.context));
 assert.equal(context.repository, 'A damage meter');
 assert.match(context.toc, /Tracks damage/);
 assert.match(context.readme, /No screenshots/);
 assert.ok(calls.some(c => c.name === 'github' && c.phase === 'readme'));
 assert.ok(!calls.some(c => c.name === 'store_queue_images'));
});


test('failed category file checks do not replace stored evidence with empty text', () => {
 for (const [scenario, source] of [['category-toc-failure', 'toc'], ['category-readme-failure', 'readme']]) {
  const calls = run(scenario);
  const stored = calls.filter(c => c.name === 'store_category_context').flatMap(c => c.args.items);
  assert.ok(stored.length > 0);
  assert.ok(stored.every(item => !(source in item.context)), scenario);
 }
});
