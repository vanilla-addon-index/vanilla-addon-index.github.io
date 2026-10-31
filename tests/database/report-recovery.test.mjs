import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, test } from 'node:test';
import { addon, post } from '../helpers/db.mjs';
import { createRulesContext } from '../helpers/rules-context.mjs';

let db, owner, admin, admin2, alice, bob, call, refused;
beforeEach(async () => {
 ({ db, owner, admin, admin2, alice, bob, call, refused } = await createRulesContext());
});
afterEach(() => db.close());
const rollback = async (target = admin, preview = false, who = owner) =>
 (await call(who,"select public.rollback_account($1,now()-interval '1 hour',$2) as result",[target.id,preview]))[0].result;
const close = (id, who = admin, outcome = 'dismissed') => call(who,'select public.decide_report($1,$2)',[id,outcome]);
const reopen = (logId, who = owner) => call(who,'select public.reopen_report($1) as reopened',[logId]);
async function report(row, who = bob, note = 'Suspicious executable in the download.') {
 await call(who,"select public.report_addon($1,'harmful',$2)",[row.id,note]);
 return (await db.sql('select * from public.reports where addon_id=$1 and reported_by=$2 order by id desc limit 1',[row.id,who.id]))[0];
}
const state = async id => (await db.sql('select * from public.reports where id=$1',[id]))[0];

for (const outcome of ['dismissed','handled']) {
 test(`rollback previews and reopens ${outcome} reports without losing the original report`, async () => {
  const row = await post(db,alice,addon('Harmful'));
  const original = await report(row);
  await close(original.id,admin,outcome);
  const closed = await state(original.id);
  const logs = await db.sql('select * from public.activity_log order by id');
  const preview = await rollback(admin,true);
  assert.deepEqual(preview,{steps:[{kind:'reopen',subject:row.name}],skipped:[]});
  assert.deepEqual(await state(original.id),closed);
  assert.deepEqual(await db.sql('select * from public.activity_log order by id'),logs);
  assert.deepEqual(await rollback(),preview);
  assert.deepEqual(await state(original.id),{...original,decision_log_id:null});
  const [entry] = await db.sql("select actor,details from public.activity_log where action='report.reopen'");
  assert.equal(entry.actor,owner.id);
  assert.equal(entry.details.report_id,original.id);
  assert.equal(entry.details.undid,closed.decision_log_id);
  assert.deepEqual((await rollback()).steps,[]);
 });
}

test('reopening is owner-only and preserves the normal report permissions', async () => {
 const row = await post(db,alice,addon('PrivateRecovery'));
 const original = await report(row);
 await close(original.id);
 const {decision_log_id: id} = await state(original.id);
 for (const who of [admin,admin2,alice,bob]) await refused(()=>reopen(id,who),/Only the owner/);
 await refused(()=>db.asVisitor(q=>q('select public.reopen_report($1)',[id])),/permission denied/);
 await refused(()=>call(admin,"update public.reports set status='open'"),/permission denied/);
 await refused(()=>reopen(-1),/not a report decision/);
 assert.equal((await state(original.id)).status,'dismissed');
 await reopen(id);
 await close(original.id,admin2,'handled');
 assert.equal((await state(original.id)).status,'handled');
});

test('rollback and stale History actions preserve a newer decision by another admin', async () => {
 const row = await post(db,alice,addon('LaterDecision'));
 const original = await report(row);
 await close(original.id);
 const oldId = (await state(original.id)).decision_log_id;
 await reopen(oldId);
 await close(original.id,admin2,'handled');
 const newer = await state(original.id);
 assert.deepEqual(await rollback(),{steps:[],skipped:[]});
 assert.equal((await reopen(oldId))[0].reopened,false);
 assert.deepEqual(await state(original.id),newer);
});

