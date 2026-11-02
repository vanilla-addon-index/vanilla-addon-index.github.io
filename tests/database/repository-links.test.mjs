import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, post, addon } from '../helpers/db.mjs';
import { repositoryLink, linkKey } from '../../src/lib/links.ts';

const cases = [
 ['https://github.com/Tom75VN/PandaConquest/releases/latest', 'https://github.com/Tom75VN/PandaConquest'],
 ['https://github.com/Tom75VN/PandaMap/releases/latest/download/PandaMap.zip', 'https://github.com/Tom75VN/PandaMap'],
 ...['github.com', 'codeberg.org', 'gitea.com', 'octowow.st/git'].flatMap(host =>
  ['releases', 'releases/tag/v1', 'releases/download/v1/addon.zip', 'archive/main.zip'].map(path => [`https://${host}/Author/Addon/${path}`, `https://${host}/Author/Addon`])),
 ['https://gitlab.com/group/subgroup/Addon/-/releases/permalink/latest/downloads/a.zip', 'https://gitlab.com/group/subgroup/Addon'],
 ['https://gitlab.com/group/subgroup/Addon/-/archive/main/Addon.zip?x=1', 'https://gitlab.com/group/subgroup/Addon'],
 ...['https://github.com/a/b/tree/main/Addons', 'https://github.com/a/b/blob/main/Addon.zip',
 'https://gitlab.com/a/sub/b/-/tree/main/Addons', 'https://codeberg.org/a/b/src/branch/main/Addons',
 'https://gitea.com/a/b/raw/branch/main/a.lua', 'https://octowow.st/git/a/b/src/branch/main/Addons',
 'https://example.com/a/b/releases/latest', 'https://github.com.evil.example/a/b/releases/latest'].map(url => [url,url])
];

test('repository cleanup matches database rules across every supported Git host and preserves source paths', async () => {
 const db = await createDb();
 try {
  for (const [url, expected] of cases) {
   assert.equal(repositoryLink(url),expected,url);
   const [row] = await db.sql('select public.repository_link($1) as url, public.link_key($1) as key',[url]);
   assert.equal(row.url,expected,url);
   assert.equal(row.key,linkKey(url),url);
  }
  const owner = await db.addUser('owner','owner');
  for (const [i,host] of ['github.com','gitlab.com','codeberg.org','gitea.com','octowow.st/git'].entries()) {
   const repo = `https://${host}/a/Addon${i}`;
   const release = `${repo}/${host === 'gitlab.com' ? '-/' : ''}releases/latest`;
   const row = await post(db,owner,addon(`Addon${i}`,release));
   assert.equal(row.repo_url,repo);
   assert.equal((await db.as(owner,q=>q('select public.queue_discord_imports($1::jsonb) as result',[JSON.stringify([{url:release,name:`Addon${i}`}])])))[0].result.skipped,1);
  }
 } finally { await db.close(); }
});


test('historical cleanup preserves addon timestamps, history and queue decisions', async () => {
 const db = await createDb();
 try {
  const owner = await db.addUser('owner','owner');
  const row = await post(db,owner,addon('Legacy','https://codeberg.org/a/Legacy'));
  await db.raw(`alter table public.addons disable trigger user;
   update public.addons set versions='[{"url":"https://codeberg.org/a/Legacy/releases/tag/v1","note":"Vanilla"}]',
   link_keys=array['codeberg.org/a/legacy/releases/tag/v1'];
   alter table public.addons enable trigger user;`);
  await db.raw(`drop trigger normalize_import_repository_link on public.import_queue;
   insert into public.import_queue(key,url,name,status) values
    ('codeberg.org/a/legacy/releases/tag/v1','https://codeberg.org/a/Legacy/releases/tag/v1','Legacy','rejected');
   drop trigger addons_aaa_repository_links on public.addons;
   drop function public.normalize_addon_repository_links();
   drop function public.normalize_import_repository_link();
   drop function public.repository_link(text);`);
  const before = await db.sql('select count(*)::int as n from public.activity_log');
  await db.raw(readFileSync(new URL('../../supabase/migrations/20261102000002_repository_links.sql',import.meta.url),'utf8'));
  const [after] = await db.sql('select * from public.addons where id=$1',[row.id]);
  assert.equal(after.repo_url,'https://codeberg.org/a/Legacy');
  assert.equal(after.versions[0].note,'Vanilla');
  assert.deepEqual(after.updated_at,row.updated_at);
  assert.deepEqual(await db.sql('select count(*)::int as n from public.activity_log'),before);
  const [queued] = await db.sql('select * from public.import_queue');
  assert.equal(queued.status,'rejected');
  assert.equal(queued.key,'codeberg.org/a/legacy');
  assert.equal((await db.as(owner,q=>q('select public.queue_discord_imports($1::jsonb) as result',[JSON.stringify([{url:queued.url,name:'Legacy'}])])))[0].result.skipped,1);
 } finally { await db.close(); }
});
