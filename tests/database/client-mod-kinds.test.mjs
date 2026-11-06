import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDb, addon, post } from '../helpers/db.mjs';

test('client kinds persist through edits and recovery, with safe collection-switch defaults', async () => {
 const db = await createDb();
 try {
  const admin = await db.addUser('admin', 'admin');
  for (const kind of ['Util','DLL','MPQ']) {
   const row = await post(db, admin, addon(`Client${kind}`, undefined, {entry_type:'dll', category:kind}));
   assert.equal(row.category,kind);
  }
  const row = await post(db, admin, addon('SwitchKind',undefined,{entry_type:'dll',category:'Combat'}));
  assert.equal(row.category,'DLL');
  await db.as(admin,q=>q("update public.addons set category='MPQ' where id=$1",[row.id]));
  const [log] = await db.sql("select id from public.activity_log where addon_id=$1 and action='addon.update' order by id desc limit 1",[row.id]);
  await db.as(admin,q=>q('select public.recover_edit($1)',[log.id]));
  assert.equal((await db.sql('select category from public.addons where id=$1',[row.id]))[0].category,'DLL');
  await db.as(admin,q=>q("update public.addons set entry_type='addon' where id=$1",[row.id]));
  assert.equal((await db.sql('select category from public.addons where id=$1',[row.id]))[0].category,'Miscellaneous');
  await db.as(admin,q=>q("update public.addons set category='Combat' where id=$1",[row.id]));
  assert.equal((await db.sql('select category from public.addons where id=$1',[row.id]))[0].category,'Combat');
 } finally { await db.close(); }
});
