import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDb } from '../helpers/db.mjs';

test('wiki articles expand to normal entries and ordinary approval groups and pins a recommendation approved last', async () => {
 const db=await createDb();
 try {
  const admin=await db.addUser('admin','admin'),member=await db.addUser('member');
  const call=(sql,params=[])=>db.as(admin,q=>q(sql,params));
  const queue=async name=>(await db.sql("insert into public.import_queue(key,url,name,description) values(public.link_key($1),$1,$2,'Automates repetitive interactions.') returning id",[`https://turtle-wow.fandom.com/wiki/${name}`,name]))[0].id;
  const id=await queue('LazyPig');
  const links=['thezephyrsong','Otari98','jrc13245'].map((owner,i)=>({url:`https://github.com/${owner}/_LazyPig`,recommended:i===0}));
  await assert.rejects(()=>db.as(member,q=>q('select public.expand_wiki_article($1,$2::jsonb)',[id,JSON.stringify(links)])),/Only admins/);
  await assert.rejects(()=>call('select public.expand_wiki_article($1,$2::jsonb)',[id,'[]']),/Choose between/);
  await call('select public.expand_wiki_article($1,$2::jsonb)',[id,JSON.stringify(links)]);
  const [source]=await db.sql('select * from public.import_queue where id=$1',[id]);
  assert.equal(source.wiki_expanded,true);assert.equal(source.status,'approved');assert.equal(source.addon_id,null);
  const children=await db.sql('select * from public.import_queue where wiki_source=$1 order by wiki_recommended,url',[source.url]);
  assert.equal(children.length,3);
  for(const child of children) {
   assert.equal(child.status,'pending'); assert.equal(child.name,'LazyPig'); assert.equal(child.description,source.description);
   await call("select public.publish_import($1,$2::jsonb)",[child.id,JSON.stringify({name:'LazyPig',category:'Miscellaneous',description:source.description,images:[]})]);
  }
  const addons=await db.sql('select * from public.addons');
  assert.equal(addons.length,1);assert.equal(addons[0].versions.length,3);assert.equal(addons[0].shared,true);
  assert.equal(addons[0].pinned_link,links[0].url);
  assert.ok(addons[0].versions.every(v=>v.note===''));
  const duplicate=await queue('LazyPigAgain');
  await call('select public.expand_wiki_article($1,$2::jsonb)',[duplicate,JSON.stringify(links)]);
  assert.equal((await db.sql("select count(*)::int as n from public.import_queue where status='pending'"))[0].n,0);
  const invalid=await queue('Invalid');
  await assert.rejects(()=>call('select public.expand_wiki_article($1,$2::jsonb)',[invalid,JSON.stringify([links[0],{url:'https://evil.test/download'}])]),/Invalid repository/);
  assert.equal((await db.sql('select status from public.import_queue where id=$1',[invalid]))[0].status,'pending');
 } finally { await db.close(); }
});
