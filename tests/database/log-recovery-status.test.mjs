import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { addon, post } from '../helpers/db.mjs';
import { createRulesContext } from '../helpers/rules-context.mjs';

let db, owner, admin, admin2, alice, bob, call, refused;
beforeEach(async () => ({db,owner,admin,admin2,alice,bob,call,refused}=await createRulesContext()));
afterEach(() => db.close());
const status = async (id, who = owner) => (await call(who,'select * from public.log_recovery_status($1)',[[id]]))[0];
const latest = async action => (await db.sql('select * from public.activity_log where action=$1 order by id desc limit 1',[action]))[0];
async function edited() {
 const row=await post(db,alice,addon('RecoveryStatus'));
 await call(admin,'update public.addons set description=$1 where id=$2',['Damaged description',row.id]);
 return {row,edit:await latest('addon.update')};
}

test('recovery links the exact edit and repeat protection preserves legitimate later changes',async()=>{
 const {row,edit}=await edited();
 assert.equal((await status(edit.id)).available,true);
 await call(owner,'select public.revert_addon($1)',[edit.id]);
 const recovery=await latest('addon.revert');
 assert.equal(recovery.details.undid,edit.id);
 const resolved=await status(edit.id);
 assert.equal(resolved.recovery_id,recovery.id);
 assert.equal(resolved.actor_name,owner.username);
 assert.deepEqual(resolved.recovered_at,recovery.at);
 await call(admin2,'update public.addons set description=$1 where id=$2',['Legitimate later improvement',row.id]);
 await refused(()=>call(owner,'select public.revert_addon($1)',[edit.id]),/already been recovered/);
 assert.equal((await db.sql('select description from public.addons where id=$1',[row.id]))[0].description,'Legitimate later improvement');
 await refused(()=>call(owner,'select public.recover_edit($1)',[edit.id]),/already been recovered/);
});

test('no-op recovery is recorded without spending edit budget and cannot be repeated',async()=>{
 const {row,edit}=await edited();
 await call(owner,'update public.addons set description=$1 where id=$2',[edit.details.before.description,row.id]);
 const before=await db.sql("select id from public.activity_log where actor=$1 and action in ('addon.update','addon.revert')",[admin2.id]);
 await call(admin2,'select public.revert_addon($1)',[edit.id]);
 const recovery=await latest('addon.recovery');
 assert.equal(recovery.details.undid,edit.id);
 assert.deepEqual(await db.sql("select id from public.activity_log where actor=$1 and action in ('addon.update','addon.revert')",[admin2.id]),before);
 const logs=await db.sql('select id from public.activity_log order by id');
 await refused(()=>call(admin2,'select public.recover_edit($1)',[edit.id]),/already been recovered/);
 assert.deepEqual(await db.sql('select id from public.activity_log order by id'),logs);
});

test('group recovery status includes another actor and repeat group recovery is blocked',async()=>{
 const first=await post(db,alice,addon('GroupStatusOne'));
 const second=await post(db,bob,addon('GroupStatusTwo'));
 await call(admin,'select public.group_addons($1)',[[first.id,second.id]]);
 const group=await latest('group.add');
 assert.equal((await status(group.id)).available,true);
 await call(owner,'select public.undo_grouping($1)',[group.id]);
 const recovery=await latest('group.undo');
 const resolved=await status(group.id,admin);
 assert.equal(resolved.available,false);
 assert.equal(resolved.actor_name,owner.username);
 assert.equal(resolved.recovery_id,recovery.id);
 await refused(()=>call(admin,'select public.undo_grouping($1)',[group.id]),/already been recovered/);
 // The recovery itself remains undoable as a distinct action.
 assert.equal((await status(recovery.id)).available,true);
 await call(owner,'select public.undo_grouping($1)',[recovery.id]);
});

