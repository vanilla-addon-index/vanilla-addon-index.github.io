import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {runWorkers} from '../../src/lib/nightly-workers.ts';

function run(scenario) {
	const child = spawnSync(process.execPath, [fileURLToPath(new URL('../helpers/nightly-concurrency-runner.mjs', import.meta.url))], {
		encoding:'utf8', timeout:10_000,
		env:{...process.env, NIGHTLY_CONCURRENCY_FIXTURE:scenario, NIGHTLY_TOKEN:'fixture', GITHUB_TOKEN:'fixture', GITHUB_OUTPUT:'', GITHUB_STEP_SUMMARY:''}
	});
	assert.equal(child.status, scenario === 'store-failure' ? 1 : 0, child.stderr + child.stdout);
	const result = JSON.parse(child.stdout.split('__CONCURRENCY_RESULT__')[1].split('\n')[0]);
	result.metrics = JSON.parse(child.stdout.split('Nightly metrics: ')[1].split('\n')[0]);
	return result;
}
const records = (run, name, field) => run.calls.filter((call) => call.name === name && !call.failed).flatMap((call) => call.args[field]);

test('all hosts overlap GitHub, respect two workers, and refill while a slow check remains pending', () => {
	const result = run('barriers');
	const githubStart = result.calls.findIndex((c) => c.name === 'github-start');
	const githubEnd = result.calls.findIndex((c) => c.name === 'github-end');
	for (const host of ['gitlab.com', 'codeberg.org', 'gitea.com']) {
		assert.equal(result.maximum[host], 2, host);
		const third = result.calls.findIndex((c) => c.name === 'rest-start' && c.host === host && c.url.endsWith('addon2'));
		const slowEnd = result.calls.findIndex((c) => c.name === 'rest-end' && c.host === host && c.url.endsWith('addon0'));
		assert.ok(githubStart < third && third < githubEnd, host + ' runs while GitHub is pending');
		assert.ok(third < slowEnd, host + ' refills without waiting for its slow worker');
	}
	assert.equal(result.maximumWrites, 1);
	for (const [name, field] of [['store_repo_stats','stats'], ['store_code_updates','updates'], ['store_queue_images','items'], ['store_repo_check_cache','items']]) {
		const rows = records(result, name, field);
		assert.equal(rows.length, 13, name);
		assert.equal(new Set(rows.map((row) => row.key ?? row.url)).size, 13, name);
	}
	assert.equal(result.metrics.counters.commit_dates_left_unchanged, 0);
});

test('a host rate limit leaves its known facts untouched while independent hosts finish', () => {
	const result = run('rate-limit');
	const facts = records(result, 'store_repo_stats', 'stats');
	assert.equal(facts.length, 9);
	assert.ok(facts.every((row) => !row.key.startsWith('gitlab.com')));
	assert.equal(result.calls.filter((c) => c.name === 'rest-start' && c.host === 'gitlab.com').length, 2);
	assert.equal(result.metrics.counters.other_host_metadata_checks_failed, 4);
	assert.equal(result.metrics.counters.commit_dates_left_unchanged, 4);
});

test('a refused checkpoint cannot stop concurrent hosts or discard other result types', () => {
	const result = run('store-failure');
	assert.equal(result.maximumWrites, 1);
	for (const [name, field] of [['store_code_updates','updates'], ['store_queue_images','items'], ['store_repo_check_cache','items']]) {
		assert.equal(records(result, name, field).length, 13, name);
	}
	assert.ok(result.metrics.counters.stats_records_not_saved > 0);
	assert.ok(result.metrics.counters.stats_records_saved > 0);
});

test('unexpected worker failures are reported after the queue finishes every item', async () => {
	const checked = [];
	await assert.rejects(runWorkers([0,1,2,3,4], 2, async (item) => {
		checked.push(item);
		if (item === 1 || item === 3) throw new Error('fixture');
	}), (error) => error instanceof AggregateError && error.errors.length === 2);
	assert.deepEqual(checked.sort(), [0,1,2,3,4]);
	await runWorkers([], 2, async () => assert.fail('empty queue'));
	await assert.rejects(runWorkers([1], 0, async () => {}), /positive integer/);
});
