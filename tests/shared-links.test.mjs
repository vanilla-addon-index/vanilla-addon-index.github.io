import assert from 'node:assert/strict';
import {test} from 'node:test';
import {addon, createDb, post, NIGHTLY_TOKEN} from './db.mjs';

test('upgrade consolidates old groups and duplicate names, keeping canonical content and recovery copies', async () => {
 const db=await createDb({beforeSharedMigration:async raw => {
  await raw.exec(`insert into public.addons(name,description,category,versions,source) values
   ('Atlas','Original canonical description','Miscellaneous','[{"url":"https://github.com/original/Atlas","note":""}]','Wiki'),
   ('ATLAS','Do not replace canonical text','Miscellaneous','[{"url":"https://github.com/fork/Atlas","note":""}]','Wiki'),
   ('Atlas Classic','Legacy group description','Miscellaneous','[{"url":"https://github.com/classic/Atlas","note":""}]','Wiki');
   update public.addons set group_id = 1, is_main = (name = 'Atlas') where name in ('Atlas','Atlas Classic');`);
 }});
 try {
  const rows=await db.sql('select * from public.addons');
  assert.equal(rows.length,1);assert.equal(rows[0].name,'Atlas');assert.equal(rows[0].description,'Original canonical description');
  assert.equal(rows[0].versions.length,3);assert.ok(rows[0].aliases.includes('atlas-classic'));assert.equal(rows[0].owner,null);
  assert.equal((await db.sql('select count(*) as n from public.addon_trash'))[0].n,2);
  const admin=await db.addUser('admin','admin');
  const [trash]=await db.sql("select id from public.addon_trash where name = 'ATLAS'");
  await db.as(admin,q=>q('select public.restore_addon($1)',[trash.id]));
  assert.equal((await db.sql('select count(*) as n from public.addons'))[0].n,2);
 } finally {await db.close();}
});

test('same-name submissions add only links, remove ownership, and rollback only the contributed link', async () => {
 const db = await createDb();
 try {
  const alice = await db.addUser('alice'), bob = await db.addUser('bobby'), carol = await db.addUser('carol'), admin = await db.addUser('admin', 'admin');
  const original = await post(db, alice, addon('Big Wigs', 'https://github.com/alice/BigWigs'));
  const submit = (user, url) => db.as(user, q => q('select public.submit_addon($1::jsonb) as id', [JSON.stringify({name:'big-wigs', description:'DO NOT OVERWRITE', category:'bad', versions:[{url, note:''}]})]));
  const b = 'https://github.com/bob/BigWigs', c = 'https://github.com/carol/BigWigs';
  assert.equal((await submit(bob, b))[0].id, original.id);
  await submit(carol, c);
  const [shared] = await db.sql('select * from public.addons');
  assert.equal(shared.description, original.description);
  assert.equal(shared.category, original.category);
  assert.equal(shared.owner, null);
  assert.equal(shared.shared, true);
  assert.equal((await db.as(alice, q => q('update public.addons set description = $1 where id = $2 returning id', ['changed', original.id]))).length, 0);
  await assert.rejects(() => submit(bob, b + '.git'), /already listed/);
  await assert.rejects(() => post(db, bob, addon('BIGWIGS', 'https://github.com/other/BigWigs')), /already exists/);
  await assert.rejects(() => db.as(bob, q => q('select public.pin_addon_link($1,$2)', [original.id,b])), /Only admins/);
  await db.as(admin, q => q("select public.rollback_account($1, '1970-01-01', false)", [bob.id]));
  const [after] = await db.sql('select * from public.addons');
  assert.deepEqual(after.versions.map(v => v.url), [original.repo_url,c]);
  assert.equal(after.owner, null);
  // Rolling back the original submitter must not delete the contributors' page either.
  await db.as(admin, q => q("select public.rollback_account($1, '1970-01-01', false)", [alice.id]));
  assert.deepEqual((await db.sql('select versions from public.addons'))[0].versions.map(v=>v.url), [c]);
 } finally { await db.close(); }
});

test('newest code link leads automatically; a pin controls both the link and headline date', async () => {
 const db = await createDb();
 try {
  const alice = await db.addUser('alice'), bob = await db.addUser('bobby'), admin = await db.addUser('admin', 'admin');
  const a = await post(db, alice, addon('Atlas'));
  const b = 'https://github.com/bob/Atlas';
  await db.as(bob, q => q('select public.submit_addon($1::jsonb)', [JSON.stringify({name:'Atlas', versions:[{url:b}]})]));
  const dates = [{url:a.repo_url,date:'2020-01-01T00:00:00Z',history_url:a.repo_url+'/commits/HEAD'},{url:b,date:'2026-01-01T00:00:00Z',history_url:b+'/commits/HEAD'}];
  const history = await db.sql('select count(*) as n from public.activity_log');
  await db.asVisitor(q => q('select public.store_code_updates($1,$2::jsonb)', [NIGHTLY_TOKEN,JSON.stringify(dates)]));
  let [row] = await db.sql('select * from public.addons');
  assert.equal(row.repo_url,b); assert.equal(row.code_update.url,b+'/commits/HEAD');
  assert.deepEqual(await db.sql('select count(*) as n from public.activity_log'),history);
  await db.as(admin,q=>q('select public.pin_addon_link($1,$2)',[a.id,a.repo_url]));
  [row] = await db.sql('select * from public.addons');
  assert.equal(row.repo_url,a.repo_url); assert.equal(new Date(row.code_update.date).getUTCFullYear(),2020);
  const [log] = await db.sql("select id from public.activity_log where action = 'addon.update' order by id desc limit 1");
  await db.as(admin,q=>q('select public.revert_addon($1)',[log.id]));
  [row] = await db.sql('select * from public.addons');
  assert.equal(row.pinned_link,null); assert.equal(row.repo_url,b);
 } finally { await db.close(); }
});

test('same-name imports are atomic link additions and name collisions can be separated by admins', async () => {
 const db = await createDb();
 try {
  const alice = await db.addUser('alice'), admin = await db.addUser('admin','admin');
  const a = await post(db,alice,addon('Atlas'));
  const url='https://github.com/fork/Atlas';
  await db.queueImports([{name:'ATLAS',url,description:'Replacement content',category:'Miscellaneous'}]);
  const [q]=await db.sql('select id from public.import_queue');
  await db.as(admin,sql=>sql('select public.publish_import($1)',[q.id]));
  assert.equal((await db.sql('select count(*) as n from public.addons'))[0].n,1);
  assert.equal((await db.sql('select description from public.addons'))[0].description,a.description);
  const [shared]=await db.sql('select * from public.addons');
  await db.as(admin,sql=>sql('select public.unapprove_import($1)',[a.id]));
  assert.deepEqual((await db.sql('select versions from public.addons'))[0].versions.map(v=>v.url),[a.repo_url]);
  await db.as(admin,sql=>sql('select public.publish_import($1)',[q.id]));
  await assert.rejects(()=>db.as(alice,sql=>sql('select public.split_addon_link($1,$2,$3::jsonb)',[a.id,url,JSON.stringify({name:'Atlas',category:'Miscellaneous'})])),/Only admins/);
  await db.as(admin,sql=>sql('select public.split_addon_link($1,$2,$3::jsonb)',[a.id,url,JSON.stringify({name:'Atlas',category:'Miscellaneous'})]));
  assert.equal((await db.sql('select count(*) as n from public.addons'))[0].n,2);
  assert.equal((await db.sql('select * from public.addons where separate_name'))[0].repo_url,url);
 } finally { await db.close(); }
});
