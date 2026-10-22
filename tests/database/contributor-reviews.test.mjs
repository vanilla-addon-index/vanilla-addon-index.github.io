import assert from 'node:assert/strict';
import {test} from 'node:test';
import {addon, createDb, approveLinkSuggestions, post} from '../helpers/db.mjs';

async function scene(work) {
 const db=await createDb();
 try {
  const alice=await db.addUser('alice'), bob=await db.addUser('bobby'), other=await db.addUser('other'), admin=await db.addUser('admin','admin');
  const a=await post(db,alice,addon('Atlas'));
  const url='https://gitlab.com/bob/Atlas';
  const call=(user,sql,params=[])=>db.as(user,q=>q(sql,params));
  await call(bob,'select public.submit_addon($1::jsonb)',[JSON.stringify({name:'Atlas',versions:[{url}]})]);
 await approveLinkSuggestions(db, admin);
  const current=async()=> (await db.sql('select * from public.addons where id=$1',[a.id]))[0];
  const propose=async(user,changes,base)=>(await call(user,'select public.propose_addon_edit($1,$2::jsonb,$3::jsonb) as id',[a.id,JSON.stringify(changes),JSON.stringify(base??await current())]))[0].id;
  await work({db,alice,bob,other,admin,a,url,call,current,propose});
 } finally {await db.close();}
}

test('contributors remove only their own links; zero links and rollback retain shared status and participation',()=>scene(async({db,alice,bob,other,admin,a,url,call,current})=>{
 await call(admin,'select public.pin_addon_link($1,$2)',[a.id,url]);
 await assert.rejects(()=>call(other,'select public.remove_own_addon_link($1,$2)',[a.id,url]),/only remove your own/);
 await assert.rejects(()=>call(bob,'select public.remove_own_addon_link($1,$2)',[a.id,a.repo_url]),/only remove your own/);
 await call(bob,'select public.remove_own_addon_link($1,$2)',[a.id,url]);
 assert.equal((await current()).pinned_link,null);
 await call(alice,'select public.remove_own_addon_link($1,$2)',[a.id,a.repo_url]);
 const empty=await current();assert.deepEqual(empty.versions,[]);assert.equal(empty.shared,true);assert.equal(empty.owner,null);assert.equal(empty.code_update,null);
 for(const user of [alice,bob]) assert.equal((await call(user,'select public.addon_contribution_access($1) as access',[a.id]))[0].access.can_propose,true);
 assert.deepEqual(await call(alice,'update public.addons set author=$1 where id=$2 returning id',['Unreviewed',a.id]),[]);
 const [log]=await db.sql("select id from public.activity_log where action='addon.update' and actor=$1 order by id desc limit 1",[bob.id]);
 const later='https://gitlab.com/other/Atlas';
 await call(other,'select public.submit_addon($1::jsonb)',[JSON.stringify({name:'Atlas',versions:[{url:later}]})]);
 await approveLinkSuggestions(db, admin);
 await call(admin,'select public.revert_addon($1)',[log.id]);
 assert.equal((await current()).shared,true);assert.equal((await current()).owner,null);
 assert.deepEqual((await current()).versions.map(v=>v.url).sort(),[url,later].sort());
 assert.deepEqual((await call(bob,'select public.addon_contribution_access($1) as access',[a.id]))[0].access.links,[url]);
}));

test('malformed proposals are refused and reviewed new destinations belong to the proposer',()=>scene(async({alice,bob,admin,a,call,current,propose})=>{
 for(const input of [{images:[null]},{versions:[null]},{versions:[{url:12}]},{name:'x'.repeat(61)},{author:null}]) await assert.rejects(()=>propose(alice,input));
 const before=await current();
 const replacement='https://gitlab.com/alice/new-atlas';
 const versions=before.versions.map(v=>v.url===a.repo_url?{url:replacement,note:''}:v);
 const id=await propose(alice,{versions});
 await assert.rejects(()=>call(bob,'select public.withdraw_addon_edit($1)',[id]),/does not belong/);
 await call(admin,'select public.decide_addon_edit($1,true)',[id]);
 assert.deepEqual((await call(alice,'select public.addon_contribution_access($1) as access',[a.id]))[0].access.links,[replacement]);
 await call(alice,'select public.remove_own_addon_link($1,$2)',[a.id,replacement]);
 assert.equal((await current()).versions.length,1);assert.equal((await current()).shared,true);
}));

