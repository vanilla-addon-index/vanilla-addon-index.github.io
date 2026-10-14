import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NightlyMetrics } from '../src/lib/nightly-metrics.ts';

test('phase timing includes active work on failure, keeps overlapping requests distinct and closes once', () => {
	let clock = 0;
	const logs = [];
	const metrics = new NightlyMetrics({now: () => clock, log: (line) => logs.push(line)});
	const finish = metrics.start('Other hosts');
	clock = 1000;
	for (let i = 0; i < 2; i++) metrics.observe('Codeberg')({attempts:1, failedAttempts:0, retries:0, failed:false, rateLimited:false, durationMs:1000, retryDelayMs:0});
	const snapshot = metrics.snapshot();
	assert.equal(snapshot.phases['Other hosts'].wallMs, 1000);
	assert.equal(snapshot.phases.Codeberg.requestMs, 2000);
	clock = 2000;
	finish();
	finish();
	assert.equal(metrics.snapshot().phases['Other hosts'].wallMs, 2000);
	assert.equal(snapshot.phases['Other hosts'].wallMs, 1000);
	assert.equal(logs.length, 1);
	metrics.count('commit_dates_left_unchanged', 3);
	metrics.count('commit_dates_left_unchanged', -1);
	const summary = metrics.markdown();
	assert.match(summary, /Metadata and commit history currently share one GitHub request/);
	assert.match(summary, /\| commit_dates_left_unchanged \| 2 \|/);
	assert.match(summary, /\| cache_hits \| 0 \|/);
});
