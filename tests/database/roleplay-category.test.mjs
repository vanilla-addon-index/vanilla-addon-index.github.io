import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {addon,createDb,post} from '../helpers/db.mjs';

test('Roleplay supports submissions and import approval',async()=>{
	const db=await createDb();
	try {
		const member=await db.addUser('member'),admin=await db.addUser('admin','admin');
		assert.equal((await post(db,member,addon('RPProfile',undefined,{category:'Roleplay'}))).category,'Roleplay');
		await db.queueImports([{name:'RPItems',url:'https://github.com/a/RPItems',description:'Create interactive roleplaying items',category:'Roleplay'}]);
		const [{id}]=await db.sql('select id from public.import_queue');
		await db.as(admin,q=>q('select public.approve_imports($1)',[[id]]));
		assert.equal((await db.sql("select category from public.addons where name='RPItems'"))[0].category,'Roleplay');
	} finally {await db.close();}
});

test('migration moves only the four audited RP tools and can be replayed',async()=>{
	const db=await createDb();
	try {
		const admin=await db.addUser('admin','admin');
		const names=['TurtleRP','Erea-RP','RoleplayingHelper','Journal'];
		for(const name of [...names,'ChatEmote','ROAR-Guild','CTPlayerNotes','TwitchEmotes']) await post(db,admin,addon(name,undefined,{category:'Chat & Social'}));
		const sql=readFileSync(new URL('../../supabase/migrations/20261017000003_roleplay_category.sql',import.meta.url),'utf8');
		await db.raw(sql);
		await db.raw(sql);
		assert.deepEqual((await db.sql("select name from public.addons where category='Roleplay' order by name")).map(r=>r.name),[...names].sort());
		assert.equal((await db.sql("select count(*)::int as n from public.addons where category='Chat & Social'"))[0].n,4);
	} finally {await db.close();}
});
