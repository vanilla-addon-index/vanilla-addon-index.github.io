import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createDb} from '../helpers/db.mjs';

test('admins and the site owner can submit without account ownership while ordinary submissions stay owned', async()=>{
 const db=await createDb();
 try {
  const admin=await db.addUser('admin','admin'), owner=await db.addUser('owner','owner'), member=await db.addUser('member');
  const input=(name,extra={})=>({name,description:'A useful addon with enough description.',category:'Combat',versions:[{url:`https://gitlab.com/example/${name.replaceAll(' ','-')}`}],...extra});
  const submit=async(user,draft)=>(await db.as(user,q=>q('select public.submit_addon($1::jsonb) as id',[JSON.stringify(draft)])))[0].id;
  for(const user of [admin,owner]) {
   const name=`Community ${user.username}`;
   const id=await submit(user,input(name,{without_owner:true}));
   const [a]=await db.sql('select * from public.addons where id=$1',[id]);
   assert.equal(a.owner,null);assert.equal(a.approved_by,null);assert.equal(a.source,'');assert.equal(a.shared,false);
   assert.equal((await db.sql("select actor from public.activity_log where addon_id=$1 and action='addon.create'",[id]))[0].actor,user.id);
   assert.equal((await db.as(user,q=>q('select id from public.addons where owner=$1 and id=$2',[user.id,id]))).length,0);
   assert.equal((await db.asVisitor(q=>q('select id from public.addons where id=$1',[id]))).length,1);
   assert.equal((await db.as(member,q=>q("update public.addons set author='Changed' where id=$1 returning id",[id]))).length,0);
   await db.as(admin,q=>q("update public.addons set author='Maintained by staff' where id=$1",[id]));
   await db.as(admin,q=>q('delete from public.addons where id=$1',[id]));
   const [trash]=await db.sql('select id from public.addon_trash where name=$1',[name]);
   await db.as(admin,q=>q('select public.restore_addon($1)',[trash.id]));
   assert.equal((await db.sql('select owner from public.addons where id=$1',[id]))[0].owner,null);
   const ownId=await submit(user,input(`Personal ${user.username}`));
   assert.equal((await db.sql('select owner from public.addons where id=$1',[ownId]))[0].owner,user.id);
  }
  await assert.rejects(()=>submit(member,input('Not allowed',{without_owner:true})),/Only admins/);
  for(const flag of ['true',null,{},1]) await assert.rejects(()=>submit(admin,input('Invalid option',{without_owner:flag})),/Invalid submission ownership/);
  const normalId=await submit(member,input('Member default',{without_owner:false}));
  assert.equal((await db.sql('select owner from public.addons where id=$1',[normalId]))[0].owner,member.id);
  await db.raw(`update public.profiles set banned=true where id='${admin.id}'`);
  await assert.rejects(()=>submit(admin,input('Banned submission',{without_owner:true})),/cannot submit/);
 } finally {await db.close();}
});
