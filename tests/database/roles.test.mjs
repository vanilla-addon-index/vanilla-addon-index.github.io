import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { PUBLIC_ADDON_COLUMNS } from '../../src/lib/config.ts';
import { NIGHTLY_TOKEN, addon, post } from '../helpers/db.mjs';
import { createRulesContext } from '../helpers/rules-context.mjs';

let db, owner, admin, admin2, alice, bob, refused, call, role;
beforeEach(async () => {
	({ db, owner, admin, admin2, alice, bob, refused, call, role } = await createRulesContext());
});
afterEach(() => db.close());

describe('roles', () => {
	test('each dummy account has the role it was created with', async () => {
		assert.deepEqual(await role(owner), { admin: true, owner: true, banned: false });
		assert.deepEqual(await role(admin), { admin: true, owner: false, banned: false });
		assert.deepEqual(await role(alice), { admin: false, owner: false, banned: false });
	});

	test('nobody can make themselves admin or owner', async () => {
		await refused(() => call(alice, 'update public.profiles set is_owner = true where id = $1', [alice.id]));
		await refused(() => call(alice, 'update public.profiles set is_admin = true where id = $1', [alice.id]));
		await refused(() => call(admin, 'update public.profiles set is_owner = true where id = $1', [admin.id]));
	});

	test('usernames are private: an account sees its own, admins see all, visitors none', async () => {
		const names = async (work) => (await work('select username from public.profiles order by username')).map((r) => r.username);
		assert.deepEqual(await names((sql) => call(alice, sql)), ['alice']);
		assert.deepEqual(await names((sql) => db.asVisitor((q) => q(sql))), []);
		assert.deepEqual(await names((sql) => call(admin, sql)), ['admin', 'admin2', 'alice', 'bob', 'owner']);
	});

	test('who posted an addon cannot be looked up by a visitor or another member', async () => {
		await post(db, alice, addon('Atlas'));
		const poster = 'select p.username from public.addons a left join public.profiles p on p.id = a.owner';
		// A visitor cannot even read the account id; a member reads the id but no name.
		await refused(() => db.asVisitor((q) => q(poster)), /permission denied/);
		await refused(() => db.asVisitor((q) => q('select approved_by from public.addons')), /permission denied/);
		assert.deepEqual(await db.asVisitor((q) => q(`select ${PUBLIC_ADDON_COLUMNS} from public.addons`)).then((rows) => rows.map((r) => r.name)), ['Atlas']);
		assert.deepEqual(await call(bob, poster), [{ username: null }]);
		assert.deepEqual(await call(admin, poster), [{ username: 'alice' }]);
	});

	test('admins see how each account logs in; members cannot list accounts at all', async () => {
		await db.sql(`insert into auth.identities (user_id, provider, provider_id) values ($1, 'discord', '1')`, [alice.id]);
		const list = 'select username, providers from public.list_users($1)';
		assert.deepEqual(await call(admin, list, ['alice']), [{ username: 'alice', providers: ['discord'] }]);
		assert.deepEqual(await call(admin, list, ['bob']), [{ username: 'bob', providers: [] }]);
		assert.deepEqual(await call(owner, list, ['admin2']), [{ username: 'admin2', providers: [] }]);
		assert.deepEqual(await call(alice, list, ['']), []);
	});

	test('nobody can ask whether another account is an admin', async () => {
		const ask = 'select public.is_staff($1) as staff';
		await refused(() => db.asVisitor((q) => q(ask, [admin.id])), /permission denied/);
		await refused(() => call(alice, ask, [admin.id]), /permission denied/);
		await refused(() => call(admin, ask, [admin2.id]), /permission denied/);
		// The rules that depend on it still hold: an admin cannot suspend another admin.
		await refused(() => call(admin, 'select public.set_banned($1, true)', [admin2.id]), /Only the owner/);
		const roles = await call(admin, `select username, role from public.list_users('') order by username`);
		assert.deepEqual(
			roles.map((r) => `${r.username}:${r.role}`),
			['admin:admin', 'admin2:admin', 'alice:member', 'bob:member', 'owner:owner']
		);
	});

	test('role and ban flags cannot be read from the profiles table', async () => {
		await refused(() => call(alice, 'select banned from public.profiles'));
		await refused(() => call(alice, 'select is_owner from public.profiles'));
		await refused(() => call(admin, 'select is_owner from public.profiles'));
		await refused(() => db.asVisitor((q) => q('select * from public.profiles')));
	});

	test('the owner appoints admins and takes the role away again, at once and in the log', async () => {
		const appoint = (user, target, value) => call(user, 'select public.set_admin($1, $2)', [target.id, value]);
		await appoint(owner, alice, true);
		assert.deepEqual(await role(alice), { admin: true, owner: false, banned: false });
		// Saying it twice changes nothing and logs nothing more.
		await appoint(owner, alice, true);
		await appoint(owner, alice, false);
		assert.equal((await role(alice)).admin, false);
		assert.deepEqual(
			(await db.sql('select actor_name, action, subject from public.activity_log order by id')).map((l) => `${l.actor_name} ${l.action} ${l.subject}`),
			['owner user.admin alice', 'owner user.unadmin alice']
		);
	});

	test('only the owner can appoint: not an admin, not the account itself, not the nightly job', async () => {
		const appoint = (user, target) => call(user, 'select public.set_admin($1, true)', [target.id]);
		await refused(() => appoint(admin, alice), /Only the owner/);
		await refused(() => appoint(alice, alice), /Only the owner/);
		await refused(() => db.asVisitor((q) => q('select public.set_admin($1, true)', [alice.id])), /permission denied/);
		await refused(() => appoint(owner, owner), /stays one/);
		assert.equal((await role(alice)).admin, false);
		// Nothing is left of the organization's list for the nightly job's token to write to.
		await refused(() => db.asVisitor((q) => q('select public.store_org_members($1, $2::bigint[])', [NIGHTLY_TOKEN, [1]])), /does not exist/);
	});

	test('an admin logs in with whatever they like, and a suspended one has no admin rights', async () => {
		await db.sql(`insert into auth.identities (user_id, provider, provider_id) values ($1, 'discord', '9')`, [alice.id]);
		await call(owner, 'select public.set_admin($1, true)', [alice.id]);
		assert.equal((await role(alice)).admin, true);
		await call(owner, 'select public.set_banned($1, true)', [alice.id]);
		assert.deepEqual(await role(alice), { admin: false, owner: false, banned: true });
	});
});

describe('housekeeping', () => {
	test('every function names the schema it looks things up in', async () => {
		// One without it would look names up wherever its caller says.
		const loose = await db.sql(`
			select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
			where n.nspname = 'public' and p.proconfig is null`);
		assert.deepEqual(loose, []);
	});

	test('the roles of the API can empty no table, now or on one made later', async () => {
		await db.raw('create table public.made_later (id integer)');
		const open = await db.sql(`
			select c.relname, r.role from pg_class c
			join pg_namespace n on n.oid = c.relnamespace
			cross join (values ('anon'), ('authenticated'), ('service_role')) r (role)
			where n.nspname = 'public' and c.relkind = 'r'
				and (has_table_privilege(r.role, c.oid, 'truncate') or has_table_privilege(r.role, c.oid, 'trigger'))`);
		assert.deepEqual(open, []);
	});
});
