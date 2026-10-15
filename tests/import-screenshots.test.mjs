import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addon, createDb, post } from './db.mjs';

const shot = n => `https://i.imgur.com/shot${n}.png`;
async function scene(work) {
 const db = await createDb();
 try {
  const admin = await db.addUser('admin', 'admin'), member = await db.addUser('member');
  const call = (sql, params=[]) => db.as(admin, q => q(sql,params));
  const queue = async (name, images) => (await db.sql(
   'insert into public.import_queue(key,url,name,images,category) values(public.link_key($1),$1,$2,$3,$4) returning id',
   [`https://gitlab.com/fork/${name.replace(/\s+/g,'-')}`,name,images,'Combat']
  ))[0].id;
  const current = async id => (await db.sql('select * from public.addons where id=$1',[id]))[0];
  await work({db,admin,member,call,queue,current});
 } finally { await db.close(); }
}

for (const existing of [[],[shot(1),shot(2),shot(3),shot(4),shot(5)],Array.from({length:6},(_,i)=>shot(i+1))]) {
 test(`same-name import preserves ${existing.length} existing pictures and fills only available slots`, () => scene(async ({db,admin,call,queue,current}) => {
  const a=await post(db,admin,addon('Atlas',undefined,{images:existing}));
  const id=await queue('Atlas',[shot(1),shot(7),shot(7),shot(8)]);
  await call('select public.approve_imports($1)',[[id]]);
  const after=await current(a.id);
  assert.deepEqual(after.images,[...new Set([...existing,shot(1),shot(7),shot(8)])].slice(0,6));
  assert.equal(after.description,a.description);assert.equal(after.category,a.category);assert.equal(after.author,a.author);
  assert.equal(after.versions.length,2);
  assert.equal((await db.sql('select status from public.import_queue where id=$1',[id]))[0].status,'approved');
 }));
}

test('edited approval adds only retained pictures and supports an explicit destination', () => scene(async ({db,admin,call,queue,current}) => {
 const a=await post(db,admin,addon('Atlas',undefined,{images:[shot(1)]}));
 const id=await queue('Different title',[shot(2),shot(3)]);
 await call('select public.publish_import($1,$2::jsonb,$3)',[id,JSON.stringify({name:'Different title',images:[shot(3)]}),a.id]);
 assert.deepEqual((await current(a.id)).images,[shot(1),shot(3)]);
 const next=await queue('Another title',[shot(4)]);
 await call('select public.approve_into($1,$2)',[next,a.id]);
 assert.deepEqual((await current(a.id)).images,[shot(1),shot(3),shot(4)]);
 const empty=await queue('Empty selection',[shot(5)]);
 await call('select public.publish_import($1,$2::jsonb,$3)',[empty,JSON.stringify({name:'Empty selection',images:[]}),a.id]);
 assert.deepEqual((await current(a.id)).images,[shot(1),shot(3),shot(4)]);
}));

test('six screenshots are accepted for new imports and edit proposals; seven are rejected', () => scene(async ({db,admin,member,call,queue,current}) => {
 const images=Array.from({length:6},(_,i)=>shot(i));
 const id=await queue('New import',images);
 await call('select public.approve_imports($1)',[[id]]);
 const [q]=await db.sql('select addon_id from public.import_queue where id=$1',[id]);
 assert.deepEqual((await current(q.addon_id)).images,images);
 const a=await post(db,member,addon('Atlas'));
 await call('select public.submit_addon($1::jsonb)',[JSON.stringify({name:'Atlas',versions:[{url:'https://gitlab.com/fork/Atlas'}]})]);
 const base=await current(a.id);
 await db.as(member,q=>q('select public.propose_addon_edit($1,$2::jsonb,$3::jsonb)',[a.id,JSON.stringify({images}),JSON.stringify(base)]));
 await assert.rejects(()=>db.as(member,q=>q('select public.propose_addon_edit($1,$2::jsonb,$3::jsonb)',[a.id,JSON.stringify({images:[...images,shot(7)]}),JSON.stringify(base)])),/Invalid screenshot/);
 await assert.rejects(()=>call('update public.addons set images=$1 where id=$2',[[...images,shot(7)],a.id]),/images_check/);
}));
