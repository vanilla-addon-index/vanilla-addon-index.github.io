import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { addon, createDb, post } from '../helpers/db.mjs';

const migration=readFileSync(new URL('../../supabase/migrations/20261027000003_backfill_renamed_addresses.sql',import.meta.url),'utf8');

test('backfill repairs previously renamed addresses and preserves old links across reruns', async () => {
 const db=await createDb();
 try {
  const member=await db.addUser('member');
  const row=await post(db,member,addon('SuperCleveRoidMacros-ClassicAPI'));
  await db.raw('alter table public.addons disable trigger addons_slug');
  await db.sql("update public.addons set name='SuperCleveRoidMacros', aliases='{earlier-name}' where id=$1",[row.id]);
  await db.raw('alter table public.addons enable trigger addons_slug');
  await db.raw(migration);
  const [fixed]=await db.sql('select id,slug,aliases from public.addons where id=$1',[row.id]);
  assert.equal(fixed.slug,'supercleveroidmacros');
  assert.deepEqual(fixed.aliases,['earlier-name','supercleveroidmacros-classicapi']);
  await db.raw(migration);
  assert.deepEqual((await db.sql('select id,slug,aliases from public.addons where id=$1',[row.id]))[0],fixed);
  const [resolved]=await db.asVisitor(q=>q("select id from public.addons where slug='supercleveroidmacros' or 'supercleveroidmacros-classicapi'=any(aliases)"));
  assert.equal(resolved.id,row.id);
 } finally {await db.close();}
});

test('backfill respects addresses reserved by other addons', async () => {
 const db=await createDb();
 try {
  const member=await db.addUser('member');
  const holder=await post(db,member,addon('Taken'));
  await db.as(member,q=>q("update public.addons set name='Moved' where id=$1",[holder.id]));
  const row=await post(db,member,addon('Earlier','https://github.com/example/Earlier'));
  await db.raw('alter table public.addons disable trigger addons_slug');
  await db.sql("update public.addons set name='Taken' where id=$1",[row.id]);
  await db.raw('alter table public.addons enable trigger addons_slug');
  await db.raw(migration);
  const [fixed]=await db.sql('select slug,aliases from public.addons where id=$1',[row.id]);
  assert.equal(fixed.slug,'taken-example'); assert.deepEqual(fixed.aliases,['earlier']);
  assert.deepEqual((await db.sql('select aliases from public.addons where id=$1',[holder.id]))[0].aliases,['taken']);
 } finally {await db.close();}
});