test('report status detects excluded reopen events and superseded decisions',async()=>{
 const row=await post(db,alice,addon('ReportStatus'));
 await call(bob,"select public.report_addon($1,'harmful','Malicious executable')",[row.id]);
 const [report]=await db.sql('select id from public.reports where addon_id=$1',[row.id]);
 await call(admin,"select public.decide_report($1,'dismissed')",[report.id]);
 const original=await latest('report.dismiss');
 assert.equal((await status(original.id)).available,true);
 await call(owner,'select public.reopen_report($1)',[original.id]);
 const recovered=await status(original.id,admin);
 assert.equal(recovered.available,false);
 assert.equal(recovered.actor_name,owner.username);
 assert.equal(recovered.recovery_id,(await latest('report.reopen')).id);
 await call(admin2,"select public.decide_report($1,'handled')",[report.id]);
 const newer=await latest('report.handle');
 assert.equal((await status(original.id)).available,false);
 assert.equal((await status(newer.id)).available,true);
 // A newer decision can also supersede a historical decision without a recovery event.
 await db.sql("insert into public.activity_log(action,addon_id,details) values('report.dismiss',$1,$2)",[row.id,{report_id:report.id}]);
 const superseded=await status((await latest('report.dismiss')).id);
 assert.equal(superseded.available,false);
 assert.match(superseded.reason,/no longer current/);
});

test('account rollback records exact edit recovery and previews leave no recovery markers',async()=>{
 const {edit}=await edited();
 await call(owner,"select public.rollback_account($1,now()-interval '1 hour',true)",[admin.id]);
 assert.equal((await status(edit.id)).recovery_id,null);
 await call(owner,"select public.rollback_account($1,now()-interval '1 hour',false)",[admin.id]);
 assert.equal((await status(edit.id)).recovery_id,(await latest('addon.revert')).id);
});

test('members and visitors cannot read recovery metadata or bypass the protected revert',async()=>{
 const {edit}=await edited();
 await refused(()=>status(edit.id,alice),/Only admins/);
 await refused(()=>call(alice,'select public.recover_edit($1)',[edit.id]),/Only admins/);
 await refused(()=>db.asVisitor(q=>q('select * from public.log_recovery_status($1)',[[edit.id]])),/permission denied/);
 await refused(()=>call(admin,'select private.apply_edit_recovery($1)',[edit.id]),/permission denied/);
 await refused(()=>call(owner,'select * from public.log_recovery_status($1)',[Array(101).fill(edit.id)]),/at most 100/);
 assert.deepEqual(await call(owner,'select * from public.log_recovery_status($1)',[[]]),[]);
});

