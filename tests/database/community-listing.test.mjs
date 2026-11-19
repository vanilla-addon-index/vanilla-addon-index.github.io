import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addon, post } from '../helpers/db.mjs';
import { createRulesContext } from '../helpers/rules-context.mjs';

test('staff can convert only their own posts to community listings', async () => {
 const { db, admin, owner, alice, call, refused } = await createRulesContext();
 try {
  const mine = await post(db, admin, addon('AdminListing'));
  const members = await post(db, alice, addon('MemberListing'));
  await refused(() => call(alice, 'select public.make_community_listing($1)', [members.id]), /Only admins/);
  await refused(() => call(admin, 'select public.make_community_listing($1)', [members.id]), /own posts/);
  await refused(() => call(owner, 'select public.make_community_listing($1)', [mine.id]), /own posts/);
  await call(admin, 'select public.make_community_listing($1)', [mine.id]);
  const [saved] = await db.sql('select * from public.addons where id = $1', [mine.id]);
  assert.equal(saved.owner, null);
  for (const key of ['versions', 'author', 'description', 'images', 'shared']) assert.deepEqual(saved[key], mine[key]);
  assert.equal((await db.sql("select * from public.activity_log where addon_id = $1 and action = 'addon.community'", [mine.id])).length, 1);
  await call(admin, 'select public.make_community_listing($1)', [mine.id]);
  const own = await post(db, owner, addon('OwnerListing'));
  await call(owner, 'select public.make_community_listing($1)', [own.id]);
  assert.equal((await db.sql('select owner from public.addons where id = $1', [own.id]))[0].owner, null);
 } finally { await db.close(); }
});
