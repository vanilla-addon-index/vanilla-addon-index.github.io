import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { addon, post } from '../helpers/db.mjs';
import { createRulesContext } from '../helpers/rules-context.mjs';

let db, owner, admin, admin2, alice, bob, refused, call, live, role;
beforeEach(async () => {
	({ db, owner, admin, admin2, alice, bob, refused, call, live, role } = await createRulesContext());
});
afterEach(() => db.close());

describe('bans', () => {
	test('a banned member can still read but not post, edit or delete', async () => {
		const mine = await post(db, alice, addon('Atlas'));
		await call(admin, 'select public.set_banned($1, true)', [alice.id]);

		assert.equal((await role(alice)).banned, true);
		assert.equal((await call(alice, 'select name from public.addons')).length, 1);
		await refused(() => post(db, alice, addon('Another')));
		assert.equal((await call(alice, `update public.addons set author = 'x' where id = $1 returning id`, [mine.id])).length, 0);
		assert.equal((await call(alice, 'delete from public.addons where id = $1 returning id', [mine.id])).length, 0);

		await call(admin, 'select public.set_banned($1, false)', [alice.id]);
		await post(db, alice, addon('Another'));
	});

	test('a member cannot ban anyone', async () => {
		await refused(() => call(alice, 'select public.set_banned($1, true)', [bob.id]), /Only admins/);
	});

	test('an admin cannot suspend another admin; the owner can', async () => {
		await refused(() => call(admin, 'select public.set_banned($1, true)', [admin2.id]), /Only the owner/);
		await call(owner, 'select public.set_banned($1, true)', [admin2.id]);
		assert.deepEqual(await role(admin2), { admin: false, owner: false, banned: true });
	});

	test('a suspended admin can no longer use admin powers', async () => {
		const theirs = await post(db, alice, addon('Atlas'));
		await call(owner, 'select public.set_banned($1, true)', [admin.id]);
		assert.equal((await call(admin, 'delete from public.addons where id = $1 returning id', [theirs.id])).length, 0);
		await refused(() => call(admin, 'select public.set_banned($1, true)', [bob.id]), /Only admins/);
		assert.equal((await call(admin, 'select * from public.activity_log')).length, 0);
	});

	test('nobody can ban the owner, and nobody can ban themselves', async () => {
		await refused(() => call(admin, 'select public.set_banned($1, true)', [owner.id]), /owner cannot be banned/);
		await refused(() => call(owner, 'select public.set_banned($1, true)', [owner.id]), /cannot ban yourself/);
	});

	test('a ban takes nothing down: what the account posted or imported stays up', async () => {
		await post(db, alice, addon('Atlas'));
		await post(db, admin2, addon('Bagnon'));
		await call(admin, 'select public.set_banned($1, true)', [alice.id]);
		await call(owner, 'select public.set_banned($1, true)', [admin2.id]);

		assert.deepEqual(await live(), ['Atlas', 'Bagnon']);
		assert.equal((await db.sql('select * from public.addon_trash')).length, 0);
		// The version that could trash them is gone.
		await refused(() => call(admin, 'select public.set_banned($1, true, true)', [bob.id]));
	});
});

