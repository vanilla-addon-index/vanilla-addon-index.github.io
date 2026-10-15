import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checkHealth} from '../scripts/workflow-health.mjs';

const now = Date.parse('2026-10-15T12:00:00Z');
const run = {id:1, head_branch:'main', status:'completed', conclusion:'success', event:'schedule', created_at:'2026-10-15T02:00:00Z', html_url:'https://example.invalid/run/1'};
function api({state = 'active', runs = [run], skipped = false, jobsError = false} = {}) {
	return endpoint => {
		if (endpoint.includes('/jobs?')) {
			if (jobsError) throw new Error('API unavailable');
			return {total_count:2, jobs:[
				{name:'backup', conclusion:'success', steps:['Back up and encrypt', 'Check that it restores'].map(name => ({name, conclusion:skipped ? 'skipped' : 'success'}))},
				{name:'Import from the wiki', conclusion:'success', steps:[{name:'Import from the wiki', conclusion:'success'}]}
			]};
		}
		if (endpoint.includes('/runs?')) return {workflow_runs:runs};
		return {state};
	};
}

test('recent verified main runs are healthy, including manual runs', () => {
	for (const event of ['schedule', 'workflow_dispatch']) {
		assert.ok(checkHealth(api({runs:[{...run, event}]}), now).every(check => check.healthy));
	}
});

test('disabled schedules, missing runs, stale runs and unrelated runs alert', () => {
	for (const options of [{state:'disabled_inactivity'}, {runs:[]},
		{runs:[{...run, created_at:'2026-10-13T00:00:00Z', updated_at:'2026-10-15T11:59:00Z'}]},
		{runs:[{...run, head_branch:'other'}]}, {runs:[{...run, event:'pull_request'}]},
		{runs:[{...run, conclusion:'failure'}]}, {runs:[{...run, created_at:'invalid'}]},
		{runs:[{...run, created_at:'2026-10-16T00:00:00Z'}]}]) {
		assert.ok(checkHealth(api(options), now).every(check => !check.healthy), JSON.stringify(options));
	}
});

test('skipped backup steps cannot make a green run count as a verified backup', () => {
	const checks = checkHealth(api({skipped:true}), now);
	assert.equal(checks[0].healthy, false);
	assert.equal(checks[1].healthy, true);
});

test('API and authentication failures report unknown health without exposing errors', () => {
	for (const read of [api({jobsError:true}), () => { throw new Error('secret internal error'); }]) {
		const checks = checkHealth(read, now);
		assert.ok(checks.every(check => !check.healthy));
		assert.ok(!JSON.stringify(checks).includes('secret internal error'));
	}
});
