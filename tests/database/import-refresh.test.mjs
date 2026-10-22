import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDb, NIGHTLY_TOKEN } from '../helpers/db.mjs';
import { refreshImports } from '../../scripts/refresh-imports.mjs';
import { parseWiki } from '../../src/lib/wiki.ts';

test('lightweight refresh clears pending category guesses without replacing reviewed details, facts or screenshots', async () => {
	const db = await createDb(), fetcher = globalThis.fetch;
	const url = 'https://github.com/Cernie/CerniesWonderfulFunctions';
	try {
		await db.queueImports([{url, name:'CerniesWonderfulFunctions', category:'Action Bars', description:'Reviewed description', images:['https://i.imgur.com/reviewed.png']}]);
		await db.sql("insert into public.repo_stats(key, stars, missing) values ($1, 5, false)", ['github.com/cernie/cernieswonderfulfunctions']);
		const facts = await db.sql('select * from public.repo_stats');
		const before = (await db.sql('select * from public.import_queue'))[0];
		globalThis.fetch = async (endpoint, init) => {
			let body;
			if (endpoint.includes('octowow.st/git/api/')) return new Response(JSON.stringify({ok:true,data:[]}));
			if (endpoint.includes('turtle-wow.fandom.com/api.php')) body = {parse:{revid:1, wikitext:`===Full Addons List===\n* [${url} CerniesWonderfulFunctions] Script methods helping players create macros\n==SuperWoW Addons==\n==ClassicAPI Addons==\n==Further Addons Collections==`}};
			else {
				assert.ok(/\/rpc\/queue_(octowow_)?imports$/.test(endpoint), endpoint);
				const {items, token} = JSON.parse(init.body);
				body = await db.queueImports(items, token);
			}
			return new Response(JSON.stringify(body), {headers:{'content-type':'application/json'}});
		};
		await refreshImports(NIGHTLY_TOKEN);
		const after = (await db.sql('select * from public.import_queue'))[0];
		assert.deepEqual(after, {...before, category:''});
		assert.deepEqual(await db.sql('select * from public.repo_stats'), facts);
	} finally { globalThis.fetch = fetcher; await db.close(); }
});

test('new imports stay uncategorized and cannot publish a new page without a reviewed category', async () => {
	const db = await createDb();
	try {
		const admin = await db.addUser('admin', 'admin');
		const {candidates} = parseWiki('===Full Addons List===\n* [https://github.com/a/UnknownWidget UnknownWidget] Includes a button.\n==SuperWoW Addons==\n==ClassicAPI Addons==\n==Further Addons Collections==');
		assert.equal(candidates[0].category, '');
		await db.queueImports(candidates);
		const [{id}] = await db.sql('select id from public.import_queue');
		const result = await db.as(admin, q => q('select public.approve_imports($1) as n', [[id]]));
		assert.equal(result[0].n, 0);
		assert.equal((await db.sql('select status from public.import_queue'))[0].status, 'pending');
		assert.deepEqual(await db.sql('select * from public.addons'), []);
		await db.as(admin, q => q('select public.publish_import($1, $2::jsonb)', [id, JSON.stringify({name:'UnknownWidget', description:'Includes a button.', category:'Chat & Social', images:[]})]));
		assert.equal((await db.sql('select category from public.addons'))[0].category, 'Chat & Social');
	} finally { await db.close(); }
});
