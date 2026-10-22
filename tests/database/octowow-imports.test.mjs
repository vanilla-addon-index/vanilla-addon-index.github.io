import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDb, NIGHTLY_TOKEN } from '../helpers/db.mjs';

test('OctoWoW candidates require review, preserve decisions, and publish with their own credit', async () => {
	const db = await createDb();
	try {
		const admin = await db.addUser('admin', 'admin');
		const items = [{url:'https://octowow.st/git/Ade/AdeAlts',name:'AdeAlts',description:'Tracks alts',category:''}];
		const queue = (token = NIGHTLY_TOKEN) => db.sql('select public.queue_octowow_imports($1, $2::jsonb) as n', [token, JSON.stringify(items)]);
		await assert.rejects(queue('wrong'), /Only the nightly job/);
		assert.equal((await queue())[0].n, 1);
		assert.equal((await queue())[0].n, 0);
		let [row] = await db.sql('select * from public.import_queue');
		assert.equal(row.source, 'OctoWoW');
		assert.equal(row.status, 'pending');
		assert.deepEqual(await db.sql('select * from public.addons'), []);
		await db.as(admin, q => q("select public.decide_imports($1, 'rejected')", [[row.id]]));
		await queue();
		assert.equal((await db.sql('select status from public.import_queue'))[0].status, 'rejected');
		await db.as(admin, q => q("select public.decide_imports($1, 'pending')", [[row.id]]));
		await db.as(admin, q => q('select public.publish_import($1, $2::jsonb)', [row.id, JSON.stringify({name:'AdeAlts',description:'Tracks alts',category:'Miscellaneous'})]));
		assert.equal((await db.sql('select source from public.addons'))[0].source, 'OctoWoW');
		assert.equal((await queue())[0].n, 0);
		assert.deepEqual(await db.sql('select * from public.wiki_listing'), []);
	} finally { await db.close(); }
});
