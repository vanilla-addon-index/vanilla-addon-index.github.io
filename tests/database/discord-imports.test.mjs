import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, post, addon } from '../helpers/db.mjs';

test('only owner can import Discord candidates; admins review them and repeat uploads preserve decisions', async () => {
 const db = await createDb();
 try {
  const owner = await db.addUser('owner','owner');
  const admin = await db.addUser('admin','admin');
  const member = await db.addUser('member');
  const items = [{url:'https://github.com/a/new/releases/latest',name:'New',description:'Opening description'}];
  const queue = (q, entries = items) => q('select public.queue_discord_imports($1::jsonb) as result',[JSON.stringify(entries)]);
  for (const user of [admin,member]) await assert.rejects(db.as(user,queue),/Only the owner/);
  await assert.rejects(db.asVisitor(queue),/permission denied/);
  assert.equal((await db.as(owner,queue))[0].result.added,1);
  assert.equal((await db.as(owner,queue))[0].result.skipped,1);
  const [row] = await db.sql('select * from public.import_queue');
  assert.equal(row.source,'Discord');
  assert.equal(row.category,'');
  assert.deepEqual(await db.sql('select * from public.addons'),[]);
  await db.as(admin,q => q("select public.decide_imports($1,'rejected')",[[row.id]]));
  assert.equal((await db.as(owner,queue))[0].result.skipped,1);
  assert.equal((await db.sql('select status from public.import_queue'))[0].status,'rejected');
  await post(db,owner,addon('Live','https://github.com/a/live'));
  const live = [{url:'https://github.com/a/live/releases/latest/download/live.zip',name:'Live'}];
  assert.equal((await db.as(owner,q => queue(q,live)))[0].result.added,0);
  await db.sql("insert into public.repo_stats(key,canonical) values ('github.com/a/oldlive','github.com/a/live')");
  assert.equal((await db.as(owner,q => queue(q,[{url:'https://github.com/a/oldlive',name:'OldLive'}])))[0].result.added,0);
  const next = [{url:'https://codeberg.org/a/Reviewable',name:'Reviewable',description:'A useful addon description.'}];
  await db.as(owner,q => queue(q,next));
  const [pending] = await db.sql("select id from public.import_queue where status='pending'");
  await db.as(admin,q => q('select public.publish_import($1,$2::jsonb)',[pending.id,JSON.stringify({name:'Reviewable',description:'A useful addon description.',category:'Combat'})]));
  assert.equal((await db.sql("select source from public.addons where name='Reviewable'"))[0].source,'Discord');
  await assert.rejects(db.as(owner,q => queue(q,[{url:'https://evil.example/a/b',name:'Bad'}])),/Invalid repository/);
 } finally { await db.close(); }
});

test('owner can clear and reimport pending Discord entries without losing decisions or other sources', async () => {
 const db = await createDb();
 try {
  const owner = await db.addUser('owner','owner');
  const admin = await db.addUser('admin','admin');
  const member = await db.addUser('member');
  const clear = q => q('select public.clear_pending_discord_imports() as removed');
  for (const user of [admin,member]) await assert.rejects(db.as(user,clear),/Only the owner/);
  await assert.rejects(db.asVisitor(clear),/permission denied/);
  for (const [name,source,status] of [['Pending','Discord','pending'],['Rejected','Discord','rejected'],['Approved','Discord','approved'],['Wiki','Turtle WoW Wiki','pending'],['Octo','OctoWoW','pending']]) {
   await db.sql('insert into public.import_queue(key,url,name,source,status) values($1,$2,$3,$4,$5)',[`github.com/a/${name.toLowerCase()}`,`https://github.com/a/${name}`,name,source,status]);
  }
  assert.equal((await db.as(owner,clear))[0].removed,1);
  assert.equal((await db.sql('select count(*)::int as n from public.import_queue'))[0].n,4);
  const items = [{url:'https://github.com/a/Pending',name:'Pending'}];
  const [result] = await db.as(owner,q=>q('select public.queue_discord_imports($1::jsonb) as result',[JSON.stringify(items)]));
  assert.equal(result.result.added,1);
 } finally { await db.close(); }
});
