import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {receiptMatches, validationKey} from '../../scripts/deploy-validation.mjs';

const identity = {sha:'a'.repeat(40), node:'v24.14.0', npm:'11.9.0', platform:'linux', arch:'x64', imageOS:'ubuntu24', imageVersion:'20261012.1.0'};
const key = validationKey(identity);
const script = fileURLToPath(new URL('../../scripts/deploy-validation.mjs', import.meta.url));

test('validation reuse requires the exact commit and all runtime inputs', () => {
	assert.match(key, /^deploy-validation-v2-a{40}-[a-f0-9]{64}$/);
	assert.equal(validationKey({...identity}), key);
	for (const [field, value] of Object.entries({sha:'b'.repeat(40), node:'v24.15.0', npm:'11.10.0', platform:'darwin', arch:'arm64', imageOS:'ubuntu26', imageVersion:'20261019.1.0'})) {
		assert.notEqual(validationKey({...identity, [field]:value}), key, field);
	}
	// A missing identity never becomes a reusable catch-all key.
	for (const field of Object.keys(identity)) {
		for (const value of ['', undefined, 'bad\ninput']) assert.equal(validationKey({...identity, [field]:value}), '', field);
	}
	assert.equal(validationKey({...identity, sha:'main'}), '');
	assert.equal(validationKey({...identity, node:'24'}), '');
});

test('only a complete successful receipt for the exact key can skip checks', () => {
	const receipt = {version:2, key, tests:'success', types:'success', build:'success'};
	assert.equal(receiptMatches(JSON.stringify(receipt), key), true);
	for (const altered of [{...receipt, version:1}, {...receipt, key:validationKey({...identity, sha:'b'.repeat(40)})},
		{...receipt, tests:'failure'}, {...receipt, types:'skipped'}, {...receipt, types:undefined}, {...receipt, build:'failure'}, {...receipt, build:undefined}, {key}]) {
		assert.equal(receiptMatches(JSON.stringify(altered), key), false);
	}
	for (const text of [undefined, '', '{broken', 'null', '[]', 'x'.repeat(1025)]) assert.equal(receiptMatches(text, key), false);
	assert.equal(receiptMatches(JSON.stringify(receipt), ''), false);
});

test('receipt commands recover from missing or corrupt cache files and persist a matching success', () => {
	const dir = mkdtempSync(join(tmpdir(), 'deploy-validation-'));
	const file = join(dir, 'receipt', 'success.json');
	const output = join(dir, 'output');
	function run(command, env = {}) {
		writeFileSync(output, '');
		const result = spawnSync(process.execPath, [script, command], {
			encoding:'utf8', env:{...process.env, GITHUB_OUTPUT:output, VALIDATION_KEY:key, VALIDATION_RECEIPT:file, ...env}
		});
		return {...result, output:readFileSync(output, 'utf8')};
	}
	try {
		assert.equal(run('reuse').output, 'reuse=false\n');
		assert.equal(run('record').status, 0);
		assert.equal(run('reuse').output, 'reuse=true\n');
		assert.equal(run('reuse', {VALIDATION_KEY:validationKey({...identity, imageVersion:'new-image'})}).output, 'reuse=false\n');
		writeFileSync(file, '{broken');
		assert.equal(run('reuse').output, 'reuse=false\n');
		assert.notEqual(run('record', {VALIDATION_KEY:''}).status, 0);
		assert.equal(run('key', {GITHUB_SHA:identity.sha, VALIDATION_NPM:identity.npm, ImageOS:'', ImageVersion:''}).output, 'key=\n');
		const identified = run('key', {GITHUB_SHA:identity.sha, VALIDATION_NPM:identity.npm, ImageOS:identity.imageOS, ImageVersion:identity.imageVersion});
		assert.equal(identified.output, `key=${validationKey({...identity, node:process.version, platform:process.platform, arch:process.arch})}\n`);
	} finally { rmSync(dir, {recursive:true, force:true}); }
});

test('migrations require tests, types and a preflight build, including when validation is reused', () => {
	const workflow = (name) => readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
	const prepare = workflow('prepare');
	const check = prepare.split('\n  check:\n')[1].split('\n  migrate:\n')[0];
	const steps = check.split(/\n      - /).slice(1);
	const step = (needle) => steps.find((s) => s.includes(needle));
	for (const name of ['Find successful main validation', 'Verify successful validation receipt', 'Record successful main validation']) {
		assert.match(step(name), /if: github\.ref == 'refs\/heads\/main'/);
	}
	assert.match(step('Find successful main validation'), /steps\.identity\.outputs\.key != ''/);
	assert.match(step('Find successful main validation'), /continue-on-error: true/);
	assert.match(step('Verify successful validation receipt'), /steps\.validation\.outcome == 'success' && steps\.validation\.outputs\.cache-hit == 'true'/);
	assert.ok(!check.includes('restore-keys:'));
	for (const command of ['npm ci', 'npm test', 'npm run check', 'npm run build']) assert.match(step(`run: ${command}`), /if: steps\.reuse\.outputs\.reuse != 'true'/);
	assert.match(step('Record successful main validation'), /steps\.tests\.outcome == 'success' && steps\.types\.outcome == 'success' && steps\.build\.outcome == 'success'/);
	assert.match(step('Remember successful main validation'), /if: steps\.receipt\.outcome == 'success'/);
	assert.match(step('Remember successful main validation'), /continue-on-error: true/);
	assert.ok(steps.indexOf(step('run: npm run build')) > steps.indexOf(step('run: npm run check')));
	assert.ok(steps.indexOf(step('Record successful main validation')) > steps.indexOf(step('run: npm run build')));
	assert.ok(!step('run: npm run build').includes('continue-on-error:'));
	// Migrations still run on every preparation, behind successful code validation.
	assert.match(prepare.split('\n  migrate:\n')[1], /needs: check/);
	assert.ok(!check.includes('SUPABASE_DB_PASSWORD'));
	const ci = workflow('ci');
	assert.ok(!ci.includes('steps.reuse') && !ci.includes('deploy-validation'));
	for (const command of ['npm ci', 'npm test', 'npm run check', 'npm run build', 'npm run test:e2e']) assert.ok(ci.includes(`run: ${command}`), command);
});
