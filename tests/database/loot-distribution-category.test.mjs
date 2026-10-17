import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {addon, createDb, post} from '../helpers/db.mjs';

test('Loot Distribution supports submissions and approved imports',async()=>{
	const db=await createDb();
	try {
		const member=await db.addUser('member'), admin=await db.addUser('admin','admin');
		assert.equal((await post(db,member,addon('LootHelper',undefined,{category:'Loot Distribution'}))).category,'Loot Distribution');
		await db.queueImports([{name:'LootCouncil',url:'https://github.com/a/LootCouncil',description:'Helps the guild distribute raid loot',category:'Loot Distribution'}]);
		const [{id}]=await db.sql('select id from public.import_queue');
		await db.as(admin,q=>q('select public.approve_imports($1)',[[id]]));
		assert.equal((await db.sql("select category from public.addons where name='LootCouncil'"))[0].category,'Loot Distribution');
	} finally {await db.close();}
});

test('migration moves audited tools only and is safe to replay',async()=>{
	const db=await createDb();
	try {
		const admin=await db.addUser('admin','admin');
		const names=['DKPList','DKPAuctionBidder','WebDKPElysium','DPEPGP','EZ-EPGP','EPGPexport','GuildRoll','TitanGuild','ChaosReserves','ChatLootBidder','EasyLoot','LootRes','RollFor','RoundRobinhood','LootBlare','LootBlare2.0','RaidRollBuddy','RaidRollHelper','SmartRoll','CleanRolls','XckMasterLootAdvanced','AutoMasterLooter','MasterLootByClass'];
		for (const name of [...names,'AtlasLoot','RaidCalendar','MasterLootRemind','LootTracker']) await post(db,admin,addon(name,undefined,{category:['TitanGuild','ChaosReserves'].includes(name)?'Chat & Social':'Raid & Party'}));
		const sql=readFileSync(new URL('../../supabase/migrations/20261017000002_loot_distribution_category.sql',import.meta.url),'utf8');
		await db.raw(sql);
		const changed=await db.sql("select name from public.addons where category='Loot Distribution' order by name");
		assert.deepEqual(changed.map(r=>r.name),[...names].sort());
		await db.raw(sql);
		assert.equal((await db.sql("select count(*)::int as n from public.addons where category='Loot Distribution'"))[0].n,23);
	} finally {await db.close();}
});
