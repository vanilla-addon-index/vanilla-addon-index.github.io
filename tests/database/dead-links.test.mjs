import assert from 'node:assert/strict';
import {afterEach, beforeEach, test} from 'node:test';
import {readFileSync} from 'node:fs';
import {NIGHTLY_TOKEN, addon, post} from '../helpers/db.mjs';
import {createRulesContext} from '../helpers/rules-context.mjs';

let db, alice, admin;
beforeEach(async()=>({db, alice, admin}=await createRulesContext()));
afterEach(()=>db.close());
const retire=(keys,token=NIGHTLY_TOKEN)=>db.asVisitor(q=>q('select public.retire_dead_links($1,$2::text[]) as result',[token,keys]));
const age=()=>db.sql("update public.repo_missing_since set since=now()-interval '14 days'");
const check=(key,missing=true)=>db.asVisitor(q=>q('select public.store_repo_stats($1,$2::jsonb)',[NIGHTLY_TOKEN,JSON.stringify([{key,missing}])]));

test('nightly files dead imports separately from genuine rejections and is idempotent',async()=>{
 await db.queueImports(['Gone','Rejected','Waiting'].map(name=>({name,url:`https://github.com/a/${name}`})));
 await db.sql("update public.import_queue set status='rejected' where name='Rejected'");
 await check('github.com/a/gone');
 await age();
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
 await age();
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
 await age();
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


test('missing links stay published and labelled for fourteen days; repeated checks do not restart the clock',async()=>{
 const live=await post(db,alice,addon('Grace','https://github.com/a/grace'));
 await check('github.com/a/grace');
 assert.deepEqual((await db.asVisitor(q=>q('select unavailable_links from public.addons')))[0].unavailable_links,['https://github.com/a/grace']);
 await assert.rejects(db.asVisitor(q=>q('select * from public.repo_missing_since')),/permission denied/);
 await assert.rejects(db.asVisitor(q=>q('select public.store_repo_stats_facts($1,$2::jsonb,true)',[NIGHTLY_TOKEN,'[]'])),/permission denied/);
 assert.equal((await retire(['github.com/a/grace']))[0].result.links_removed,0);
 await db.sql("update public.repo_missing_since set since=now()-interval '14 days'+interval '1 hour'");
 await check('github.com/a/grace');
 const [clock]=await db.sql('select since from public.repo_missing_since');
 await assert.rejects(db.as(alice,q=>q("update public.addons set unavailable_links='{}' where id=$1",[live.id])),/permission denied/);
 await db.as(alice,q=>q("update public.addons set description='An ordinary description edit during the grace period.' where id=$1",[live.id]));
 assert.deepEqual((await db.sql('select since from public.repo_missing_since'))[0],clock);
 assert.deepEqual((await db.sql('select unavailable_links from public.addons'))[0].unavailable_links,['https://github.com/a/grace']);
 assert.equal((await retire(['github.com/a/grace']))[0].result.links_removed,0);
 await age();
 await check('github.com/a/grace');
 assert.equal((await retire(['github.com/a/grace']))[0].result.addons_removed,1);
 assert.equal((await db.sql('select addon from public.addon_trash'))[0].addon.id,live.id);
});

test('successful checks clear the warning and reset the grace period without activity log edits',async()=>{
 await post(db,alice,addon('Return','https://github.com/a/return'));
 const before=await db.sql('select count(*)::int as n from public.activity_log');
 await check('github.com/a/return');
 await age();
 await check('github.com/a/return',false);
 assert.deepEqual(await db.sql('select * from public.repo_missing_since'),[]);
 assert.deepEqual((await db.sql('select unavailable_links from public.addons'))[0].unavailable_links,[]);
 assert.deepEqual(await db.sql('select count(*)::int as n from public.activity_log'),before);
 await check('github.com/a/return');
 assert.equal((await retire(['github.com/a/return']))[0].result.links_removed,0);
});

test('expired grace still needs a fresh explicit missing check; failed checks leave the clock intact',async()=>{
 await post(db,alice,addon('Wait','https://github.com/a/wait'));
 await check('github.com/a/wait'); await age();
 await db.sql("update public.repo_stats_checks set checked_at=now()-interval '2 hours'");
 assert.equal((await retire(['github.com/a/wait']))[0].result.links_removed,0);
 assert.equal((await retire([]))[0].result.links_removed,0);
 await check('github.com/a/wait');
 assert.equal((await retire(['github.com/a/wait']))[0].result.links_removed,1);
});

test('restoring from Trash resets grace and preserves the existing recovery record',async()=>{
 await post(db,alice,addon('Restore','https://github.com/a/restore'));
 await check('github.com/a/restore'); await age(); await retire(['github.com/a/restore']);
 const [trash]=await db.sql('select id from public.addon_trash');
 await db.as(admin,q=>q('select public.restore_addon($1)',[trash.id]));
 assert.deepEqual(await db.sql('select * from public.repo_missing_since'),[]);
 assert.deepEqual((await db.sql('select unavailable_links from public.addons'))[0].unavailable_links,[]);
 await check('github.com/a/restore');
 assert.equal((await retire(['github.com/a/restore']))[0].result.links_removed,0);
});

test('reverting link retirement resets grace without losing other links',async()=>{
 const live=await post(db,alice,addon('Revert','https://github.com/a/revert'));
 await db.sql("update public.addons set versions=versions || '[{\"url\":\"https://github.com/a/other\",\"note\":\"\"}]'::jsonb where id=$1",[live.id]);
 await check('github.com/a/revert'); await age(); await retire(['github.com/a/revert']);
 const [log]=await db.sql("select id from public.activity_log where details ? 'removed_links' order by id desc limit 1");
 await db.as(admin,q=>q('select public.revert_addon($1)',[log.id]));
 assert.deepEqual(await db.sql('select * from public.repo_missing_since'),[]);
 assert.equal((await db.sql('select versions from public.addons'))[0].versions.length,2);
 await check('github.com/a/revert');
 assert.equal((await retire(['github.com/a/revert']))[0].result.links_removed,0);
});