test('failed recovery creates no success marker; missing snapshots are unavailable',async()=>{
 const {edit}=await edited();
 await db.sql("update public.activity_log set details=details-'before' where id=$1",[edit.id]);
 const resolved=await status(edit.id);
 assert.equal(resolved.available,false);
 assert.match(resolved.reason,/no longer available/);
 await refused(()=>call(owner,'select public.revert_addon($1)',[edit.id]),/too old to revert/);
 assert.equal((await status(edit.id)).recovery_id,null);
});

 test('field recovery preserves unrelated later changes and blocks overlapping edits',async()=>{
  const {row,edit}=await edited();
  await call(admin2,"update public.addons set category='PvP' where id=$1",[row.id]);
  await call(owner,'select public.revert_addon($1)',[edit.id]);
  const [current]=await db.sql('select description,category from public.addons where id=$1',[row.id]);
  assert.equal(current.category,'PvP');
  assert.equal(current.description,edit.details.before.description);
  await call(admin,'update public.addons set description=$1 where id=$2',['Another damaged description',row.id]);
  const next=await latest('addon.update');
  await call(admin2,'update public.addons set description=$1 where id=$2',['Later legitimate description',row.id]);
  const resolved=await status(next.id);
  assert.equal(resolved.available,false);
  assert.deepEqual(resolved.conflicts,['description']);
  await refused(()=>call(owner,'select public.revert_addon($1)',[next.id]),/Conflicts with later changes/);
  const [comparison]=await call(owner,'select public.recovery_comparison($1) as data',[next.id]);
  assert.equal(comparison.data.current.description,'Later legitimate description');
  assert.equal(comparison.data.later[0].actor,admin2.username);
 });
 test('manual resolution is logged once and cannot overwrite a concurrent edit',async()=>{
  const {row,edit}=await edited();
  await call(admin2,'update public.addons set description=$1 where id=$2',['Later valid changes to retain',row.id]);
  const [current]=await db.sql('select * from public.addons where id=$1',[row.id]);
  await refused(()=>call(alice,'select public.resolve_log_edit($1,$2,$3)',[edit.id,{description:'Manual review resolution'},current.updated_at]),/Only admins/);
  await call(admin2,'update public.addons set author=$1 where id=$2',['Later author',row.id]);
  await refused(()=>call(owner,'select public.resolve_log_edit($1,$2,$3)',[edit.id,{description:'Manual review resolution'},current.updated_at]),/changed while you were reviewing/);
  const [fresh]=await db.sql('select * from public.addons where id=$1',[row.id]);
  await call(owner,'select public.resolve_log_edit($1,$2,$3)',[edit.id,{description:'Manual review resolution'},fresh.updated_at]);
  const recorded=await status(edit.id);
  assert.equal(recorded.available,false);
  assert.equal(recorded.actor_name,owner.username);
  const log=await latest('addon.update');
  assert.equal(log.details.manual,true);
  assert.equal(log.details.undid,edit.id);
  assert.equal((await db.sql('select author from public.addons where id=$1',[row.id]))[0].author,'Later author');
  await refused(()=>call(owner,'select public.revert_addon($1)',[edit.id]),/already been recovered/);
 });
 test('later regrouping is detected and cannot be overwritten by an older group undo',async()=>{
  const a=await post(db,alice,addon('ConflictGroupA'));
  const b=await post(db,bob,addon('ConflictGroupB'));
  const c=await post(db,bob,addon('ConflictGroupC'));
  await call(admin,'select public.group_addons($1)',[[a.id,b.id]]);
  const first=await latest('group.add');
  await call(admin2,'select public.group_addons($1)',[[a.id,c.id]]);
  assert.equal((await status(first.id)).available,false);
  await refused(()=>call(owner,'select public.undo_grouping($1)',[first.id]),/Conflicts with later grouping/);
 });

 test('a mistaken recovery is undone through its own new log entry',async()=>{
  const {row,edit}=await edited();
  await call(owner,'select public.revert_addon($1)',[edit.id]);
  const recovery=await latest('addon.revert');
  await call(owner,'select public.revert_addon($1)',[recovery.id]);
  assert.equal((await db.sql('select description from public.addons where id=$1',[row.id]))[0].description,'Damaged description');
  assert.equal((await status(edit.id)).available,false);
  assert.equal((await status(recovery.id)).available,false);
 });
 test('legacy edits without a recorded after-value require manual review',async()=>{
  const {row,edit}=await edited();
  await db.sql("update public.activity_log set details=details-'after' where id=$1",[edit.id]);
  assert.equal((await status(edit.id)).available,false);
  await refused(()=>call(owner,'select public.revert_addon($1)',[edit.id]),/Conflicts/);
  await refused(()=>call(alice,'select public.recovery_comparison($1)',[edit.id]),/Only admins/);
  assert.equal((await db.sql('select description from public.addons where id=$1',[row.id]))[0].description,'Damaged description');
 });

 test('old grouping events without a saved resulting state fail closed',async()=>{
  const a=await post(db,alice,addon('LegacyGroupA'));
  const b=await post(db,bob,addon('LegacyGroupB'));
  await call(admin,'select public.group_addons($1)',[[a.id,b.id]]);
  const entry=await latest('group.add');
  await db.sql("update public.activity_log set details=details-'groups_after' where id=$1",[entry.id]);
  const current=await status(entry.id);
  assert.equal(current.available,false);
  assert.match(current.reason,/cannot be verified/);
  await refused(()=>call(owner,'select public.undo_grouping($1)',[entry.id]),/review manually/);
 });

 test('recovering a rename restores its name and address without replacing later description changes',async()=>{
  const row=await post(db,alice,addon('RenameBefore'));
  await call(admin,"update public.addons set name='RenameAfter' where id=$1",[row.id]);
  const edit=await latest('addon.update');
  await call(admin2,"update public.addons set description='Useful later description' where id=$1",[row.id]);
  await call(owner,'select public.revert_addon($1)',[edit.id]);
  const [current]=await db.sql('select name,slug,description from public.addons where id=$1',[row.id]);
  assert.equal(current.name,row.name);
  assert.equal(current.slug,row.slug);
  assert.equal(current.description,'Useful later description');
 });
