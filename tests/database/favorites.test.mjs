import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import { createDb, addon, post } from '../helpers/db.mjs';
let db, alice, bob, item;
beforeEach(async () => {
	db = await createDb(); alice = await db.addUser('alice'); bob = await db.addUser('bob');
	item = await post(db, alice, addon('FavoriteMe'));
});
afterEach(() => db.close());
const save = (user, owner = user.id, id = item.id) => db.as(user, q => q('insert into public.addon_favorites(user_id, addon_id) values ($1, $2)', [owner, id]));
const read = user => db.as(user, q => q('select * from public.addon_favorites'));

test('favorites are private to their owner, including from other members and admins', async () => {
	const admin = await db.addUser('admin', 'admin');
	await save(alice);
	assert.equal((await read(alice)).length, 1);
	assert.deepEqual(await read(bob), []);
	assert.deepEqual(await read(admin), []);
	await assert.rejects(save(bob, alice.id), /row-level security/);
	await db.as(bob, q => q('delete from public.addon_favorites where user_id = $1', [alice.id]));
	assert.equal((await read(alice)).length, 1);
	await assert.rejects(db.asVisitor(q => q('select * from public.addon_favorites')), /permission denied/);
	await assert.rejects(db.asVisitor(q => q('insert into public.addon_favorites(user_id, addon_id) values ($1, $2)', [alice.id, item.id])), /permission denied/);
	await assert.rejects(db.as(alice, q => q('update public.addon_favorites set user_id = $1', [bob.id])), /permission denied/);
});

test('members can save and remove independently; duplicates and nonexistent addons are refused', async () => {
	await save(alice); await save(bob);
	await assert.rejects(save(alice), /duplicate key/);
	await assert.rejects(save(alice, alice.id, -1), /foreign key/);
	await db.as(alice, q => q('delete from public.addon_favorites where addon_id = $1', [item.id]));
	assert.deepEqual(await read(alice), []);
	assert.equal((await read(bob)).length, 1);
});

test('account and addon deletion remove the associated private favorites', async () => {
	await save(alice); await save(bob);
	await db.sql('delete from auth.users where id = $1', [bob.id]);
	assert.equal((await db.sql('select * from public.addon_favorites')).length, 1);
	await db.sql('delete from public.addons where id = $1', [item.id]);
	assert.deepEqual(await db.sql('select * from public.addon_favorites'), []);
});
