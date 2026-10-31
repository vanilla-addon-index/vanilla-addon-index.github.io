import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { addon, post } from '../helpers/db.mjs';
import { createRulesContext } from '../helpers/rules-context.mjs';

let db, owner, admin, admin2, alice, bob, call, refused;
beforeEach(async () => {
 ({ db, owner, admin, admin2, alice, bob, call, refused } = await createRulesContext());
});
afterEach(() => db.close());
const records = () => call(owner, 'select * from public.list_deleted_accounts()');
const rollback = async (id, preview = false, who = owner) =>
 (await call(who, "select public.rollback_account($1,now()-interval '1 hour',$2) as result", [id, preview]))[0].result;

test('the owner can preview and recover edits, deletes, bans and imports after a rogue admin leaves', async () => {
 const edited = await post(db, alice, addon('Edited'));
 const deleted = await post(db, bob, addon('Deleted'));
 await db.sql("update public.activity_log set at=now()-interval '2 hours'");
 await db.queueImports([{name:'Imported',url:'https://github.com/test/imported'}, {name:'Rejected',url:'https://github.com/test/rejected'}]);
 const queue = await db.sql('select id from public.import_queue order by id');
 await call(admin, "update public.addons set author='Damage' where id=$1", [edited.id]);
 await call(admin, 'delete from public.addons where id=$1', [deleted.id]);
 await call(admin, 'select public.set_banned($1,true)', [bob.id]);
 await call(admin, 'select public.approve_imports($1)', [[queue[0].id]]);
 await call(admin, "select public.decide_imports($1,'rejected')", [[queue[1].id]]);
 await call(admin, 'select public.delete_account()');
 const [record] = await records();
 assert.notEqual(record.id, admin.id);
 assert.equal((await db.sql('select id from auth.users where id=$1',[admin.id])).length, 0);
 assert.equal((await db.sql('select actor from public.activity_log where recovery_actor=$1 and actor is not null',[record.id])).length,0);
 const preview = await rollback(record.id,true);
 assert.deepEqual(preview.skipped,[]);
 assert.deepEqual(preview.steps.map(s=>s.kind).sort(),['requeue','restore','revert','unapprove','unban'].sort());
 assert.equal((await db.sql('select author from public.addons where id=$1',[edited.id]))[0].author,'Damage');
 assert.equal((await db.sql('select id from public.addons where id=$1',[deleted.id])).length,0);
 const result = await rollback(record.id);
 assert.deepEqual(result.steps,preview.steps);
 assert.deepEqual(result.skipped,[]);
 assert.equal((await db.sql('select author from public.addons where id=$1',[edited.id]))[0].author,'');
 assert.equal((await db.sql('select id from public.addons where id=$1',[deleted.id])).length,1);
 assert.equal((await db.sql('select banned from public.profiles where id=$1',[bob.id]))[0].banned,false);
 assert.deepEqual((await db.sql('select status from public.import_queue order by id')).map(r=>r.status),['pending','pending']);
});

test('deleted recovery is owner-only and its private provenance cannot be read or forged', async () => {
 await post(db,admin,addon('AdminPost'));
 await call(admin,'select public.delete_account()');
 const [record] = await records();
 for (const who of [alice,admin2]) {
  assert.deepEqual(await call(who,'select * from public.list_deleted_accounts()'),[]);
  await refused(()=>rollback(record.id,false,who), /Only (the owner|admins)/);
  await refused(()=>call(who,'select * from public.deleted_account_recovery'),/permission denied/);
  await refused(()=>call(who,'update public.activity_log set recovery_actor=$1',[record.id]),/permission denied/);
 }
 await refused(()=>db.asVisitor(q=>q('select * from public.list_deleted_accounts()')),/permission denied/);
 assert.deepEqual(await call(owner,'select * from public.list_deleted_accounts($1)',[alice.id]),[]);
});

test('deleted accounts stay distinct from new accounts with the same username', async () => {
 const a=await post(db,alice,addon('First'));
 await call(alice,'select public.delete_account()');
 const [first]=await records();
 const again=await db.addUser('alice');
 const b=await post(db,again,addon('Second'));
 await call(again,'select public.delete_account()');
 assert.ok((await records()).find(r=>r.id!==first.id));
 await rollback(first.id);
 assert.equal((await db.sql('select id from public.addons where id=$1',[a.id])).length,0);
 assert.equal((await db.sql('select id from public.addons where id=$1',[b.id])).length,1);
});

test('shared imported links retain recovery provenance after account deletion', async () => {
 const page=await post(db,alice,addon('Shared'));
 await db.sql("update public.activity_log set at=now()-interval '2 hours'");
 await db.queueImports([{name:'Shared',url:'https://github.com/test/shared-import'}]);
 const [queued]=await db.sql('select id from public.import_queue');
 await call(admin,'select public.publish_import($1,null,$2)',[queued.id,page.id]);
 await call(admin,'select public.delete_account()');
 const [record]=await records();
 assert.deepEqual((await rollback(record.id,true)).skipped,[]);
 assert.deepEqual((await rollback(record.id)).skipped,[]);
 const [after]=await db.sql('select versions from public.addons where id=$1',[page.id]);
 assert.deepEqual(after.versions.map(v=>v.url),['https://github.com/someone/Shared']);
 assert.equal((await db.sql('select status from public.import_queue'))[0].status,'pending');
});

test('deletion outside the account RPC also preserves pseudonymous recovery', async () => {
 const page=await post(db,alice,addon('Victim'));
 await call(admin,"update public.addons set author='Damage' where id=$1",[page.id]);
 await db.sql('delete from auth.users where id=$1',[admin.id]);
 const [record]=await records();
 assert.ok(record);
 assert.equal((await rollback(record.id)).skipped.length,0);
 assert.equal((await db.sql('select author from public.addons where id=$1',[page.id]))[0].author,'');
});

test('deleted recovery discovery paginates deterministically even when timestamps match', async () => {
 await db.raw(`insert into public.deleted_account_recovery(links,imports,link_requests,suggestions,reports)
  select '{}','{}','{}','{}','{}' from generate_series(1,205)`);
 const first = await records();
 assert.equal(first.length,200);
 const second = await call(owner,'select * from public.list_deleted_accounts(null,$1)',[first.at(-1).id]);
 assert.equal(second.length,5);
 assert.equal(new Set([...first,...second].map(r=>r.id)).size,205);
 assert.equal((await call(owner,'select * from public.list_deleted_accounts($1)',[second[0].id])).length,1);
});

test('deleting a suspended admin still leaves owner-only recovery and removes its login', async () => {
 const victim = await post(db,alice,addon('SuspendedVictim'));
 await call(admin,"update public.addons set author='Damage' where id=$1",[victim.id]);
 await call(owner,'select public.set_banned($1,true)',[admin.id]);
 await call(admin,'select public.delete_account()');
 const [record] = await records();
 await refused(()=>rollback(record.id,false,admin2),/Only the owner/);
 assert.deepEqual((await rollback(record.id)).skipped,[]);
 assert.equal((await db.sql('select author from public.addons where id=$1',[victim.id]))[0].author,'');
});
