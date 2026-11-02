import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createDb, approveLinkSuggestions} from '../helpers/db.mjs';
test('only admins curate similar addons; normal edits preserve them and recovery restores them', async()=>{
 const db=await createDb();
 try {
  const member=await db.addUser('member'), admin=await db.addUser('admin','admin'), owner=await db.addUser('owner','owner');
  const input={name:'SimpleAuras',description:'Tracks buffs and debuffs on screen.',category:'Buffs & Debuffs',author:'',versions:[{url:'https://github.com/example/simple',note:''}],images:[],similar_addons:' MPOWA, WeakAuras, MPOWA '};
  await assert.rejects(()=>db.as(member,q=>q('select public.submit_addon($1::jsonb)',[JSON.stringify(input)])),/Only admins/);
  const [created]=await db.as(admin,q=>q('select public.submit_addon($1::jsonb) as id',[JSON.stringify(input)]));
  const id=created.id;
  const current=async()=> (await db.sql('select * from public.addons where id=$1',[id]))[0];
  assert.equal((await current()).similar_addons,'MPOWA, WeakAuras');
  assert.equal((await db.asVisitor(q=>q('select similar_addons from public.addons where id=$1',[id])))[0].similar_addons,'MPOWA, WeakAuras');
  await db.as(member,q=>q('select public.submit_addon($1::jsonb)',[JSON.stringify({name:'SimpleAuras',versions:[{url:'https://gitlab.com/member/simple'}]})]));
  await approveLinkSuggestions(db,admin);
  const base=await current();
  await assert.rejects(()=>db.as(member,q=>q('select public.propose_addon_edit($1,$2::jsonb,$3::jsonb)',[id,JSON.stringify({similar_addons:'Outfitter'}),JSON.stringify(base)])),/Only admins/);
  const [proposal]=await db.as(member,q=>q('select public.propose_addon_edit($1,$2::jsonb,$3::jsonb) as id',[id,JSON.stringify({description:'A revised description for the aura tracker.'}),JSON.stringify(base)]));
  await db.as(admin,q=>q('select public.decide_addon_edit($1,true)',[proposal.id]));
  assert.equal((await current()).similar_addons,'MPOWA, WeakAuras');
  await db.as(owner,q=>q("update public.addons set similar_addons='Outfitter' where id=$1",[id]));
  const [log]=await db.sql("select id from public.activity_log where addon_id=$1 and action='addon.update' order by id desc limit 1",[id]);
  await db.as(admin,q=>q('select public.revert_addon($1)',[log.id]));
  assert.equal((await current()).similar_addons,'MPOWA, WeakAuras');
  await db.as(admin,q=>q('delete from public.addons where id=$1',[id]));
  const [trash]=await db.sql('select id from public.addon_trash where name=$1',['SimpleAuras']);
  await db.as(admin,q=>q('select public.restore_addon($1)',[trash.id]));
  assert.equal((await current()).similar_addons,'MPOWA, WeakAuras');
  await assert.rejects(()=>db.as(admin,q=>q('update public.addons set similar_addons=$1 where id=$2',['x'.repeat(501),id])));
  const [own]=await db.as(member,q=>q('select public.submit_addon($1::jsonb) as id',[JSON.stringify({...input,name:'Member Auras',similar_addons:'',versions:[{url:'https://github.com/member/auras'}]})]));
  await assert.rejects(()=>db.as(member,q=>q("update public.addons set similar_addons='WeakAuras' where id=$1",[own.id])),/Only admins/);
  await db.as(member,q=>q("update public.addons set description='A normal description update from the owner.' where id=$1",[own.id]));
 } finally {await db.close();}
});