test('multiple reports closed in one transaction are matched by their exact report ids', async () => {
 const row = await post(db,alice,addon('SeveralReports'));
 const first = await report(row,alice,'First harmful report.');
 const second = await report(row,bob,'Second harmful report.');
 await db.as(admin,async q=>{
  await q("select public.decide_report($1,'dismissed')",[first.id]);
  await q("select public.decide_report($1,'dismissed')",[second.id]);
 });
 assert.notEqual((await state(first.id)).decision_log_id,(await state(second.id)).decision_log_id);
 assert.equal((await rollback()).steps.length,2);
 assert.equal((await state(first.id)).note,first.note);
 assert.equal((await state(second.id)).note,second.note);
 assert.equal((await state(first.id)).status,'open');
 assert.equal((await state(second.id)).status,'open');
});

test('a newer open report produces an explicit skipped step instead of losing either report', async () => {
 const row = await post(db,alice,addon('ReportedAgain'));
 const original = await report(row);
 await close(original.id);
 const newer = await report(row,bob,'A second report with different evidence.');
 const preview = await rollback(admin,true);
 assert.deepEqual(preview.steps,[]);
 assert.equal(preview.skipped.length,1);
 assert.match(preview.skipped[0].why,/newer report.*already open/);
 assert.deepEqual(await rollback(),preview);
 assert.equal((await state(original.id)).status,'dismissed');
 assert.deepEqual(await state(newer.id),newer);
 assert.equal((await state(original.id)).note,original.note);
});

test('a deleted admin cannot evade recovery of its report decisions', async () => {
 const row = await post(db,alice,addon('DeletedReviewer'));
 const original = await report(row);
 await close(original.id);
 await call(admin,'select public.delete_account()');
 const [archived] = await call(owner,'select * from public.list_deleted_accounts()');
 assert.deepEqual((await rollback(archived)).steps,[{kind:'reopen',subject:row.name}]);
 assert.equal((await state(original.id)).status,'open');
});

test('ordinary admin rollback explicitly reports report decisions that require owner recovery', async () => {
 const row = await post(db,alice,addon('FormerReviewer'));
 const original = await report(row);
 await close(original.id,admin2);
 await call(owner,'select public.set_admin($1,false)',[admin2.id]);
 const result = await rollback(admin2,false,admin);
 assert.equal(result.skipped.length,1);
 assert.match(result.skipped[0].why,/Only the owner can reopen/);
 assert.equal((await state(original.id)).status,'dismissed');
});

test('migration links unambiguous legacy decisions and warns about ambiguous old records', async () => {
 const row = await post(db,alice,addon('LegacyReports'));
 const first = await report(row,alice);
 const second = await report(row,bob);
 await close(first.id);
 // Simulate the format stored before this migration, then run its real backfill.
 await db.sql("update public.activity_log set details=details-'report_id' where action='report.dismiss'");
 await db.sql('update public.reports set decision_log_id=null');
 const migration = readFileSync(new URL('../../supabase/migrations/20261031000004_report_decision_recovery.sql',import.meta.url),'utf8');
 const backfill = migration.slice(migration.indexOf('with matches as ('),migration.indexOf('create or replace function public.decide_report'));
 await db.raw(backfill);
 assert.ok((await state(first.id)).decision_log_id);
 await reopen((await state(first.id)).decision_log_id);
 // Two indistinguishable reports/decisions from one old transaction are unsafe to infer.
 await db.as(admin,async q=>{
  await q("select public.decide_report($1,'dismissed')",[first.id]);
  await q("select public.decide_report($1,'dismissed')",[second.id]);
 });
 await db.sql("update public.activity_log set details=details-'report_id' where action='report.dismiss'");
 await db.sql('update public.reports set decision_log_id=null');
 await db.raw(backfill);
 assert.equal((await state(first.id)).decision_log_id,null);
 const result = await rollback();
 assert.ok(result.skipped.some(s=>/cannot be matched.*safely/.test(s.why)));
 assert.equal((await state(first.id)).status,'dismissed');
 assert.equal((await state(second.id)).status,'dismissed');
});
