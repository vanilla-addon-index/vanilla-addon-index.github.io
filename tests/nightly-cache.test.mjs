import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { advanceGithubCache, githubCache, githubFiles, githubScope } from '../src/lib/nightly-cache.ts';

const hash = (char) => char.repeat(40);
const url = 'https://github.com/a/addon';
function run(options = {}) {
	const child = spawnSync(process.execPath, [fileURLToPath(new URL('fixtures/nightly-cache-runner.mjs', import.meta.url))], {
		encoding: 'utf8', timeout: 10_000,
		env: { ...process.env, NIGHTLY_CACHE_FIXTURE: JSON.stringify(options), NIGHTLY_TOKEN: 'fixture', GITHUB_TOKEN: 'fixture', GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' }
	});
	assert.equal(child.status, options.fail?.startsWith('store_') ? 1 : 0, child.stdout + child.stderr);
	const result = JSON.parse(child.stdout.split('__CACHE_RESULT__')[1].split('\n')[0]);
	result.metrics = JSON.parse(child.stdout.split('Nightly metrics: ')[1].split('\n')[0]);
	return result;
}
const count = (run, name) => run.calls.filter((call) => call.name === name).length;
const facts = (run) => run.calls.filter((c) => c.name === 'store_repo_stats').flatMap((c) => c.args.stats);

test('a cold check fills the cache; an unchanged branch needs only fresh metadata', () => {
	const cold = run();
	assert.equal(count(cold, 'details'), 1);
	assert.equal(count(cold, 'toc'), 1);
	assert.equal(count(cold, 'readme'), 1);
	assert.equal(cold.cache[url].head, hash('a'));
	assert.equal(cold.cache[url].toc.files[0].oid, hash('c'));
	const warm = run({ cache: cold.cache, stars: 19, archived: true });
	assert.equal(count(warm, 'metadata'), 1);
	for (const name of ['details', 'toc', 'readme', 'store_repo_check_cache']) assert.equal(count(warm, name), 0, name);
	assert.equal(facts(warm)[0].stars, 19);
	assert.equal(facts(warm)[0].archived, true);
	assert.equal(facts(warm)[0].interface, 11200);
	assert.equal(count(warm, 'store_code_updates'), 1);
	assert.equal(warm.metrics.counters.cache_hits, 4);
});

test('changed branches refresh history and directories but reuse unchanged file identifiers', () => {
	const cold = run();
	const changed = run({ cache: cold.cache, head: hash('e'), tree: hash('f'), date: '2025-01-01T00:00:00Z' });
	assert.equal(count(changed, 'details'), 1);
	assert.equal(count(changed, 'toc'), 0);
	assert.equal(count(changed, 'readme'), 0);
	assert.equal(changed.cache[url].history.date, '2025-01-01T00:00:00Z');
	assert.match(changed.calls.find((c) => c.name === 'details').query, new RegExp(hash('e')));
	const fileChanged = run({ cache: changed.cache, head: hash('1'), tree: hash('2'), toc: hash('3'), interface: 20400 });
	assert.equal(count(fileChanged, 'toc'), 1);
	assert.equal(fileChanged.cache[url].toc.interface, 20400);
	assert.match(fileChanged.calls.find((c) => c.name === 'toc').query, new RegExp(hash('1') + ':Addon.toc'));
});

test('partial history, directory, toc and README failures are retried on the same commit', () => {
	for (const failure of ['history', 'directory', 'toc', 'readme']) {
		const partial = run({ fail: failure });
		const next = run({ cache: partial.cache });
		assert.equal(next.cache[url].toc.interface, 11200, failure);
		assert.ok(next.cache[url].history.date, failure);
		if (failure === 'history') {
			assert.equal(count(next, 'details'), 1);
			assert.ok(!next.calls.find((c) => c.name === 'details').query.includes('top:'));
			assert.equal(count(next, 'toc'), 0);
		}
		if (failure === 'directory') assert.equal(count(next, 'details'), 1);
		if (failure === 'toc') { assert.equal(count(next, 'details'), 0); assert.equal(count(next, 'toc'), 1); }
		if (failure === 'readme') { assert.equal(count(next, 'details'), 0); assert.equal(count(next, 'readme'), 1); }
	}
});

test('cache failures do not block public dates or facts; cached dates can repair a failed date save', () => {
	const failedCache = run({ fail: 'store_repo_check_cache' });
	assert.equal(Object.keys(failedCache.cache).length, 0);
	assert.equal(count(failedCache, 'store_code_updates'), 1);
	assert.equal(facts(failedCache).at(-1).interface, 11200);
	const failedDates = run({ fail: 'store_code_updates' });
	const repaired = run({ cache: failedDates.cache });
	assert.equal(count(repaired, 'details'), 0);
	assert.equal(count(repaired, 'store_code_updates'), 1);
});

test('replacement repositories, renames, parser changes and failed head checks never reuse stale cache', () => {
	const cold = run();
	for (const settings of [{ identity: 'replacement' }, { canonical: 'new/addon' }, { fail: 'head' }, { cache: { [url]: { ...cold.cache[url], version: 0 } } }]) {
		const next = run({ cache: cold.cache, ...settings });
		assert.equal(count(next, 'details'), 1);
		assert.equal(count(next, 'toc'), 1);
	}
});

test('cached README extraction can survive a pending wiki-image check without marking it complete', () => {
	const first = run({ imageFailure: true });
	assert.equal(count(first, 'store_queue_images'), 0);
	const next = run({ cache: first.cache, imageFailure: true });
	assert.equal(count(next, 'readme'), 0);
	assert.equal(count(next, 'store_queue_images'), 0);
	assert.equal(next.metrics.counters.screenshot_checks_incomplete, 1);
});

test('daily availability checks override a warm cache, while failed checks retain known facts', () => {
	const cold = run();
	const missing = run({cache:cold.cache, missing:true});
	assert.equal(facts(missing)[0].missing, true);
	assert.equal(count(missing, 'store_code_updates'), 0);
	const failed = run({cache:cold.cache, fail:'metadata'});
	assert.equal(facts(failed).length, 0);
	assert.equal(count(failed, 'store_code_updates'), 0);
	assert.deepEqual(failed.cache, cold.cache);
});

test('an exact-link cache cannot be borrowed by another branch, folder or fork', () => {
	const cold = run();
	for (const other of [url + '/tree/vanilla', url + '/tree/HEAD/Folder', 'https://github.com/fork/addon']) {
		const next = run({cache:{[other]:cold.cache[url]}, links:[{key:other.replace('https://',''),url:other,readme:false}]});
		assert.equal(count(next, 'details'), 1, other);
		assert.equal(count(next, 'toc'), 1, other);
		assert.notEqual(next.cache[other].scope, cold.cache[url].scope);
	}
});

test('cache scope preserves branch and folder case, repository identity, and nested file identifiers', () => {
	const scope = githubScope('A', 'Addon', 'HEAD', 'Folder');
	const previous = { version: 1, kind: 'github', scope, identity: 'id', canonical: 'a/addon', head: hash('a'), history: {date:'2020-01-01T00:00:00Z'} };
	assert.equal(githubCache(previous, githubScope('a', 'addon', 'other', 'Folder')), undefined);
	assert.equal(githubCache(previous, githubScope('a', 'addon', 'HEAD', 'folder')), undefined);
	assert.equal(githubCache({...previous, tree:{oid:hash('b'),entries:[null]}, toc:{signature:'x',interface:11200,files:[null]}}, scope).tree, undefined);
	assert.equal(advanceGithubCache(previous, scope, 'fork', 'a/addon', hash('a')).history, undefined);
	const selected = githubFiles([{name:'Nested', type:'tree', oid:hash('b')}], 'Folder', 4);
	assert.deepEqual(selected.paths, ['Folder/Nested/Nested.toc']);
	assert.match(selected.signature, new RegExp(hash('b')));
});
