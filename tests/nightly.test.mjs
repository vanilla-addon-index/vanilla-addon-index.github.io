import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { askGithub, fieldFailed } from '../src/lib/nightly-github.ts';

// Runs the actual importer with local answers for every endpoint. No hosted writes.
function run(scenario, configured = true) {
	const script = `
const scenario = ${JSON.stringify(scenario)};
const calls = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
globalThis.fetch = async (url, init = {}) => {
 if (url.includes('turtle-wow.fandom.com/api.php')) return json({parse: {revid: 1, wikitext: '===Full Addons List===\\n* [https://github.com/a/addon Addon] description\\n==SuperWoW Addons==\\n==ClassicAPI Addons==\\n==Further Addons Collections=='}});
 if (url.includes('/rest/v1/rpc/')) {
  const name = url.split('/').at(-1);
  const {token, ...args} = JSON.parse(init.body);
  calls.push({name, args});
  if (name === 'nightly_links') return json([{key: 'github.com/a/addon', url: 'https://github.com/a/addon', readme: true, images: scenario === 'image-failure' ? ['https://i.imgur.com/wiki.png'] : []}]);
  if (name === 'nightly_waiting') return json({reports:0, suggestions:0});
  return json(0);
 }
 if (url === 'https://i.imgur.com/wiki.png') return new Response('refused', {status:403});
 if (url === 'https://api.github.com/graphql') {
  const query = JSON.parse(init.body).query;
  if (query.includes('stargazerCount')) {
   const repo = {nameWithOwner:'a/addon',stargazerCount:3,pushedAt:'2026-01-01T00:00:00Z',isArchived:false,parent:null,
    code:{history:{nodes:[{committedDate:'2024-01-01T00:00:00Z'}]}},
    top:{entries: scenario === 'confirmed-absence' ? [] : [{name:'Addon.toc',type:'blob'},{name:'README.md',type:'blob'}]}};
   if (scenario === 'directory-failure') {repo.top=null; return json({data:{r0:repo},errors:[{type:'INTERNAL',path:['r0','top']}]});}
   if (scenario === 'metadata-failure') {repo.stargazerCount=null; return json({data:{r0:repo},errors:[{type:'INTERNAL',path:['r0','stargazerCount']}]});}
   return json({data:{r0:repo}});
  }
  if (query.includes('f0:')) return scenario === 'toc-failure'
   ? json({data:{r0:{f0:null}},errors:[{type:'INTERNAL',path:['r0','f0']}]})
   : json({data:{r0:{f0:{text:'## Interface: 11200'}}}});
  if (query.includes('readme:')) return scenario === 'readme-failure'
   ? json({data:{r0:{readme:null}},errors:[{type:'INTERNAL',path:['r0','readme']}]})
   : json({data:{r0:{readme:{text:'No screenshots in this README.'}}}});
 }
 throw new Error('Unexpected endpoint: '+url);
};
await import(${JSON.stringify(new URL('../scripts/nightly.mjs', import.meta.url).href)});
console.log('__RESULT__' + JSON.stringify(calls));
`;
	const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
		encoding: 'utf8', timeout: 10_000,
		env: { ...process.env, NIGHTLY_TOKEN: configured ? 'dummy-nightly-token' : '', GITHUB_TOKEN: 'dummy-github-token', GITHUB_OUTPUT: '' }
	});
	if (!configured) return result;
	assert.equal(result.status, 0, result.stderr + result.stdout);
	return JSON.parse(result.stdout.split('__RESULT__')[1]);
}

test('partial GitHub directory and file failures preserve versions and do not complete failed README checks', () => {
	for (const scenario of ['directory-failure', 'toc-failure', 'readme-failure', 'image-failure']) {
		const calls = run(scenario);
		const row = calls.find((c) => c.name === 'store_repo_stats').args.stats[0];
		assert.equal(row.interface_checked, !['directory-failure', 'toc-failure'].includes(scenario), scenario);
		assert.equal(row.stars, 3);
		if (scenario !== 'toc-failure') assert.ok(!calls.some((c) => c.name === 'store_queue_images'), scenario);
		assert.equal(calls.find((c) => c.name === 'store_code_updates').args.updates.length, 1);
	}
});

test('confirmed absence can clear an old version and finish a screenshot check', () => {
	const calls = run('confirmed-absence');
	const row = calls.find((c) => c.name === 'store_repo_stats').args.stats[0];
	assert.equal(row.interface, null);
	assert.equal(row.interface_checked, true);
	assert.deepEqual(calls.find((c) => c.name === 'store_queue_images').args.items[0].images, []);
});

test('a failed repository field cannot overwrite known facts with defaults', () => {
	const calls = run('metadata-failure');
	assert.deepEqual(calls.find((c) => c.name === 'store_repo_stats').args.stats, []);
	assert.equal(calls.find((c) => c.name === 'store_code_updates').args.updates.length, 1);
});

test('missing nightly configuration fails instead of silently skipping the import', () => {
	const result = run('confirmed-absence', false);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Nightly requires/);
	assert.ok(!result.stdout.includes('__RESULT__'));
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
	const nightly = readFileSync(new URL('../.github/workflows/nightly.yml', import.meta.url), 'utf8');
	const deploy = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
	const prepare = readFileSync(new URL('../.github/workflows/prepare.yml', import.meta.url), 'utf8');
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
