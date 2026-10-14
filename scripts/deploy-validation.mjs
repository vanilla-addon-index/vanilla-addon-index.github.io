// A tiny main-only validation receipt, never a dependency or build-output cache.
// The commit includes the lockfile, workflow actions, tests and validation policy.
import {createHash} from 'node:crypto';
import {appendFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {pathToFileURL} from 'node:url';

const VERSION = 1;
const keyPattern = /^deploy-validation-v1-[a-f0-9]{40}-[a-f0-9]{64}$/;

export function validationKey({sha, node, npm, platform, arch, imageOS, imageVersion}) {
	const inputs = [sha, node, npm, platform, arch, imageOS, imageVersion];
	// An unidentified runtime cannot reuse validation. Missing runner metadata is a
	// normal cache miss, so checks still run on a newly configured runner.
	if (inputs.some((value) => typeof value !== 'string' || !value.trim() || value.length > 200 || /[\r\n]/.test(value)) ||
		!/^[a-f0-9]{40}$/.test(sha) || !/^v\d+\.\d+\.\d+$/.test(node) || !/^\d+\.\d+\.\d+$/.test(npm)) return '';
	const digest = createHash('sha256').update(JSON.stringify([VERSION, ...inputs])).digest('hex');
	return `deploy-validation-v${VERSION}-${sha}-${digest}`;
}

export function receiptMatches(text, key) {
	if (!keyPattern.test(key) || typeof text !== 'string' || text.length > 1024) return false;
	try {
		const receipt = JSON.parse(text);
		return receipt?.version === VERSION && receipt.key === key && receipt.tests === 'success' && receipt.types === 'success';
	} catch { return false; }
}

function main() {
	const {GITHUB_OUTPUT, VALIDATION_KEY: key, VALIDATION_RECEIPT: file} = process.env;
	const output = (name, value) => appendFileSync(GITHUB_OUTPUT, `${name}=${value}\n`);
	if (process.argv[2] === 'key') {
		const key = validationKey({sha:process.env.GITHUB_SHA, node:process.version, npm:process.env.VALIDATION_NPM,
			platform:process.platform, arch:process.arch, imageOS:process.env.ImageOS, imageVersion:process.env.ImageVersion});
		output('key', key);
		if (!key) console.log('Runner identity is incomplete; running fresh validation.');
	} else if (process.argv[2] === 'reuse') {
		let text;
		try { text = readFileSync(file, 'utf8'); } catch { /* Missing receipts run fresh checks. */ }
		const reuse = receiptMatches(text, key);
		output('reuse', reuse);
		console.log(reuse ? 'Reusing successful tests and types for this exact commit and runtime.' : 'No matching validation receipt; running fresh checks.');
	} else if (process.argv[2] === 'record') {
		if (!keyPattern.test(key)) throw new Error('Cannot record validation without a complete key.');
		mkdirSync(dirname(file), {recursive:true});
		writeFileSync(file, JSON.stringify({version:VERSION, key, tests:'success', types:'success'}) + '\n');
	} else throw new Error('Expected key, reuse or record.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
