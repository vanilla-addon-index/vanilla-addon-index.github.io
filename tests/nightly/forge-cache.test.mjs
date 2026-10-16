import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askForge, forgePlace } from '../../src/lib/forges.ts';

const hash = (char) => char.repeat(40);
for (const host of ['gitlab.com', 'codeberg.org', 'gitea.com', 'octowow.st']) {
	const gitlab = host === 'gitlab.com';
	const place = forgePlace(`https://${host}${host === 'octowow.st' ? '/git' : ''}/a/Addon/${gitlab ? '-/tree' : 'src/branch'}/vanilla/Folder`);
	async function run(options = {}) {
		const calls = [], hits = [];
		let state;
		const head = options.head ?? hash('a');
		const file = options.file ?? hash('b');
		const ask = async (url, as) => {
			calls.push(url);
			if (url.includes('/commits?')) {
				if (url.includes('&path=') && options.fail === 'history') return null;
				const date = url.includes('&path=') ? '2020-01-01T00:00:00Z' : '2026-01-01T00:00:00Z';
				return { status:200, body:[gitlab ? {id:head, committed_date:date} : {sha:head, commit:{committer:{date}}}] };
			}
			if (url.includes('/tree?') || url.includes('/contents/')) {
				if (options.fail === 'directory') return null;
				return {status:200, body:[gitlab ? {name:'Addon.toc', type:'blob', id:file} : {name:'Addon.toc', type:'file', sha:file}]};
			}
			if (as === 'text') return options.fail === 'toc' ? null : {status:200, body:'## Interface: ' + (options.interface ?? 11200)};
			return {status:200, body:gitlab ? {id:options.id ?? 1, path_with_namespace:'a/Addon', star_count:options.stars ?? 3, default_branch:'main'} :
				{id:options.id ?? 1, full_name:'a/Addon', stars_count:options.stars ?? 3, default_branch:'main'}};
		};
		const facts = await askForge(place, ask, true, {previous:options.previous, save:(value) => {state=value;}, hit:(kind) => hits.push(kind)});
		return {facts, state, calls, hits};
	}
	test(`${host}: unchanged branches reuse folder history and files while stars remain fresh`, async () => {
		const cold = await run();
		assert.equal(cold.facts.interface, 11200);
		assert.equal(cold.facts.code_update.date, '2020-01-01T00:00:00Z');
		assert.ok(cold.calls.filter((url) => url.includes('path=') || url.includes('/raw/')).every((url) => url.includes(hash('a'))));
		const warm = await run({previous:cold.state, stars:19});
		assert.equal(warm.calls.length, 2); // Repository and branch commit only.
		assert.equal(warm.facts.stars, 19);
		assert.equal(warm.facts.code_update.date, '2020-01-01T00:00:00Z');
		assert.equal(warm.facts.interface, 11200);
		assert.equal(warm.hits.length, 3);
	});
	test(`${host}: new branches refresh history, reuse identical toc IDs, and re-read changed files`, async () => {
		const cold = await run();
		const changed = await run({previous:cold.state, head:hash('c')});
		assert.ok(changed.calls.some((url) => url.includes('&path=Folder')));
		assert.ok(!changed.calls.some((url) => url.includes('/raw/') || url.includes('/raw?')));
		const fileChanged = await run({previous:changed.state, head:hash('d'), file:hash('e'), interface:20400});
		assert.equal(fileChanged.facts.interface, 20400);
		const replacement = await run({previous:cold.state, id:2});
		assert.ok(replacement.calls.length > 2);
	});
	test(`${host}: incomplete checks remain retryable on the same branch`, async () => {
		for (const fail of ['history','directory','toc']) {
			const partial = await run({fail});
			const next = await run({previous:partial.state});
			assert.equal(next.facts.interface, 11200, fail);
			assert.equal(next.facts.code_update.date, '2020-01-01T00:00:00Z', fail);
			assert.ok(next.calls.length > 2, fail);
		}
	});
}
