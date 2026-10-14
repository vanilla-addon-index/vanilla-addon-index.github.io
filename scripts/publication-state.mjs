// Public data only. A saved fingerprint is reusable only while its deployment is
// still GitHub's latest successful Pages deployment. No dependencies are installed.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const digest = (value) => createHash('sha256').update(value).digest('hex');
export function fingerprint(commit, snapshot) {
	if (!sha(commit) || !Array.isArray(JSON.parse(snapshot))) throw new Error('A commit and complete public snapshot are required.');
	return {version:1, commit, snapshot:digest(snapshot)};
}

export function unchanged(current, previous, deployment, state) {
	return previous?.version === 1 && sha(previous.commit) && /^[a-f0-9]{64}$/.test(previous.snapshot) &&
		previous.commit === current.commit && previous.snapshot === current.snapshot &&
		Number.isSafeInteger(previous.deployment) && previous.deployment > 0 &&
		deployment?.id === previous.deployment && deployment.sha === current.commit &&
		deployment.environment === 'github-pages' && state?.state === 'success';
}

export function comparison(current, previous, repository, api) {
	// Old or malformed records and missing metadata always require publication.
	if (!previous || previous.commit !== current.commit || previous.snapshot !== current.snapshot || !Number.isSafeInteger(previous.deployment)) return false;
	try {
		const deployment = api(`repos/${repository}/deployments?environment=github-pages&per_page=1`)[0];
		if (!Number.isSafeInteger(deployment?.id) || deployment.id < 1) return false;
		const status = api(`repos/${repository}/deployments/${deployment.id}/statuses?per_page=1`)[0];
		return unchanged(current, previous, deployment, status);
	} catch { return false; } // An unavailable API loses the optimization, not a needed deploy.
}

function main() {
	const file = process.env.PUBLICATION_SNAPSHOT ?? 'static/addons.json';
	let current, previous;
	try { current = fingerprint(process.env.GITHUB_SHA, readFileSync(file)); }
	catch { console.log('No complete snapshot fingerprint; publication remains required.'); }
	try { previous = JSON.parse(readFileSync(process.env.PUBLICATION_PREVIOUS, 'utf8')); }
	catch { /* Missing or malformed publication metadata cannot suppress a deployment. */ }
	const api = (endpoint) => JSON.parse(execFileSync('gh', ['api', endpoint], {encoding:'utf8', timeout:30_000, stdio:['ignore', 'pipe', 'pipe']}));
	const same = current ? comparison(current, previous, process.env.GITHUB_REPOSITORY, api) : false;
	if (current && process.env.PUBLICATION_STAGE) {
		mkdirSync(process.env.PUBLICATION_STAGE, {recursive:true});
		copyFileSync(file, join(process.env.PUBLICATION_STAGE, 'addons.json'));
		writeFileSync(join(process.env.PUBLICATION_STAGE, 'publication.json'), JSON.stringify(current) + '\n');
	}
	appendFileSync(process.env.GITHUB_OUTPUT, `changed=${!same}\n`);
	console.log(same ? 'Application commit and full public snapshot match the latest successful Pages deployment; skipping publication.' : 'Application, public snapshot or confirmed deployment differs; publication is required.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
