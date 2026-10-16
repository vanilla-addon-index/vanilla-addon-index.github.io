import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDb, NIGHTLY_TOKEN } from '../helpers/db.mjs';

test('nightly category context merges partial evidence, survives refresh and only updates pending imports', async () => {
 const db = await createDb();
 try {
  const item = {key:'github.com/a/addon',url:'https://github.com/a/addon',name:'Addon',description:'Wiki prose',category:'Combat',images:[],alts:[],obsolete:false,parent:null,group_key:null};
  await db.queueImports([item]);
  const save = (context, token=NIGHTLY_TOKEN) => db.sql('select public.store_category_context($1,$2::jsonb)',[token,JSON.stringify([{key:item.key,context}])]);
  await assert.rejects(() => save({readme:'Unauthorized'}, 'wrong'), /Only the nightly/);
  await save({repository:'Quest tracker'});
  await save({toc:'Tracks quests'});
  await db.queueImports([item]);
  let [row] = await db.sql('select description, category_context from public.import_queue where key=$1',[item.key]);
  assert.equal(row.description, 'Wiki prose');
  assert.deepEqual(row.category_context, {repository:'Quest tracker',toc:'Tracks quests'});
  const [links] = await db.sql('select public.nightly_links($1) as items',[NIGHTLY_TOKEN]);
  assert.deepEqual(links.items[0].category_item.category_context,row.category_context);
  await db.sql("update public.import_queue set status='rejected' where key=$1",[item.key]);
  await save({readme:'Must not save'});
  [row] = await db.sql('select category_context from public.import_queue where key=$1',[item.key]);
  assert.ok(!('readme' in row.category_context));
 } finally { await db.close(); }
});
