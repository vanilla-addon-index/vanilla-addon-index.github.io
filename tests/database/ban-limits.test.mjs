import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createRulesContext } from '../helpers/rules-context.mjs';

let db, owner, admin, admin2, alice, bob, call, refused, role;
beforeEach(async () => {
 ({ db, owner, admin, admin2, alice, bob, call, refused, role } = await createRulesContext());
});
afterEach(() => db.close());
const ban = (who, target, value) => call(who, 'select public.set_banned($1,$2)', [target.id,value]);
const logged = () => db.sql("select actor,action,subject from public.activity_log where action in ('user.ban','user.unban') order by id");

test('five combined bans/unbans exhaust the hourly allowance across members without suspending the admin', async () => {
 await ban(admin,alice,true);
 await ban(admin,bob,true);
 await ban(admin,alice,false);
 await ban(admin,bob,false);
 await ban(admin,alice,true);
 const before = await logged();
 await refused(()=>ban(admin,bob,true),/at most 5 ban or unban changes an hour/);
 await refused(()=>ban(admin,alice,false),/at most 5 ban or unban changes an hour/);
 assert.deepEqual(await logged(),before);
 assert.equal((await role(alice)).banned,true);
 assert.equal((await role(bob)).banned,false);
 assert.deepEqual(await role(admin),{admin:true,owner:false,banned:false});
 // Another admin has a separate allowance, and older changes stop counting.
 await ban(admin2,bob,true);
 await db.sql("update public.activity_log set at=at-interval '2 hours' where actor=$1",[admin.id]);
 await ban(admin,alice,false);
});

test('repeated states neither consume allowance nor add log entries, even at the limit', async () => {
 for(let i=0;i<5;i++) await ban(admin,alice,i%2===0);
 const before=await logged();
 for(let i=0;i<20;i++) {
  await ban(admin,alice,true);
  await ban(admin,bob,false);
 }
 assert.deepEqual(await logged(),before);
 await refused(()=>ban(admin,bob,true),/at most 5 ban or unban changes an hour/);
});

test('the rolling daily allowance permits fifteen changes and recovers as changes expire', async () => {
 for(let hour=0;hour<3;hour++) {
  for(let i=0;i<5;i++) await ban(admin,alice,(hour*5+i)%2===0);
  await db.sql("update public.activity_log set at=at-interval '2 hours' where actor=$1",[admin.id]);
 }
 const before=await logged();
 await refused(()=>ban(admin,alice,false),/at most 15 ban or unban changes a day/);
 await refused(()=>ban(admin,bob,true),/at most 15 ban or unban changes a day/);
 await ban(admin,alice,true);
 assert.deepEqual(await logged(),before);
 await db.sql("update public.activity_log set at=at-interval '25 hours' where actor=$1",[admin.id]);
 await ban(admin,alice,false);
});

test('owner recovery remains unlimited, including suspension of an admin', async () => {
 for(let i=0;i<20;i++) await ban(owner,alice,i%2===0);
 await ban(owner,admin,true);
 assert.equal((await role(admin)).admin,false);
 await ban(owner,admin,false);
 assert.equal((await role(admin)).admin,true);
});

test('account rollback uses the ordinary admin allowance while owner rollback remains available', async () => {
 await ban(admin2,bob,true);
 await call(owner,'select public.set_admin($1,false)',[admin2.id]);
 for(let i=0;i<5;i++) await ban(admin,alice,i%2===0);
 const rollback = who => call(who,"select public.rollback_account($1,now()-interval '1 hour',false) as result",[admin2.id]);
 const [{result}] = await rollback(admin);
 assert.equal(result.skipped.length,1);
 assert.match(result.skipped[0].why,/at most 5 ban or unban changes an hour/);
 assert.equal((await role(bob)).banned,true);
 assert.deepEqual((await rollback(owner))[0].result.skipped,[]);
 assert.equal((await role(bob)).banned,false);
});

test('no-op requests still enforce role, self-ban and protected-account checks', async () => {
 await refused(()=>ban(alice,bob,false),/Only admins/);
 await refused(()=>ban(admin,admin,false),/cannot ban yourself/);
 await refused(()=>ban(admin,owner,false),/owner cannot be banned/);
 await refused(()=>ban(admin,admin2,false),/Only the owner/);
 await refused(()=>ban(admin,bob,null),/Choose whether/);
 assert.deepEqual(await logged(),[]);
});
