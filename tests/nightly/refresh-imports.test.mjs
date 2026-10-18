import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { refreshImports } from '../../scripts/refresh-imports.mjs';

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
const wiki = '===Full Addons List===\n* [https://github.com/a/Panel Better Character Panel] Improves the character and inspect panel\n* [https://github.com/Cernie/CerniesWonderfulFunctions CerniesWonderfulFunctions] Script methods for using specific items and helping players create simple(er) macros\n==SuperWoW Addons==\n==ClassicAPI Addons==\n==Further Addons Collections==';
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers:{'content-type':'application/json'}});

test('Deploy refresh leaves categories for manual selection and only writes queue candidates, with no repository or screenshot work', async () => {
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push(url);
		if (url.includes('turtle-wow.fandom.com/api.php')) return json({parse:{revid:123, wikitext:wiki}});
		assert.ok(url.endsWith('/rest/v1/rpc/queue_imports'), url);
		const { token, items } = JSON.parse(init.body);
		assert.equal(token, 'test-token');
		assert.equal(items[0].name, 'BetterCharacterPanel');
		assert.equal(items[0].category, '');
		assert.equal(items[1].category, '');
		return json(0);
	};
	for (let i = 0; i < 2; i++) assert.match(await refreshImports('test-token'), /revision 123: refreshed 2.*0 new/);
	assert.equal(calls.length, 4); // Same revision must still apply changed parser rules.
});

test('missing configuration fails before network work', async () => {
	globalThis.fetch = async () => { assert.fail('must not fetch'); };
	await assert.rejects(refreshImports(''), /requires NIGHTLY_TOKEN/);
});

test('unreadable wiki cannot change the queue and database guard failures remain visible', async () => {
	globalThis.fetch = async () => json({parse:{revid:1, wikitext:'Broken markup'}});
	await assert.rejects(refreshImports('test-token'), /no longer has the section/);
	globalThis.fetch = async url => url.includes('turtle-wow.fandom.com')
		? json({parse:{revid:1, wikitext:wiki}}) : json({message:'The wiki lists far fewer addons'}, 400);
	await assert.rejects(refreshImports('test-token'), /far fewer addons/);
});

test('only Deploy requests lightweight refresh, after preparation, without blocking publication', () => {
	const read = name => readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
	assert.match(read('deploy'), /refresh-imports: true/);
	for (const name of ['nightly', 'refresh']) assert.doesNotMatch(read(name), /refresh-imports: true/);
	const publish = read('publish');
	const job = publish.split('\n  refresh-imports:\n')[1].split('\n  build:\n')[0];
	assert.match(job, /needs: prepare/);
	assert.match(job, /needs.prepare.result == 'success'/);
	assert.match(job, /github.ref == 'refs\/heads\/main'/);
	assert.match(job, /environment: database/);
	assert.match(job, /continue-on-error: true/);
	assert.match(job, /steps.imports.outcome == 'failure'/);
	assert.match(job, /git ls-remote --exit-code origin refs\/heads\/main/);
	assert.doesNotMatch(job, /npm ci|GITHUB_TOKEN|SUPABASE_DB_PASSWORD/);
	const build = publish.split('\n  build:\n')[1].split('\n  deploy:\n')[0];
	assert.match(build, /needs: prepare/);
	assert.doesNotMatch(build, /needs:.*refresh-imports/);
});
