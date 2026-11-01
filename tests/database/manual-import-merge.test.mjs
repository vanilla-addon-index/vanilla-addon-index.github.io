import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDb,post,addon} from '../helpers/db.mjs';

test('manual import destination wins over name matching and preserves the selected page',async()=>{
 const db=await createDb();
 try {
  const admin=await db.addUser('admin','admin');
  const member=await db.addUser('member');
  const matching=await post(db,admin,addon('ObscurePort'));
  const target=await post(db,admin,addon('OriginalAddon','https://github.com/a/original',{author:'OriginalAuthor'}));
  await db.queueImports([{name:'ObscurePort',url:'https://github.com/a/obscure',description:'Port description'}]);
  const [queued]=await db.sql('select id from public.import_queue');
  const publish=q=>q('select public.publish_import($1,null,$2) as id',[queued.id,target.id]);
  await assert.rejects(db.as(member,publish),/Only admins/);
  assert.equal((await db.as(admin,publish))[0].id,target.id);
  const [saved]=await db.sql('select * from public.addons where id=$1',[target.id]);
  assert.equal(saved.name,target.name);
  assert.equal(saved.description,target.description);
  assert.equal(saved.category,target.category);
  assert.equal(saved.author,target.author);
  assert.equal(saved.versions.length,2);
  assert.equal((await db.sql('select versions from public.addons where id=$1',[matching.id]))[0].versions.length,1);
  const [decision]=await db.sql('select status,addon_id from public.import_queue where id=$1',[queued.id]);
  assert.equal(decision.status,'approved');
  assert.equal(decision.addon_id,target.id);
 } finally {await db.close();}
});
