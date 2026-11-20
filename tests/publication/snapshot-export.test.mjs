import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('snapshot export bundles public mirrors and retains the previous file if the mirror read fails', t => {
	const dir = mkdtempSync(join(tmpdir(), 'snapshot-export-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, 'static', 'addons.json');
	mkdirSync(join(dir, 'static'));
	const source = 'https://github.com/author/first';
	const addons = [{ id: 1, name: 'First', versions: [{ url: source }] }, { id: 2, name: 'Second' }];
	const mirror = { url: 'https://octowow.st/git/owner/first', source };
	const run = (fail) => spawnSync(process.execPath, ['--input-type=module', '-e', `
		import assert from 'node:assert/strict';
		const requests = [];
		globalThis.fetch = async (input) => {
			const url = new URL(input);
			requests.push(url.pathname);
			assert.equal(url.searchParams.get('limit'), '1000');
			assert.equal(url.searchParams.get('offset'), '0');
			if (url.pathname === '/rest/v1/addons') return Response.json(${JSON.stringify(addons)});
			assert.equal(url.pathname, '/rest/v1/published_addon_mirrors');
			assert.equal(url.searchParams.get('order'), 'url');
			if (${fail}) return new Response(null, { status: 404 });
			return Response.json([${JSON.stringify({ addon_id: 1, ...mirror })}]);
		};
		await import(${JSON.stringify(new URL('../../scripts/export.mjs', import.meta.url).href)});
		assert.deepEqual(requests, ['/rest/v1/addons', '/rest/v1/published_addon_mirrors']);
	`], { cwd: dir, encoding: 'utf8' });

	const exported = run(false);
	assert.equal(exported.status, 0, exported.stderr);
	assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), [
		{ ...addons[0], published_mirrors: [mirror] },
		{ ...addons[1], published_mirrors: [] }
	]);

	const previous = JSON.stringify([{ id: 3, name: 'Previous publication' }]);
	writeFileSync(file, previous);
	const failed = run(true);
	assert.equal(failed.status, 1);
	assert.match(failed.stderr, /HTTP 404/);
	assert.equal(readFileSync(file, 'utf8'), previous);
});
