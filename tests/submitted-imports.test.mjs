import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { addon, createDb, post } from './db.mjs';

async function scene(work) {
 const db = await createDb();
 try {
  const alice = await db.addUser('alice'), bob = await db.addUser('bobby'), admin = await db.addUser('admin', 'admin');
  const call = (user, sql, params = []) => db.as(user, q => q(sql, params));
  const queue = async (url, name = 'Wiki title', status = 'pending') => (await db.sql(
   'insert into public.import_queue(key,url,name,status,problem) values(public.link_key($1),$1,$2,$3,$4) returning *',
   [url, name, status, 'Previous approval failed']
  ))[0];
  const current = async id => (await db.sql('select * from public.import_queue where id=$1', [id]))[0];
  await work({db,alice,bob,admin,call,queue,current});
 } finally { await db.close(); }
}

test('member submission resolves a normalized queued link without changing submitted details or ownership', () => scene(async ({db,alice,admin,call,queue,current}) => {
 const q = await queue('https://github.com/someone/Atlas.git/');
 const untouched = await queue('https://github.com/someone/Other');
 const a = await post(db, alice, addon('My Atlas', 'https://github.com/someone/Atlas'));
 const resolved = await current(q.id);
 assert.equal(resolved.status,'submitted'); assert.equal(resolved.addon_id,a.id);
 assert.equal(resolved.decided_by,alice.id); assert.ok(resolved.decided_at); assert.equal(resolved.problem,null);
 assert.equal(a.name,'My Atlas'); assert.equal(a.owner,alice.id); assert.equal(a.source,''); assert.equal(a.approved_by,null);
 assert.equal((await current(untouched.id)).status,'pending');
 assert.equal((await db.sql("select * from public.activity_log where action='import.submitted' and addon_id=$1",[a.id])).length,1);
 await assert.rejects(() => call(admin,'select public.unapprove_import($1)',[a.id]),/did not come from/);
 assert.equal((await db.sql('select id from public.addons where id=$1',[a.id])).length,1);
}));

test('links added to shared pages resolve imports; rejected decisions and failed writes stay unchanged', () => scene(async ({db,alice,bob,admin,call,queue,current}) => {
 const a = await post(db,alice,addon('Atlas'));
 const url='https://gitlab.com/bob/Atlas';
 const q=await queue(url);
 await call(bob,'select public.submit_addon($1::jsonb)',[JSON.stringify({name:'Atlas',versions:[{url}]})]);
 assert.equal((await current(q.id)).status,'submitted'); assert.equal((await current(q.id)).addon_id,a.id);
 assert.equal((await current(q.id)).decided_by,bob.id);
 const rejected=await queue('https://github.com/someone/Rejected','Rejected','rejected');
 await post(db,bob,addon('Rejected'));
 assert.equal((await current(rejected.id)).status,'rejected');
 const failed=await queue('https://github.com/someone/Failed');
 await assert.rejects(() => post(db,alice,addon('Failed',failed.url,{description:'x'})));
 assert.equal((await current(failed.id)).status,'pending');
 await assert.rejects(() => call(alice,"update public.import_queue set status='submitted' where id=$1",[failed.id]));
 const approved=await queue('https://github.com/someone/Imported','Imported');
 await call(admin,'select public.approve_imports($1)',[[approved.id]]);
 assert.equal((await current(approved.id)).status,'approved');
 // Resolving a shared link does not overwrite the original page description.
 assert.equal((await db.sql('select description from public.addons where id=$1',[a.id]))[0].description,a.description);
}));

test('migration reconciles existing pending matches without inventing attribution', () => scene(async ({db,alice,queue,current}) => {
 await db.raw('drop trigger addons_resolve_submitted_imports on public.addons; drop function public.resolve_submitted_imports();');
 const q=await queue('https://github.com/someone/Atlas');
 const rejected=await queue('https://github.com/someone/Rejected','Rejected','rejected');
 const a=await post(db,alice,addon('Atlas'));
 await post(db,alice,addon('Rejected'));
 await db.raw(readFileSync(new URL('../supabase/migrations/20261015000005_submitted_imports.sql',import.meta.url),'utf8'));
 const resolved=await current(q.id);
 assert.equal(resolved.status,'submitted'); assert.equal(resolved.addon_id,a.id); assert.equal(resolved.decided_by,null);
 assert.equal((await current(rejected.id)).status,'rejected');
}));
