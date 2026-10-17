import assert from 'node:assert/strict';
import {afterEach, beforeEach, test} from 'node:test';
import {readFileSync} from 'node:fs';
import {NIGHTLY_TOKEN, addon, post} from '../helpers/db.mjs';
import {createRulesContext} from '../helpers/rules-context.mjs';

let db, alice, admin;
beforeEach(async()=>({db, alice, admin}=await createRulesContext()));
afterEach(()=>db.close());
const retire=(keys,token=NIGHTLY_TOKEN)=>db.asVisitor(q=>q('select public.retire_dead_links($1,$2::text[]) as result',[token,keys]));
const check=(key,missing=true)=>db.asVisitor(q=>q('select public.store_repo_stats($1,$2::jsonb)',[NIGHTLY_TOKEN,JSON.stringify([{key,missing}])]));

test('nightly files dead imports separately from genuine rejections and is idempotent',async()=>{
 await db.queueImports(['Gone','Rejected','Waiting'].map(name=>({name,url:`https://github.com/a/${name}`})));
 await db.sql("update public.import_queue set status='rejected' where name='Rejected'");
 await check('github.com/a/gone');
 await retire(['github.com/a/gone']);
 assert.deepEqual(await db.sql('select name,status from public.import_queue order by name'),[
  {name:'Gone',status:'dead'},{name:'Rejected',status:'rejected'},{name:'Waiting',status:'pending'}]);
 assert.equal((await retire(['github.com/a/gone']))[0].result.queued,0);
 await db.queueImports([{name:'Gone',url:'https://github.com/a/Gone'}]);
 assert.equal((await db.sql("select count(*)::int as n from public.import_queue where status='dead'"))[0].n,1);
});

test('nightly removes only the dead version and retains its snapshot',async()=>{
 const live=await post(db,alice,addon('Multi','https://github.com/a/gone'));
 await db.sql("update public.addons set versions=versions || '[{\"url\":\"https://github.com/a/healthy\",\"note\":\"working\"}]'::jsonb where id=$1",[live.id]);
 await check('github.com/a/gone');
 const [{result}]=await retire(['github.com/a/gone']);
 assert.equal(result.links_removed,1);
 assert.equal(result.addons_removed,0);
 const [remaining]=await db.sql('select versions from public.addons where id=$1',[live.id]);
 assert.deepEqual(remaining.versions,[{url:'https://github.com/a/healthy',note:'working'}]);
 const [dead]=await db.sql("select status,dead_snapshot from public.import_queue where key='github.com/a/gone'");
 assert.equal(dead.status,'dead');
 assert.equal(dead.dead_snapshot.versions.length,2);
 assert.equal(dead.dead_snapshot.removed_link.url,'https://github.com/a/gone');
});

test('last dead link removes the page, preserves trash and files already-approved imports',async()=>{
 const live=await post(db,alice,addon('Gone','https://github.com/a/gone'));
 await db.sql("insert into public.import_queue(key,url,name,status,addon_id) values ('github.com/a/gone','https://github.com/a/gone','Gone','approved',$1)",[live.id]);
 await check('github.com/a/gone');
 assert.equal((await retire(['github.com/a/gone']))[0].result.addons_removed,1);
 assert.equal((await db.sql('select * from public.addons')).length,0);
 assert.equal((await db.sql('select * from public.addon_trash')).length,1);
 assert.equal((await db.sql('select status from public.import_queue'))[0].status,'dead');
 assert.equal((await retire(['github.com/a/gone']))[0].result.links_removed,0);
});

test('unanswered, stale, healthy and archived repositories stay live; nightly token is required',async()=>{
 await post(db,alice,addon('Keep','https://github.com/a/keep'));
 await check('github.com/a/keep');
 await retire([]);
 await db.sql("update public.repo_stats_checks set checked_at=now()-interval '2 hours'");
 await retire(['github.com/a/keep']);
 await check('github.com/a/keep',false);
 await db.sql('update public.repo_stats set archived=true');
 await retire(['github.com/a/keep']);
 assert.equal((await db.sql('select * from public.addons')).length,1);
 await assert.rejects(retire(['github.com/a/keep'],'wrong'),/Only the nightly job/);
 await assert.rejects(db.as(admin,q=>q('select public.retire_dead_links($1,$2::text[])',[NIGHTLY_TOKEN,[]])),/permission denied/);
});

test('migration separates previously rejected dead links without touching healthy rejections',async()=>{
 await db.queueImports([{name:'Gone',url:'https://github.com/a/gone'},{name:'Keep',url:'https://github.com/a/keep'}]);
 await db.sql("update public.import_queue set status='rejected'");
 await db.sql("insert into public.repo_stats(key,missing) values ('github.com/a/gone',true)");
 await db.raw('alter table public.import_queue drop column dead_snapshot; drop function public.retire_dead_links(text,text[]);');
 await db.raw(readFileSync(new URL('../../supabase/migrations/20261017000001_dead_links.sql',import.meta.url),'utf8'));
 assert.deepEqual(await db.sql('select name,status from public.import_queue order by name'),[{name:'Gone',status:'dead'},{name:'Keep',status:'rejected'}]);
});
