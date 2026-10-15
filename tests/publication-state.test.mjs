import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {comparison, fingerprint, unchanged} from '../scripts/publication-state.mjs';

const commit = 'a'.repeat(40);
const snapshot = JSON.stringify([{id:'addon', name:'Addon', code_updated_at:'2020-01-01', description:'First', images:[]}]);
const current = fingerprint(commit, snapshot);
const previous = {...current, deployment:42};
const deployment = {id:42, sha:commit, environment:'github-pages'};
const success = {state:'success'};
const api = (deployed = deployment, status = success) => (endpoint) => endpoint.includes('/statuses?') ? [status] : [deployed];

test('publication fingerprint covers the entire public snapshot and application commit', () => {
	assert.equal(unchanged(current, previous, deployment, success), true);
	assert.equal(unchanged(fingerprint('b'.repeat(40), snapshot), previous, deployment, success), false);
	for (const patch of [{code_updated_at:'2025-01-01'}, {description:'Edited'}, {images:['https://i.imgur.com/new.png']}, {name:'Renamed'}, {history_url:'https://github.com/a/addon/commits/main'}]) {
		const changed = fingerprint(commit, JSON.stringify([{...JSON.parse(snapshot)[0], ...patch}]));
		assert.equal(unchanged(changed, previous, deployment, success), false);
	}
	assert.equal(unchanged(fingerprint(commit, '[]'), previous, deployment, success), false);
	assert.throws(() => fingerprint(commit, '{}'));
	assert.throws(() => fingerprint('main', snapshot));
});

test('only matching metadata anchored to the latest successful Pages deployment can skip', () => {
	assert.equal(comparison(current, previous, 'example/site', api()), true);
	for (const state of ['failure', 'error', 'pending', 'in_progress', 'inactive']) assert.equal(comparison(current, previous, 'example/site', api(deployment, {state})), false);
	for (const record of [undefined, {}, {...previous, version:0}, {...previous, deployment:undefined}, {...previous, deployment:'42'}, {...previous, snapshot:'bad'}]) {
		assert.equal(comparison(current, record, 'example/site', api()), false);
	}
	for (const latest of [{...deployment, id:43}, {...deployment, sha:'b'.repeat(40)}, {...deployment, environment:'other'}, null]) {
		assert.equal(comparison(current, previous, 'example/site', api(latest)), false);
	}
	assert.equal(comparison(current, previous, 'example/site', () => {throw new Error('API unavailable');}), false);
	assert.equal(comparison(current, previous, 'example/site', () => []), false);
});

test('a successful deployment followed by a failed snapshot save cannot cause a false skip', () => {
	// The branch still describes A, but live deployment B has a new identity, even
	// when its application SHA is unchanged. A later return to A must deploy again.
	assert.equal(comparison(current, previous, 'example/site', api({...deployment, id:43})), false);
});

test('a queued Refresh repeats its comparison after Nightly publishes the same output', () => {
	const updated = fingerprint(commit, snapshot.replace('First', 'Edited'));
	assert.equal(comparison(updated, previous, 'example/site', api()), false);
	const published = {...updated, deployment:43};
	assert.equal(comparison(updated, published, 'example/site', api({...deployment, id:43})), true);
});

test('comparison command stages the exact bytes for later snapshot saving and tolerates missing metadata', () => {
	const dir = mkdtempSync(join(tmpdir(), 'publication-state-'));
	const file = join(dir, 'addons.json');
	const receipt = join(dir, 'previous.json');
	const stage = join(dir, 'stage');
	const output = join(dir, 'output');
	const script = fileURLToPath(new URL('../scripts/publication-state.mjs', import.meta.url));
	const run = () => {
		writeFileSync(output, '');
		const child = spawnSync(process.execPath, [script], {encoding:'utf8', env:{...process.env,
			GITHUB_SHA:commit, GITHUB_REPOSITORY:'example/site', GITHUB_OUTPUT:output,
			PUBLICATION_SNAPSHOT:file, PUBLICATION_PREVIOUS:receipt, PUBLICATION_STAGE:stage}});
		assert.equal(child.status, 0, child.stderr);
		assert.equal(readFileSync(output, 'utf8'), 'changed=true\n');
	};
	try {
		writeFileSync(file, snapshot);
		run();
		assert.equal(readFileSync(join(stage, 'addons.json'), 'utf8'), snapshot);
		assert.deepEqual(JSON.parse(readFileSync(join(stage, 'publication.json'), 'utf8')), current);
		writeFileSync(receipt, '{broken');
		run();
		writeFileSync(file, 'invalid snapshot');
		run();
	} finally {rmSync(dir, {recursive:true, force:true});}
});

test('workflow gates build and deployment under the shared lock and saves only published data', () => {
	const read = (name) => readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
	const publish = read('publish');
	const build = publish.split('\n  build:\n')[1].split('\n  deploy:\n')[0];
	assert.ok(build.indexOf('node scripts/export.mjs') < build.indexOf('node scripts/publication-state.mjs'));
	assert.ok(build.indexOf('node scripts/publication-state.mjs') < build.indexOf('run: npm ci'));
	assert.match(build, /if: steps\.compare\.outputs\.changed == 'true'\n\s+run: npm run build/);
	assert.match(publish.split('\n  deploy:\n')[1], /if: needs\.build\.outputs\.changed == 'true'/);
	assert.match(publish.split('\n  snapshot:\n')[1], /if: needs\.deploy\.outputs\.published == 'true' && needs\.deploy\.outputs\.attempt == github\.run_attempt/);
	assert.ok(!publish.split('\n  snapshot:\n')[1].includes('node scripts/'));
	assert.match(read('refresh'), /if: needs\.changed\.outputs\.changed == 'true'/);
	assert.ok(read('refresh').includes('node scripts/publication-state.mjs'));
	for (const name of ['deploy', 'refresh', 'nightly']) assert.ok(read(name).includes('deployments: read'), name);
});