test('only contributors propose private edits; admins can accept selected fields without overwriting others',()=>scene(async({db,alice,bob,other,admin,a,call,current,propose})=>{
 const before=await current();
 await assert.rejects(()=>propose(other,{description:'Not a contributor, not allowed.'}),/Only contributors/);
 const id=await propose(alice,{description:'A better description proposed for review.',author:'Proposed author'});
 assert.equal((await current()).description,before.description);
 assert.equal((await db.asVisitor(q=>q('select public.nightly_waiting($1) as n',['the-nightly-token'])))[0].n.suggestions,1);
 assert.equal((await call(other,'select * from public.addon_edit_requests')).length,0);
 assert.equal((await call(bob,'select * from public.addon_edit_requests')).length,0);
 assert.equal((await call(alice,'select * from public.addon_edit_requests')).length,1);
 await assert.rejects(()=>call(alice,"update public.addon_edit_requests set status='accepted' where id=$1",[id]));
 await assert.rejects(()=>call(bob,'select public.decide_addon_edit($1,true)',[id]),/Only admins/);
 await call(admin,'select public.decide_addon_edit($1,true,$2)',[id,['description']]);
 assert.equal((await current()).description,'A better description proposed for review.');assert.equal((await current()).author,before.author);
 assert.equal((await current()).shared,true);
 const [log]=await db.sql("select id from public.activity_log where action='addon.update' and actor=$1 order by id desc limit 1",[admin.id]);
 await call(admin,'select public.revert_addon($1)',[log.id]);assert.equal((await current()).description,before.description);
}));

test('proposals can be revised or withdrawn; conflicts block acceptance of stale fields only',()=>scene(async({db,alice,admin,a,call,current,propose})=>{
 const id=await propose(alice,{author:'First proposal'});
 assert.equal(await propose(alice,{author:'Revised proposal',description:'A new proposed description.'}),id);
 await call(admin,"update public.addons set author='New admin author' where id=$1",[a.id]);
 await assert.rejects(()=>call(admin,'select public.decide_addon_edit($1,true)',[id]),/field changed/);
 assert.equal((await current()).description,'A description that is long enough.');
 await call(admin,'select public.decide_addon_edit($1,true,$2)',[id,['description']]);assert.equal((await current()).author,'New admin author');
 const withdrawn=await propose(alice,{author:'Another change'});await call(alice,'select public.withdraw_addon_edit($1)',[withdrawn]);
 assert.equal((await db.sql('select status from public.addon_edit_requests where id=$1',[withdrawn]))[0].status,'withdrawn');
 await assert.rejects(()=>call(admin,'select public.decide_addon_edit($1,true)',[withdrawn]),/no longer pending/);
}));

test('banning a contributor blocks proposals, removals and approval of their pending edit',()=>scene(async({alice,admin,a,url,call,propose})=>{
 const id=await propose(alice,{author:'Pending before ban'});
 await call(admin,'select public.set_banned($1,true)',[alice.id]);
 await assert.rejects(()=>propose(alice,{author:'Still banned'}),/Only contributors/);
 await assert.rejects(()=>call(alice,'select public.remove_own_addon_link($1,$2)',[a.id,a.repo_url]),/cannot remove/);
 await assert.rejects(()=>call(admin,'select public.decide_addon_edit($1,true)',[id]),/banned/);
 await call(admin,'select public.decide_addon_edit($1,false)',[id]);
}));

test('restoring a shared page restores contributor access and ownership of submitted links',()=>scene(async({db,alice,bob,admin,a,url,call,current})=>{
 await call(admin,'delete from public.addons where id=$1',[a.id]);
 const [trash]=await db.sql('select id from public.addon_trash where name=$1',['Atlas']);
 await call(admin,'select public.restore_addon($1)',[trash.id]);
 for(const user of [alice,bob]) assert.equal((await call(user,'select public.addon_contribution_access($1) as access',[a.id]))[0].access.can_propose,true);
 assert.deepEqual((await call(bob,'select public.addon_contribution_access($1) as access',[a.id]))[0].access.links,[url]);
 await call(bob,'select public.remove_own_addon_link($1,$2)',[a.id,url]);
 await call(alice,'select public.remove_own_addon_link($1,$2)',[a.id,a.repo_url]);
 await call(admin,'delete from public.addons where id=$1',[a.id]);
 const [emptyTrash]=await db.sql('select id from public.addon_trash where name=$1',['Atlas']);
 await call(admin,'select public.restore_addon($1)',[emptyTrash.id]);
 assert.equal((await current()).shared,true);assert.deepEqual((await current()).versions,[]);
 assert.equal((await call(alice,'select public.addon_contribution_access($1) as access',[a.id]))[0].access.can_propose,true);
}));
