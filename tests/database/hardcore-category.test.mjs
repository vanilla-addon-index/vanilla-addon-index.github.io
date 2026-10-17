import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { addon, createDb, post } from '../helpers/db.mjs';

test('Hardcore supports submissions and import approval', async () => {
	const db = await createDb();
	try {
		const member = await db.addUser('member'), admin = await db.addUser('admin', 'admin');
		assert.equal((await post(db, member, addon('SafetyHelper', undefined, { category: 'Hardcore' }))).category, 'Hardcore');
		await db.queueImports([{ name: 'DeathAlerts', url: 'https://github.com/a/DeathAlerts', description: 'Death warnings for hardcore characters', category: 'Hardcore' }]);
		const [{ id }] = await db.sql('select id from public.import_queue');
		await db.as(admin, q => q('select public.approve_imports($1)', [[id]]));
		assert.equal((await db.sql("select category from public.addons where name='DeathAlerts'"))[0].category, 'Hardcore');
	} finally { await db.close(); }
});

test('migration moves exactly the 13 audited entries and is safe to replay', async () => {
	const db = await createDb();
	try {
		const admin = await db.addUser('admin', 'admin');
		const audited = [
			['CliffTells', 'Chat & Social'], ['Deathlog', 'Map & Minimap'],
			['HardcoreAlarms', 'Miscellaneous'], ['HardcoreDeath', 'Chat & Social'],
			['HCDeaths', 'Miscellaneous'], ['HCFilter', 'Chat & Social'],
			['HCRank', 'Tooltip'], ['HCWarn', 'Miscellaneous'],
			['HC-TradeBoard', 'Miscellaneous'], ['RipMap', 'Map & Minimap'],
			['SelfFound', 'Auction & Economy'], ['TurtleChatColors', 'Chat & Social'],
			['TurtleHardcoreChatTamer', 'Chat & Social']
		];
		for (const [name, category] of audited) await post(db, admin, addon(name, undefined, { category }));
		for (const name of ['HCSpy', 'GrimReaper', 'MarketBoard', 'TurtleTranslator']) await post(db, admin, addon(name, undefined, { category: 'Miscellaneous' }));
		const sql = readFileSync(new URL('../../supabase/migrations/20261018000001_hardcore_category.sql', import.meta.url), 'utf8');
		await db.raw(sql);
		await db.raw(sql);
		assert.deepEqual((await db.sql("select name from public.addons where category='Hardcore' order by name")).map(row => row.name), audited.map(([name]) => name).sort());
		assert.equal((await db.sql("select count(*)::int as n from public.addons where category='Miscellaneous'"))[0].n, 4);
	} finally { await db.close(); }
});
