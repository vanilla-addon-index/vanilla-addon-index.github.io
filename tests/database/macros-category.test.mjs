import assert from 'node:assert/strict';
import {test} from 'node:test';
import {addon, createDb, post} from '../helpers/db.mjs';

test('Macros is accepted for member submissions and approved imports', async () => {
	const db = await createDb();
	try {
		const member = await db.addUser('member'), admin = await db.addUser('admin', 'admin');
		const row = await post(db, member, addon('MacroHelper', undefined, {category:'Macros'}));
		assert.equal(row.category, 'Macros');
		await db.queueImports([{name:'MacroDebug', url:'https://github.com/a/MacroDebug', description:'Helps debug and inspect macros', category:'Macros'}]);
		const [{id}] = await db.sql('select id from public.import_queue');
		await db.as(admin, q => q('select public.approve_imports($1)', [[id]]));
		assert.equal((await db.sql("select category from public.addons where name = 'MacroDebug'"))[0].category, 'Macros');
	} finally { await db.close(); }
});
