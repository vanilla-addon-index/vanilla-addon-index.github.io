import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addon, post } from '../helpers/db.mjs';
import { createRulesContext } from '../helpers/rules-context.mjs';

test('import review counts, pages and repository facts respect queue status and permissions', async () => {
 const { db, admin, alice, call, refused } = await createRulesContext();
 try {
  const live = await post(db, alice, addon('ParentExample'));
  await db.sql(`insert into public.import_queue (key,url,name,status,wiki_expanded) values
   ('github.com/sample/exact','https://github.com/sample/exact','ParentExample','pending',false),
   ('github.com/sample/fork','https://github.com/sample/fork','Renamed fork','pending',false),
   ('github.com/sample/renamed','https://github.com/sample/renamed','Parent Example','pending',false),
   ('github.com/sample/gone','https://github.com/sample/gone','Missing repository','pending',false),
   ('github.com/sample/filed','https://github.com/sample/filed','Filed repository','dead',false),
   ('github.com/sample/declined','https://github.com/sample/declined','Declined','rejected',false),
   ('github.com/sample/published','https://github.com/sample/published','Published','approved',false),
   ('github.com/sample/expanded','https://github.com/sample/expanded','Expanded','approved',true),
   ('turtle-wow.fandom.com/wiki/parent','https://turtle-wow.fandom.com/wiki/Parent','ParentExample','pending',false)`);
  await db.sql(`insert into public.repo_stats (key,fork_of,canonical,missing,stars) values
   ('github.com/sample/fork',$1,null,false,14),
   ('github.com/sample/renamed',null,$1,false,0),
   ('github.com/sample/gone',null,null,true,0)`, [live.link_keys[0]]);
  await db.sql(`insert into public.import_queue (key,url,name,description)
   select 'github.com/sample/filler-'||i,'https://github.com/sample/filler-'||i,'Sample '||lpad(i::text,4,'0'),
    case when i=1205 then 'Find 100%_[x],* here' else '' end from generate_series(1,1205) i`);

  const [summary] = await call(admin,'select public.import_review_counts() as counts');
  assert.deepEqual(summary.counts, {
   pending: 1210, waiting: 1209, approved: 1, rejected: 1, submitted: 0, dead: 2,
   fine: 2, duplicate: 1, incomplete: 1205, wiki: 1, mirrors: 0, discord: 0
  });
  const first = await call(admin,`select id,review_stats from public.pending_imports
   where review_bucket='fine' order by sort_name,id limit 1`);
  assert.equal(first[0].review_stats, null);
  const second = await call(admin,`select id,review_stats from public.pending_imports
   where review_bucket='fine' order by sort_name,id limit 1 offset 1`);
  assert.equal(second[0].review_stats.stars, 14);
  assert.notEqual(first[0].id, second[0].id);
  const found = await call(admin,`select name from public.pending_imports
    where review_bucket='incomplete' and search_document ~ '(?q)100%_[x],*' limit 50`);
  assert.deepEqual(found, [{ name: 'Sample1205' }]);
  assert.deepEqual((await call(admin,`select status from public.decided_imports
   where review_bucket='dead' order by sort_name,id`)).map(row => row.status), ['dead','pending']);
  assert.deepEqual(await call(alice,'select id from public.decided_imports'), []);
  await refused(() => call(alice,'select public.import_review_counts()'), /Only admins/);
 } finally {
  await db.close();
 }
});
