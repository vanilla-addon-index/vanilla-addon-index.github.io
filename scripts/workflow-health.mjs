// Run outside GitHub Actions: a stopped scheduler cannot monitor itself.
// Read-only; needs Node and an authenticated GitHub CLI with Actions read access.
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const REPOSITORY = 'vanilla-addon-index/vanilla-addon-index.github.io';
const HOURS = 36;
const targets = [
	{file:'backup.yml', job:'backup', steps:['Back up and encrypt', 'Check that it restores']},
	{file:'nightly.yml', job:'Import from the wiki', steps:['Import from the wiki']}
];

export function inspectWorkflow(target, api, now = Date.now()) {
	const base = `repos/${REPOSITORY}/actions`;
	const workflow = api(`${base}/workflows/${target.file}`);
	if (workflow.state !== 'active') return {workflow:target.file, healthy:false, reason:`Workflow is ${workflow.state ?? 'unknown'}.`};
	const response = api(`${base}/workflows/${target.file}/runs?branch=main&status=success&per_page=100`);
	if (!Array.isArray(response.workflow_runs)) throw new Error('Invalid workflow run response.');
	// Creation time bounds data age even if an old run is retried today.
	const runs = response.workflow_runs.filter(run => run.head_branch === 'main' &&
		run.status === 'completed' && run.conclusion === 'success' &&
		['schedule', 'workflow_dispatch'].includes(run.event) &&
		Number.isFinite(Date.parse(run.created_at)) && Date.parse(run.created_at) <= now &&
		now - Date.parse(run.created_at) <= HOURS * 3_600_000)
		.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
	for (const run of runs) {
		const response = api(`${base}/runs/${run.id}/jobs?filter=latest&per_page=100`);
		if (!Array.isArray(response.jobs) || response.total_count > response.jobs.length) throw new Error('Incomplete workflow job response.');
		const job = response.jobs.find(job => job.name === target.job && job.conclusion === 'success');
		// A green run with skipped credential-dependent steps is not a backup.
		if (job && target.steps.every(name => job.steps?.some(step => step.name === name && step.conclusion === 'success'))) {
			return {workflow:target.file, healthy:true, createdAt:run.created_at, url:run.html_url};
		}
	}
	return {workflow:target.file, healthy:false, reason:`No verified successful main run within ${HOURS} hours (searched the latest 100 successful runs).`};
}

export function checkHealth(api, now = Date.now()) {
	return targets.map(target => {
		try { return inspectWorkflow(target, api, now); }
		catch { return {workflow:target.file, healthy:false, reason:'Unable to verify workflow health; check GitHub availability, CLI authentication and Actions read access.'}; }
	});
}

function main() {
	const api = endpoint => JSON.parse(execFileSync('gh', ['api', endpoint], {
		encoding:'utf8', timeout:30_000, stdio:['ignore', 'pipe', 'pipe'], maxBuffer:10 * 1024 * 1024
	}));
	const checks = checkHealth(api);
	console.log(JSON.stringify({healthy:checks.every(check => check.healthy), checkedAt:new Date().toISOString(), maxAgeHours:HOURS, checks}, null, 2));
	if (checks.some(check => !check.healthy)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