describe('deleting an account', () => {
	const leave = (user) => call(user, 'select public.delete_account()');
	const accounts = async () => (await db.sql('select username from public.profiles order by username')).map((r) => r.username);

	test('a member deletes their account: the login goes, the addons stay with nobody', async () => {
		const atlas = await post(db, alice, addon('Atlas'));
		await post(db, bob, addon('Bagnon'));
		await call(alice, `update public.addons set description = 'Edited by its poster, at some length.' where id = $1`, [atlas.id]);
		await leave(alice);

		assert.deepEqual(await accounts(), ['admin', 'admin2', 'bob', 'owner']);
		assert.equal((await db.sql('select count(*)::int as n from auth.users where id = $1', [alice.id]))[0].n, 0);
		assert.deepEqual(await db.sql('select name, owner from public.addons order by name'), [
			{ name: 'Atlas', owner: null },
			{ name: 'Bagnon', owner: bob.id }
		]);
		// Handing them over is no edit: nothing is trashed, and "updated" is untouched.
		assert.equal((await db.sql('select * from public.addon_trash')).length, 0);
		assert.equal((await db.sql('select updated_at from public.addons where id = $1', [atlas.id]))[0].updated_at.getTime(), (await db.sql(`select max(at) as at from public.activity_log where action = 'addon.update'`))[0].at.getTime());
		// Now only an admin can change it.
		assert.equal((await call(bob, `update public.addons set name = 'Mine' where id = $1 returning id`, [atlas.id])).length, 0);
		assert.equal((await call(admin, `update public.addons set name = 'Atlas 2' where id = $1 returning id`, [atlas.id])).length, 1);
	});

	test('what the account did stays in the log, without its name', async () => {
		await post(db, alice, addon('Atlas'));
		await call(admin, 'select public.set_banned($1, true)', [alice.id]);
		await call(admin, 'select public.set_banned($1, false)', [alice.id]);
		await leave(alice);
		const lines = await db.sql('select actor, actor_name, action, subject from public.activity_log order by id');
		assert.equal(JSON.stringify(lines).includes('alice'), false);
		assert.deepEqual(
			lines.map((l) => `${l.actor_name} ${l.action} ${l.subject}`),
			[
				'deleted account addon.create Atlas',
				'admin user.ban deleted account',
				'admin user.unban deleted account',
				'deleted account account.delete their account'
			]
		);
		assert.equal(lines[0].actor, null);
	});

	test('addons the account deleted itself beforehand are in the trash, without its name', async () => {
		const mine = await post(db, alice, addon('Mine'));
		await post(db, alice, addon('Kept'));
		await call(alice, 'delete from public.addons where id = $1', [mine.id]);
		await leave(alice);
		assert.deepEqual(await live(), ['Kept']);
		assert.deepEqual(await db.sql('select name, deleted_by_name from public.addon_trash'), [
			{ name: 'Mine', deleted_by_name: 'deleted account' }
		]);
		// An admin can still bring it back, like any other delete.
		const [{ id }] = await db.sql('select id from public.addon_trash');
		await call(admin, 'select public.restore_addon($1)', [id]);
		assert.deepEqual(await live(), ['Kept', 'Mine']);
	});

	test('an admin who leaves is forgotten as the approver of imports, which stay', async () => {
		await db.queueImports([{ name: 'pfUI', url: 'https://github.com/shagu/pfUI' }]);
		const [{ id }] = await db.sql('select id from public.import_queue');
		await call(admin, 'select public.approve_imports($1)', [[id]]);
		await leave(admin);
		assert.deepEqual(await db.sql('select name, owner, approved_by from public.addons'), [
			{ name: 'pfUI', owner: null, approved_by: null }
		]);
	});

	test('the owner cannot delete their account, and nobody can delete another', async () => {
		await refused(() => leave(owner), /owner's account cannot be deleted/);
		await refused(() => db.asVisitor((q) => q('select public.delete_account()')));
		await refused(() => call(alice, 'delete from auth.users where id = $1', [bob.id]));
		await refused(() => call(alice, 'delete from public.profiles where id = $1', [bob.id]));
		assert.equal((await accounts()).length, 5);
	});

	test('a banned login stays banned after deleting its account and coming back', async () => {
		const identity = `insert into auth.identities (user_id, provider, provider_id) values ($1, 'discord', '555')`;
		await db.sql(identity, [alice.id]);
		await call(admin, 'select public.set_banned($1, true)', [alice.id]);
		await leave(alice);
		// Only a fingerprint is kept, and nobody can read it.
		const [{ fingerprint }] = await db.sql('select fingerprint from public.banned_identities');
		assert.match(fingerprint, /^[0-9a-f]{64}$/);
		await refused(() => call(admin, 'select * from public.banned_identities'), /permission denied/);

		// The same Discord account logs in again and gets a new account.
		const again = await db.addUser('alice');
		await db.sql(identity, [again.id]);
		// Held back at once, before the site has even asked who this is.
		await refused(() => post(db, again, addon('Atlas')));
		assert.deepEqual(await role(again), { admin: false, owner: false, banned: true });
		// From then on it is an ordinary ban, which an admin can see and lift.
		assert.deepEqual(await db.sql('select banned from public.profiles where id = $1', [again.id]), [{ banned: true }]);
		assert.equal((await db.sql('select * from public.banned_identities')).length, 0);
		await call(admin, 'select public.set_banned($1, false)', [again.id]);
		await post(db, again, addon('Atlas'));
		// Someone else on Discord was never affected.
		await db.sql(`insert into auth.identities (user_id, provider, provider_id) values ($1, 'discord', '556')`, [bob.id]);
		assert.equal((await role(bob)).banned, false);
	});

	test('an account that was not banned leaves no fingerprint', async () => {
		await db.sql(`insert into auth.identities (user_id, provider, provider_id) values ($1, 'discord', '555')`, [alice.id]);
		await leave(alice);
		assert.equal((await db.sql('select * from public.banned_identities')).length, 0);
	});
});
