import assert from 'node:assert/strict';
import {test} from 'node:test';
import {addon, createDb, approveLinkSuggestions, post, NIGHTLY_TOKEN} from '../helpers/db.mjs';

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
  await assert.rejects(()=>db.as(admin,q=>q('select public.restore_addon($1)',[trash.id])),/already exists/);
  assert.equal((await db.sql('select count(*) as n from public.addons'))[0].n,1);
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
  await approveLinkSuggestions(db, admin);
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
 await approveLinkSuggestions(db, admin);
  const dates = [{url:a.repo_url,date:'2020-01-01T00:00:00Z',history_url:a.repo_url+'/commits/HEAD'},{url:b,date:'2026-01-01T00:00:00Z',history_url:b+'/commits/HEAD'}];
  const history = await db.sql('select count(*) as n from public.activity_log');
  await db.asVisitor(q => q('select public.store_code_updates($1,$2::jsonb)', [NIGHTLY_TOKEN,JSON.stringify(dates)]));
  let [row] = await db.sql('select * from public.addons');
  assert.equal(row.repo_url,b); assert.equal(row.code_update.url,b+'/commits/HEAD');
  assert.equal(new Date(row.link_code_updates[a.repo_url].date).getUTCFullYear(),2020);
  assert.equal(new Date(row.link_code_updates[b].date).getUTCFullYear(),2026);
  const [publicRow] = await db.asVisitor(q=>q('select link_code_updates from public.addons where id = $1',[a.id]));
  assert.deepEqual(publicRow.link_code_updates,row.link_code_updates);
  await assert.rejects(()=>db.as(admin,q=>q("update public.addons set link_code_updates = '{\"forged\":{}}' where id = $1",[a.id])),/permission denied/);
  assert.deepEqual((await db.sql('select link_code_updates from public.addons where id = $1',[a.id]))[0].link_code_updates,row.link_code_updates);
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
  await assert.rejects(()=>db.as(alice,sql=>sql('select public.split_addon_link($1,$2)',[a.id,url])),/Only admins/);
  await assert.rejects(()=>db.as(admin,sql=>sql('select public.split_addon_link($1,$2)',[a.id,url])),/Choose a different name/);
  assert.equal((await db.sql('select versions from public.addons where id=$1',[a.id]))[0].versions.length,2);
  await assert.rejects(()=>db.as(admin,sql=>sql('select public.split_addon_link($1,$2,$3)',[a.id,url,'a-t-l-a-s'])),/Choose a different name/);
  await db.as(admin,sql=>sql('select public.split_addon_link($1,$2,$3)',[a.id,url,'Atlas Fork']));
  assert.equal((await db.sql('select count(*) as n from public.addons'))[0].n,2);
  const [separated] = await db.sql("select * from public.addons where name = 'Atlas Fork'");
  assert.equal(separated.repo_url,url);
  assert.equal(separated.author,'fork');
  assert.equal(separated.description,'Replacement content');
  assert.equal(separated.name,'Atlas Fork');
  assert.equal(separated.separate_name,false);
  assert.equal((await db.sql('select addon_id from public.import_queue where id = $1',[q.id]))[0].addon_id,separated.id);
  await assert.rejects(()=>db.as(admin,sql=>sql('select public.split_addon_link($1,$2)',[a.id,url])),/no longer exists/);
 } finally { await db.close(); }
});

test('immediate separation does not inherit unrelated content and retains contribution access', async () => {
 const db=await createDb();
 try {
  const alice=await db.addUser('alice'), admin=await db.addUser('admin','admin');
  const a=await post(db,alice,{...addon('Atlas'),author:'Wrong author'});
  const url='https://octowow.st/git/lightblade/Atlas';
  await db.as(admin,q=>q('select public.request_addon_link($1,$2)',[a.id,url]));
  await db.sql('update public.addon_link_contributions set submitted_by=$1 where url=$2',[alice.id,url]);
  const [result]=await db.as(admin,q=>q('select public.split_addon_link($1,$2,$3) as id',[a.id,url,'Atlas Lightblade']));
  const [row]=await db.sql('select * from public.addons where id=$1',[result.id]);
  assert.equal(row.author,'lightblade'); assert.equal(row.description,'');
  assert.deepEqual(row.images,[]); assert.equal(row.category,'Miscellaneous');
  assert.equal(row.name,'Atlas Lightblade');
  const [access]=await db.as(alice,q=>q('select public.addon_contribution_access($1) as access',[row.id]));
  assert.equal(access.access.can_propose,true); assert.deepEqual(access.access.links,[url]);
  await assert.rejects(()=>db.as(admin,q=>q('select public.split_addon_link($1,$2)',[row.id,url])),/only link/);
 } finally { await db.close(); }
});

test('upgrade regroups old same-name exceptions and preserves their addresses', async () => {
 const db=await createDb({beforeImmediateSeparation: async raw=>{
  await raw.exec(`insert into public.addons(name, description, category, versions, separate_name, shared) values
   ('Atlas', 'Canonical description', 'Miscellaneous', '[{"url":"https://github.com/original/Atlas","note":""}]',false,true),
   ('A-TLAS', 'Other description', 'Miscellaneous', '[{"url":"https://github.com/fork/Atlas","note":""}]',true,true);`);
 }});
 try {
  const rows=await db.sql('select * from public.addons');
  assert.equal(rows.length,1); assert.equal(rows[0].versions.length,2);
  assert.equal(rows[0].description,'Canonical description');
  assert.ok(rows[0].aliases.includes('a-tlas')); assert.equal(rows[0].separate_name,false);
 } finally {await db.close();}
});
