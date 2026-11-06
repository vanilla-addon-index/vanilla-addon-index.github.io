import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDb, addon, post, approveLinkSuggestions } from '../helpers/db.mjs';

test('entry type defaults, public reads, reclassification, history recovery and trash restoration', async () => {
 const db = await createDb();
 try {
  const admin = await db.addUser('admin', 'admin');
  const member = await db.addUser('member');
  const regular = await post(db, member, addon('Regular'));
  assert.equal(regular.entry_type, 'addon');
  const input = {name:'ClientExtension', description:'A client modification with its own installation steps.', entry_type:'dll', category:'Miscellaneous', author:'', versions:[{url:'https://github.com/example/client',note:''}], images:[]};
  const [{id}] = await db.as(admin, q => q('select public.submit_addon($1::jsonb) as id', [JSON.stringify(input)]));
  const current = async () => (await db.sql('select * from public.addons where id=$1',[id]))[0];
  assert.equal((await db.asVisitor(q => q('select entry_type from public.addons where id=$1',[id])))[0].entry_type,'dll');
  await db.as(admin,q => q("update public.addons set entry_type='addon' where id=$1",[id]));
  const [log] = await db.sql("select id from public.activity_log where addon_id=$1 and action='addon.update' order by id desc limit 1",[id]);
  await db.as(admin,q => q('select public.recover_edit($1)',[log.id]));
  assert.equal((await current()).entry_type,'dll');
  await db.as(admin,q => q('delete from public.addons where id=$1',[id]));
  const [trash] = await db.sql("select id from public.addon_trash where name='ClientExtension'");
  await db.as(admin,q => q('select public.restore_addon($1)',[trash.id]));
  assert.equal((await current()).entry_type,'dll');
  await assert.rejects(() => db.as(admin,q => q("update public.addons set entry_type='invalid' where id=$1",[id])), /check constraint/);
  // Contributors can edit content, but collection changes are staff-only.
  await db.as(member,q => q('select public.submit_addon($1::jsonb)',[JSON.stringify({name:input.name,versions:[{url:'https://gitlab.com/member/client'}]})]));
  await approveLinkSuggestions(db,admin);
  const base = await current();
  await assert.rejects(() => db.as(member,q => q('select public.propose_addon_edit($1,$2::jsonb,$3::jsonb)',[id,JSON.stringify({entry_type:'addon'}),JSON.stringify(base)])), /Only admins/);
  const [request] = await db.as(member,q => q('select public.propose_addon_edit($1,$2::jsonb,$3::jsonb) as id',[id,JSON.stringify({description:'A revised description for this client extension.',entry_type:'dll'}),JSON.stringify(base)]));
  await db.as(admin,q => q('select public.decide_addon_edit($1,true)',[request.id]));
  assert.equal((await current()).entry_type,'dll');
 } finally { await db.close(); }
});

test('import approval retains the reviewed type and separation inherits it', async () => {
 const db = await createDb();
 try {
  const admin = await db.addUser('admin','admin');
  await db.queueImports([{name:'ImportedClient',url:'https://github.com/example/imported',description:'A client extension.',category:'Miscellaneous',images:[]}]);
  const [queued] = await db.sql('select id from public.import_queue');
  const [{id}] = await db.as(admin,q => q('select public.publish_import($1,$2::jsonb) as id',[queued.id,JSON.stringify({name:'ImportedClient',description:'A reviewed client extension.',category:'Miscellaneous',entry_type:'dll',images:[]})]));
  assert.equal((await db.sql('select entry_type from public.addons where id=$1',[id]))[0].entry_type,'dll');
  assert.equal((await db.sql('select entry_type from public.import_queue where id=$1',[queued.id]))[0].entry_type,'dll');
  await db.as(admin,q => q('select public.request_addon_link($1,$2)',[id,'https://gitlab.com/example/imported']));
  const [split] = await db.as(admin,q => q('select public.split_addon_link($1,$2,$3) as id',[id,'https://gitlab.com/example/imported','SeparateClient']));
  assert.equal((await db.sql('select entry_type from public.addons where id=$1',[split.id]))[0].entry_type,'dll');
 } finally { await db.close(); }
});



test('only admins and the site owner may publish DLL mods or reclassify entries', async () => {
 const db=await createDb();
 try {
  const member=await db.addUser('member'), admin=await db.addUser('admin','admin'), owner=await db.addUser('owner','owner');
  const regular=await post(db,member,addon('RegularMember'));
  await assert.rejects(()=>post(db,member,addon('DirectDLL',undefined,{entry_type:'dll'})), /Only admins/);
  await assert.rejects(()=>db.as(member,q=>q("update public.addons set entry_type='dll' where id=$1",[regular.id])), /Only admins/);
  const input={name:'MemberDLL',description:'A client extension.',category:'Libraries',entry_type:'dll',versions:[{url:'https://github.com/example/memberdll'}],images:[]};
  await assert.rejects(()=>db.as(member,q=>q('select public.submit_addon($1::jsonb)',[JSON.stringify(input)])), /Only admins/);
  for (const [staff,name] of [[admin,'AdminDLL'],[owner,'OwnerDLL']]) {
   const [{id}]=await db.as(staff,q=>q('select public.submit_addon($1::jsonb) as id',[JSON.stringify({...input,name,versions:[{url:`https://github.com/example/${name}`} ]})]));
   assert.equal((await db.sql('select entry_type from public.addons where id=$1',[id]))[0].entry_type,'dll');
   await db.as(staff,q=>q("update public.addons set entry_type='addon' where id=$1",[id]));
  }
  await db.as(member,q=>q("update public.addons set description='An ordinary member edit remains allowed.' where id=$1",[regular.id]));
 } finally {await db.close();}
});
