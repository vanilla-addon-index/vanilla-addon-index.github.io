import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {addon,createDb,post} from './db.mjs';

test('new category and legacy writes use UI & Appearance',async()=>{
 const db=await createDb();
 try{
  const member=await db.addUser('member');
  for(const category of ['UI & Appearance','Interface Suites']){
   const a=await post(db,member,addon(category==='Interface Suites'?'LegacyUI':'ModernUI',undefined,{category}));
   assert.equal(a.category,'UI & Appearance');
  }
 }finally{await db.close();}
});

test('category migration renames published and queued entries without changing their decisions',async()=>{
 const db=await createDb();
 try{
  const admin=await db.addUser('admin','admin');
  const a=await post(db,admin,addon('OriginalUI',undefined,{category:'UI & Appearance'}));
  await db.raw('drop trigger addons_a_category_alias on public.addons; drop function public.addons_category_alias(); alter table public.addons drop constraint addons_category_check;');
  await db.sql("update public.addons set category='Interface Suites' where id=$1",[a.id]);
  await db.sql("insert into public.import_queue(key,url,name,category,status) values('github.com/a/other','https://github.com/a/other','Other UI','Interface Suites','rejected')");
  await db.raw("alter table public.addons add constraint addons_category_check check (category <> '');");
  await db.raw(readFileSync(new URL('../supabase/migrations/20261016000002_ui_appearance_category.sql',import.meta.url),'utf8'));
  assert.equal((await db.sql('select category from public.addons where id=$1',[a.id]))[0].category,'UI & Appearance');
  const [q]=await db.sql("select category,status from public.import_queue where key='github.com/a/other'");
  assert.equal(q.category,'UI & Appearance');assert.equal(q.status,'rejected');
 }finally{await db.close();}
});
