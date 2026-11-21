import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { refreshImports } from '../../scripts/refresh-imports.mjs';

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
const wiki = '===Full Addons List===\n* [https://github.com/a/Panel Better Character Panel] Improves the character and inspect panel\n* [https://github.com/Cernie/CerniesWonderfulFunctions CerniesWonderfulFunctions] Script methods for using specific items and helping players create simple(er) macros\n==SuperWoW Addons==\n==ClassicAPI Addons==\n==Further Addons Collections==';
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers:{'content-type':'application/json'}});

test('Deploy refresh leaves categories for manual selection and skips repository and screenshot work if no candidates were added', async () => {
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push(url);
		if (url.includes('octowow.st/git/api/')) return json({ok:true,data:[]});
		if (url.includes('turtle-wow.fandom.com/api.php')) return json({parse:{revid:123, wikitext:wiki}});
		assert.ok(url.endsWith('/rpc/queue_import_candidates'), url);
		const { token, items, source } = JSON.parse(init.body);
		assert.equal(token, 'test-token');
		if (source === 'octowow') return json([]);
		assert.equal(source, 'wiki');
		assert.equal(items[0].name, 'BetterCharacterPanel');
		assert.equal(items[0].category, '');
		assert.equal(items[1].category, '');
		return json([]);
	};
	for (let i = 0; i < 2; i++) assert.match(await refreshImports('test-token'), /revision 123: refreshed 2.*0 new/);
	assert.equal(calls.length, 8); // Same revision must still apply changed parser rules.
});

test('Deploy seeds the exact history of new links and leaves unanswered links for Nightly', async () => {
	const github = 'https://github.com/a/Panel/tree/vanilla/Panel';
	const octowow = 'https://octowow.st/git/a/Addon';
	const missing = 'https://codeberg.org/a/missing';
	const date = '2024-01-02T00:00:00Z';
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push(url);
		if (url.includes('turtle-wow.fandom.com/api.php')) return json({parse:{revid:123, wikitext:wiki.replace('https://github.com/a/Panel', github).replace('==SuperWoW', `* [${missing} Missing] Unavailable addon\n==SuperWoW`)}});
		if (url.includes('octowow.st/git/api/v1/repos/search?')) {
			return json({ok:true, data:new URL(url).searchParams.get('page') === '1' ? [{full_name:'a/Addon', name:'Addon'}] : []});
		}
		if (url.endsWith('/rpc/queue_import_candidates')) {
			const {items, source} = JSON.parse(init.body);
			const added = source === 'wiki' ? [github, missing] : [octowow];
			assert.ok(added.every(link => items.some(item => item.url === link)));
			return json(added);
		}
		if (url === 'https://api.github.com/graphql') {
			assert.equal(init.headers.Authorization, 'Bearer github-token');
			assert.match(JSON.parse(init.body).query, /expression: "vanilla".*path: "Panel"/);
			return json({data:{r0:{nameWithOwner:'a/Panel',code:{history:{nodes:[{committedDate:date}]}}}}});
		}
		if (url === 'https://codeberg.org/api/v1/repos/a/missing') return json({}, 404);
		if (url === 'https://octowow.st/git/api/v1/repos/a/Addon') return json({full_name:'a/Addon', default_branch:'main'});
		if (url.startsWith('https://octowow.st/git/api/v1/repos/a/Addon/commits?')) {
			assert.equal(new URL(url).searchParams.get('sha'), 'main');
			return json([{commit:{committer:{date}}}]);
		}
		assert.ok(url.endsWith('/rpc/seed_import_code_updates'), url);
		const {token, updates} = JSON.parse(init.body);
		assert.equal(token, 'test-token');
		assert.deepEqual(updates.toSorted((a, b) => a.url.localeCompare(b.url)), [
			{url:github,date,history_url:'https://github.com/a/Panel/commits/vanilla/Panel'},
			{url:octowow,date,history_url:'https://octowow.st/git/a/Addon/commits/branch/main'}
		]);
		return json(updates.length);
	};
	assert.match(await refreshImports('test-token', 'github-token'), /Saved commit dates for 2 of 3 new links/);
	assert.equal(calls.filter(url => url.endsWith('/rpc/seed_import_code_updates')).length, 1);
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
	assert.match(job, /GITHUB_TOKEN: \$\{\{ github.token \}\}/);
	assert.doesNotMatch(job, /npm ci|SUPABASE_DB_PASSWORD/);
	const build = publish.split('\n  build:\n')[1].split('\n  deploy:\n')[0];
	assert.match(build, /needs: prepare/);
	assert.doesNotMatch(build, /needs:.*refresh-imports/);
});
