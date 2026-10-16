import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDb, NIGHTLY_TOKEN } from '../helpers/db.mjs';
import { refreshImports } from '../../scripts/refresh-imports.mjs';

test('lightweight refresh corrects pending categories without replacing reviewed details, facts or screenshots', async () => {
	const db = await createDb(), fetcher = globalThis.fetch;
	const url = 'https://github.com/Cernie/CerniesWonderfulFunctions';
	try {
		await db.queueImports([{url, name:'CerniesWonderfulFunctions', category:'Action Bars', description:'Reviewed description', images:['https://i.imgur.com/reviewed.png']}]);
		await db.sql("insert into public.repo_stats(key, stars, missing) values ($1, 5, false)", ['github.com/cernie/cernieswonderfulfunctions']);
		const facts = await db.sql('select * from public.repo_stats');
		const before = (await db.sql('select * from public.import_queue'))[0];
		globalThis.fetch = async (endpoint, init) => {
			let body;
			if (endpoint.includes('turtle-wow.fandom.com/api.php')) body = {parse:{revid:1, wikitext:`===Full Addons List===\n* [${url} CerniesWonderfulFunctions] Script methods helping players create macros\n==SuperWoW Addons==\n==ClassicAPI Addons==\n==Further Addons Collections==`}};
			else {
				assert.ok(endpoint.endsWith('/rpc/queue_imports'), endpoint);
				const {items, token} = JSON.parse(init.body);
				body = await db.queueImports(items, token);
			}
			return new Response(JSON.stringify(body), {headers:{'content-type':'application/json'}});
		};
		await refreshImports(NIGHTLY_TOKEN);
		const after = (await db.sql('select * from public.import_queue'))[0];
		assert.deepEqual(after, {...before, category:'Macros'});
		assert.deepEqual(await db.sql('select * from public.repo_stats'), facts);
	} finally { globalThis.fetch = fetcher; await db.close(); }
});
