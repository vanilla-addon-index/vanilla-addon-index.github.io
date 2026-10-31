import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { addon, post } from '../helpers/db.mjs';
import { createRulesContext } from '../helpers/rules-context.mjs';

let db, owner, admin, alice, call, refused;
beforeEach(async () => {
 ({ db, owner, admin, alice, call, refused } = await createRulesContext());
});
afterEach(() => db.close());
const page = async (search = '', before, who = admin) =>
 (await call(who,'select public.list_trash($1,$2,$3) as result',[search,before?.deleted_at ?? null,before?.id ?? null]))[0].result;
const seed = count => db.sql(`insert into public.addon_trash(addon,name,reason,deleted_by_name)
 select '{}'::jsonb,'Filler '||i,'delete','TestDeleter' from generate_series(1,$1::int)i`,[count]);

test('search finds and restores entries beyond 1000 rows with exact full-dataset counts', async () => {
 await seed(1205);
 const original=await post(db,alice,addon('OldRecoverable'));
 await call(admin,'delete from public.addons where id=$1',[original.id]);
 await db.sql("update public.addon_trash set deleted_at=now()-interval '2 hours' where name='OldRecoverable'");
 const first=await page();
 assert.equal(first.items.length,100);
 assert.equal(first.total,1206);
 assert.equal(first.matching,1206);
 assert.equal(first.more,true);
 assert.equal(first.items.some(row=>row.name==='OldRecoverable'),false);
 const found=await page('oldrecoverable');
 assert.equal(found.total,1206);
 assert.equal(found.matching,1);
 assert.equal(found.more,false);
 assert.equal(found.items[0].name,original.name);
 await call(admin,'select public.restore_addon($1)',[found.items[0].id]);
 assert.equal((await page('oldrecoverable')).matching,0);
 assert.equal((await page()).total,1205);
 assert.equal((await db.sql('select name from public.addons where id=$1',[original.id]))[0].name,original.name);
});

test('pagination traverses tied timestamps without duplicates and searches literal text and deleter names', async () => {
 await seed(1205);
 const ids=[];
 let next=await page('testdeleter');
 while(true) {
  ids.push(...next.items.map(row=>row.id));
  assert.equal(next.matching,1205);
  if(!next.more) break;
  next=await page('testdeleter',next.items.at(-1));
 }
 assert.equal(ids.length,1205);
 assert.equal(new Set(ids).size,1205);
 assert.deepEqual(ids,[...ids].sort((a,b)=>b-a));
 await db.sql("insert into public.addon_trash(addon,name,reason) values('{}','100%_[x],(test)','delete')");
 assert.equal((await page('%_[x],(')).matching,1);
 assert.equal((await page('does not exist')).items.length,0);
});

test('a page cursor remains usable after that entry is purged and ignores newly inserted rows', async () => {
 await seed(201);
 const first=await page();
 const cursor=first.items.at(-1);
 await call(owner,'select public.purge_trash($1)',[[cursor.id]]);
 await seed(1);
 const next=await page('',cursor);
 assert.equal(next.items.length,100);
 assert.ok(next.items.every(row=>row.id<cursor.id));
 assert.equal(next.more,true);
 assert.equal(next.total,201);
});

test('trash searches remain admin-only and individual permanent deletion remains owner-only', async () => {
 await seed(5);
 const first=await page();
 await refused(()=>page('',undefined,alice),/Only admins/);
 await refused(()=>db.asVisitor(q=>q('select public.list_trash()')),/permission denied/);
 await refused(()=>call(admin,'select public.purge_trash($1)',[[first.items[0].id]]),/Only the owner/);
 await refused(()=>call(alice,'select public.purge_trash($1)',[[first.items[0].id]]),/Only the owner/);
 await refused(()=>call(admin,'select public.list_trash($1,null,$2)',['',1]),/Invalid trash cursor/);
 assert.equal((await page()).total,5);
});
