// What each kind of account may and may not do, checked against the real database rules.
//
//   npm test
//
// Every test gets its own throwaway database with dummy accounts; see db.mjs.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { CATEGORIES, PUBLIC_ADDON_COLUMNS } from '../src/lib/config.ts';
import { linkKey } from '../src/lib/links.ts';
import { NIGHTLY_TOKEN, addon, createDb, post } from './db.mjs';

let db;
let owner, admin, admin2, alice, bob;

beforeEach(async () => {
	db = await createDb();
	owner = await db.addUser('owner', 'owner');
	admin = await db.addUser('admin', 'admin');
	admin2 = await db.addUser('admin2', 'admin');
	alice = await db.addUser('alice');
	bob = await db.addUser('bob');
});
afterEach(() => db.close());

const refused = (work, message) => assert.rejects(work, message ? { message } : undefined);
const call = (user, sql, params) => db.as(user, (q) => q(sql, params));
const live = async () => (await db.sql('select name from public.addons order by name')).map((r) => r.name);
const logged = async () => (await db.sql('select action from public.activity_log order by id')).map((r) => r.action);
const role = async (user) => (await call(user, 'select public.my_role() as r'))[0].r;

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
		assert.deepEqual(await call(owner, list, ['admin2']), [{ username: 'admin2', providers: ['github'] }]);
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

	test('an admin who leaves the organization loses admin rights at the next nightly run', async () => {
		await db.storeOrgMembers([]);
		assert.equal((await role(admin)).admin, false);
		assert.equal((await role(owner)).admin, true);
	});

	test('an account joining or leaving the organization\'s list is logged', async () => {
		const ids = (await db.sql(`select provider_id::bigint as id from auth.identities where provider = 'github' order by 1`)).map((r) => r.id);
		// Storing the same list again changes nothing and logs nothing.
		await db.storeOrgMembers(ids);
		assert.deepEqual(await logged(), []);
		// One the site has never seen joins, and one of the admins leaves.
		await db.storeOrgMembers([ids[0], 4242]);
		assert.deepEqual(
			(await db.sql('select actor_name, action, subject from public.activity_log order by action')).map((l) => `${l.actor_name} ${l.action} ${l.subject}`),
			['null user.admin GitHub user 4242', 'null user.unadmin admin2']
		);
	});

	test('only the nightly job can say who the organization\'s members are', async () => {
		const [{ provider_id: mine }] = await db.sql(`insert into auth.identities (user_id, provider, provider_id) values ($1, 'github', '77') returning provider_id`, [alice.id]);
		const store = 'select public.store_org_members($1, $2::bigint[])';
		await refused(() => db.storeOrgMembers([Number(mine)], 'a guess'), /Only the nightly job/);
		await refused(() => db.storeOrgMembers(null), /missing/);
		for (const user of [alice, admin, owner]) {
			await refused(() => call(user, store, [NIGHTLY_TOKEN, [77]]), /permission denied/);
		}
		await refused(() => db.asService((q) => q(store, [NIGHTLY_TOKEN, [77]])), /permission denied/);
		assert.equal((await role(alice)).admin, false);
	});

	test('the list of members counts for three days after the last nightly run', async () => {
		await db.sql(`update public.org_cache set fetched_at = now() - interval '2 days'`);
		assert.equal((await role(admin)).admin, true);
		await db.sql(`update public.org_cache set fetched_at = now() - interval '4 days'`);
		assert.equal((await role(admin)).admin, false);
		// The owner and hand-ticked admins do not depend on the list.
		assert.equal((await role(owner)).admin, true);
		await db.sql('update public.profiles set is_admin = true where id = $1', [alice.id]);
		assert.equal((await role(alice)).admin, true);
	});
});

describe('posting and editing', () => {
	test('a visitor can read but not post', async () => {
		await post(db, alice, addon('Atlas'));
		assert.equal((await db.asVisitor((q) => q('select name from public.addons'))).length, 1);
		await refused(() =>
			db.asVisitor((q) => q(`insert into public.addons (slug, name, versions) values ('x', 'Xx', '[]')`))
		);
	});

	test('a member can edit and delete only their own addons', async () => {
		const mine = await post(db, alice, addon('Atlas'));
		const theirs = await post(db, bob, addon('Bagnon'));

		await call(alice, `update public.addons set author = 'Maps' where id = $1`, [mine.id]);
		const touched = await call(alice, `update public.addons set author = 'Hacked' where id = $1 returning id`, [
			theirs.id
		]);
		assert.equal(touched.length, 0);
		assert.equal((await call(alice, 'delete from public.addons where id = $1 returning id', [theirs.id])).length, 0);
		assert.deepEqual(await live(), ['Atlas', 'Bagnon']);

		await call(alice, 'delete from public.addons where id = $1', [mine.id]);
		assert.deepEqual(await live(), ['Bagnon']);
	});

	test('an admin can edit and delete anyone\'s addon', async () => {
		const theirs = await post(db, alice, addon('Atlas'));
		await call(admin, `update public.addons set category = 'Map & Minimap' where id = $1`, [theirs.id]);
		await call(admin, 'delete from public.addons where id = $1', [theirs.id]);
		assert.deepEqual(await live(), []);
	});

	test('nobody can post as someone else or take over an addon', async () => {
		await refused(() => post(db, alice, { ...addon('Atlas'), owner: bob.id }));
		const mine = await post(db, alice, addon('Atlas'));
		await refused(() => call(alice, 'update public.addons set owner = $1 where id = $2', [bob.id, mine.id]));
	});

	test('the address comes from the name, whatever the poster sends', async () => {
		const slugOf = async (fields) => (await post(db, alice, fields)).slug;
		assert.equal(await slugOf(addon('Junk Entry', 'https://github.com/alice/junk', { slug: 'pfui' })), 'junk-entry');
		assert.equal(await slugOf(addon('Big Wigs!', 'https://github.com/alice/bigwigs')), 'big-wigs');
		// The same name again: told apart by who hosts it, then by a number.
		assert.equal(await slugOf(addon('Big Wigs', 'https://github.com/Bob/BigWigs')), 'big-wigs-bob');
		assert.equal(await slugOf(addon('Big Wigs', 'https://github.com/bob/other')), 'big-wigs-bob-2');
		assert.equal(await slugOf(addon('Big Wigs', 'https://gitlab.com/carol/bigwigs')), 'big-wigs-gitlab-com');
		// An address that still leads to an addon merged into another cannot be taken.
		await db.sql(`update public.addons set aliases = '{old-name}' where slug = 'big-wigs'`);
		assert.equal(await slugOf(addon('Old Name', 'https://github.com/dave/old')), 'old-name-dave');
		await refused(() => call(alice, `update public.addons set slug = 'pfui' where slug = 'junk-entry'`));
	});

	test('any number of addons can share a name, each at an address of its own', async () => {
		const slugs = [];
		for (const repo of ['atlas', 'atlas-fork', 'atlas-3', 'atlas-4']) {
			slugs.push((await post(db, alice, addon('Atlas', `https://github.com/someone/${repo}`))).slug);
		}
		slugs.push((await post(db, bob, addon('Atlas', 'https://gitlab.com/else/atlas'))).slug);
		// The name, then who hosts it, then a number for as long as that is still taken.
		assert.deepEqual(slugs, ['atlas', 'atlas-someone', 'atlas-someone-2', 'atlas-someone-3', 'atlas-gitlab-com']);
	});

	test('a member needs a description of 15 characters; an admin does not', async () => {
		await refused(() => post(db, alice, addon('Atlas', undefined, { description: 'Too short' })), /15 characters/);
		await post(db, admin, addon('Atlas', undefined, { description: 'Maps' }));
		assert.deepEqual(await live(), ['Atlas']);
	});

	test('an addon cannot be posted without a category', async () => {
		const { category, ...rest } = addon('Atlas');
		await refused(() => post(db, alice, rest));
		await refused(() => post(db, admin, { ...rest, category: '' }));
		await post(db, alice, { ...rest, category });
	});

	test('the category is one from the site\'s list, for admins too', async () => {
		await refused(() => post(db, alice, addon('Atlas', undefined, { category: 'Cheats' })));
		await refused(() => post(db, admin, addon('Atlas', undefined, { category: 'x'.repeat(5000) })));
		// Every category the site offers is one the database accepts.
		for (const [i, category] of CATEGORIES.entries()) await post(db, admin, addon(`Addon${i}`, undefined, { category }));
	});

	test('the name is tidied, and cannot be blank', async () => {
		const row = await post(db, alice, addon('Atlas', undefined, { name: '  Big\n\tWigs  ', author: ' Some\nOne ' }));
		assert.deepEqual([row.name, row.author], ['Big Wigs', 'Some One']);
		await refused(() => post(db, alice, addon('Blank', undefined, { name: '      ' })));
		await refused(() => call(alice, `update public.addons set name = E' \n ' where id = $1`, [row.id]));
	});

});

describe('links and versions', () => {
	test('different spellings of one repository count as the same link', async () => {
		const key = async (url) => (await db.sql('select public.link_key($1) as k', [url]))[0].k;
		assert.equal(await key('https://github.com/Shagu/pfQuest'), 'github.com/shagu/pfquest');
		assert.equal(await key('https://github.com/shagu/pfQuest.git'), 'github.com/shagu/pfquest');
		assert.equal(await key('https://www.github.com/shagu/pfQuest/tree/master'), 'github.com/shagu/pfquest');
		assert.equal(await key('https://gitlab.com/group/sub/addon/-/tree/main'), 'gitlab.com/group/sub/addon');
	});

	test('a folder of a repository is a link of its own, whichever branch it is read from', async () => {
		const key = async (url) => (await db.sql('select public.link_key($1) as k', [url]))[0].k;
		const atlas = 'github.com/someone/collection/a/atlas';
		assert.equal(await key('https://github.com/Someone/Collection/tree/master/a/Atlas'), atlas);
		assert.equal(await key('https://github.com/someone/collection/tree/main/a/Atlas/'), atlas);
		assert.equal(await key('https://github.com/someone/collection/blob/238c6d6/a/Atlas?tab=readme'), atlas);
		// A branch alone is still the repository.
		assert.equal(await key('https://github.com/someone/collection/tree/vanilla'), 'github.com/someone/collection');

		await post(db, alice, addon('Atlas', 'https://github.com/someone/collection/tree/master/a/Atlas'));
		await post(db, bob, addon('Bagnon', 'https://github.com/someone/collection/tree/master/b/Bagnon'));
		await post(db, bob, addon('Whole collection', 'https://github.com/someone/collection'));
		await refused(
			() => post(db, bob, addon('Atlas again', 'https://github.com/someone/collection/tree/main/a/atlas')),
			/already listed under "Atlas"/
		);
	});

	test('the site and the database make the same key from a link', async () => {
		const links = [
			'https://github.com/Shagu/pfQuest',
			'https://github.com/shagu/pfQuest.git',
			'http://www.github.com/shagu/pfQuest/',
			'https://github.com/shagu/pfQuest?tab=readme-ov-file#install',
			'https://github.com/shagu/pfQuest/tree/master',
			'https://github.com/shagu/pfQuest/tree/master/',
			'https://github.com/shagu/pfQuest/releases/download/v1/pfQuest.zip',
			'https://github.com/shagu/pfQuest/archive/refs/heads/master.zip',
			'https://github.com/shagu/pfQuest/issues/12',
			'https://github.com/ericraio/vanilla-wow-addons/tree/238c6d633d5a5b8a0cc4ee7a8cbb548ea80da081/p/Parchment',
			'https://github.com/xVitali2/Addons-for-Vanilla-1.12.1/tree/master/BGAssistRU',
			'https://github.com/laytya/Vanilla-Addons/blob/master/Cryolysis.zip',
			'https://github.com/Arthur-Helias/BetterCharacterPanel/tree/main?tab=readme-ov-file',
			'https://github.com/someone/collection/tree/feature/x/Addon//',
			'https://github.com/someone/collection/tree/',
			'https://github.com/someone',
			'  https://github.com/Someone/Addon  ',
			'https://gitlab.com/group/sub/addon/-/tree/main',
			'https://gitlab.com/group/addon.git',
			'https://codeberg.org/someone/addon/',
			'https://example.com/addons/thing.zip?download=1',
			'https://legacy-wow.com/vanilla-addons/atlas/#comments'
		];
		for (const url of links) {
			const [{ k }] = await db.sql('select public.link_key($1) as k', [url]);
			assert.equal(linkKey(url), k, url);
		}
	});

	test('a link that is already listed is refused, however it is spelled', async () => {
		await post(db, alice, addon('pfQuest', 'https://github.com/shagu/pfQuest'));
		await refused(
			() => post(db, bob, addon('pfQuest copy', 'https://github.com/Shagu/pfquest.git')),
			/already listed under "pfQuest"/
		);
	});

	test('a link keeps its address and note only, and links and screenshots have a length limit', async () => {
		const versions = JSON.stringify([
			{ url: 'https://github.com/a/atlas', note: 'main', added_by: 'owner', junk: 'x'.repeat(10000) },
			{ url: 'https://gitlab.com/a/atlas' }
		]);
		const row = await post(db, alice, addon('Atlas', undefined, { versions }));
		assert.deepEqual(row.versions, [
			{ url: 'https://github.com/a/atlas', note: 'main' },
			{ url: 'https://gitlab.com/a/atlas', note: '' }
		]);

		const long = (length) => `https://example.com/${'a'.repeat(length)}`;
		await refused(() => post(db, alice, addon('Long', long(300))), /at most 300/);
		await refused(() => post(db, alice, addon('Shots', undefined, { images: `{${long(500)}}` })), /at most 500/);
		await post(db, alice, addon('Shots', undefined, { images: `{${long(200)}}` }));
	});

	test('the first version is the main link', async () => {
		const versions = JSON.stringify([
			{ url: 'https://github.com/brues-code/pfUI', note: 'maintained' },
			{ url: 'https://github.com/shagu/pfUI', note: 'original' }
		]);
		const row = await post(db, alice, { ...addon('pfUI'), versions });
		assert.equal(row.repo_url, 'https://github.com/brues-code/pfUI');
		assert.deepEqual(row.link_keys.sort(), ['github.com/brues-code/pfui', 'github.com/shagu/pfui']);
	});

	test('links must be https, and an addon needs at least one', async () => {
		await refused(() => post(db, alice, { ...addon('A1'), versions: '[]' }), /between 1 and 10 links/);
		await refused(() => post(db, alice, addon('A2', 'http://example.com/a')), /https/);
	});

});

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

describe('log, trash and undo', () => {
	test('every change is logged with who did it', async () => {
		const row = await post(db, alice, addon('Atlas'));
		await call(admin, `update public.addons set author = 'Maps' where id = $1`, [row.id]);
		await call(admin, 'delete from public.addons where id = $1', [row.id]);

		const [edit] = await db.sql(`select details from public.activity_log where action = 'addon.update'`);
		assert.deepEqual(edit.details.changed, ['author']);
		assert.equal(edit.details.before.author, '');
		assert.deepEqual(edit.details.after, { author: 'Maps' });

		const lines = await db.sql('select actor_name, action, subject from public.activity_log order by id');
		assert.deepEqual(lines, [
			{ actor_name: 'alice', action: 'addon.create', subject: 'Atlas' },
			{ actor_name: 'admin', action: 'addon.update', subject: 'Atlas' },
			{ actor_name: 'admin', action: 'addon.delete', subject: 'Atlas' }
		]);
	});

	test('members cannot read the log or the trash, and nobody can change the log', async () => {
		await post(db, alice, addon('Atlas'));
		assert.equal((await call(alice, 'select * from public.activity_log')).length, 0);
		assert.equal((await call(alice, 'select * from public.addon_trash')).length, 0);
		assert.equal((await call(admin, 'select * from public.activity_log')).length, 1);
		for (const user of [alice, admin, owner]) {
			await refused(() => call(user, 'delete from public.activity_log'));
			await refused(() => call(user, `update public.activity_log set actor_name = 'someone else'`));
			await refused(() => call(user, `insert into public.activity_log (action) values ('fake')`));
			await refused(() => call(user, `select public.log_action('fake', 'x', null, null)`));
		}
	});

	test('a deleted addon can be restored, by admins only, to its original poster', async () => {
		const row = await post(db, alice, addon('Atlas'));
		await call(admin, 'delete from public.addons where id = $1', [row.id]);
		const [{ id: trashId }] = await db.sql('select id from public.addon_trash');

		await refused(() => call(alice, 'select public.restore_addon($1)', [trashId]), /Only admins/);
		await call(admin2, 'select public.restore_addon($1)', [trashId]);

		const [back] = await db.sql('select name, slug, owner, description from public.addons');
		assert.deepEqual(back, { name: 'Atlas', slug: 'atlas', owner: alice.id, description: row.description });
		assert.equal((await db.sql('select * from public.addon_trash')).length, 0);
		assert.equal((await logged()).at(-1), 'addon.restore');
	});


	test('a restored addon is what was deleted: it stays nobody\'s, with its approver and its dates', async () => {
		const orphan = await post(db, alice, addon('Orphan'));
		await call(alice, 'select public.delete_account()');
		await db.queueImports([{ name: 'pfUI', url: 'https://github.com/shagu/pfUI' }]);
		const [{ id: queued }] = await db.sql('select id from public.import_queue');
		await call(admin, 'select public.approve_imports($1)', [[queued]]);
		// Both were last changed a month ago.
		await db.raw(`alter table public.addons disable trigger user;
			update public.addons set updated_at = now() - interval '30 days';
			alter table public.addons enable trigger user;`);
		const before = await db.sql('select name, owner, approved_by, updated_at from public.addons order by name');
		assert.deepEqual(before.map((r) => [r.name, r.owner, r.approved_by]), [['Orphan', null, null], ['pfUI', null, admin.id]]);

		// Another admin deletes and restores them.
		await call(admin2, 'delete from public.addons');
		for (const { id } of await db.sql('select id from public.addon_trash')) await call(admin2, 'select public.restore_addon($1)', [id]);
		assert.deepEqual(await db.sql('select name, owner, approved_by, updated_at from public.addons order by name'), before);
		assert.equal((await db.sql('select id from public.addons where name = $1', ['Orphan']))[0].id, orphan.id);

		// An approver whose account is gone is forgotten, as when they left.
		await call(admin2, 'delete from public.addons where name = $1', ['pfUI']);
		await call(admin, 'select public.delete_account()');
		const [{ id }] = await db.sql('select id from public.addon_trash');
		await call(admin2, 'select public.restore_addon($1)', [id]);
		assert.deepEqual(await db.sql('select owner, approved_by from public.addons where name = $1', ['pfUI']), [{ owner: null, approved_by: null }]);
	});

	test('an edit can be reverted from its log line', async () => {
		const row = await post(db, alice, addon('Atlas'));
		await call(admin, `update public.addons set description = 'Vandalised beyond recognition.', author = 'nobody' where id = $1`, [row.id]);
		const [{ id: logId }] = await db.sql(`select id from public.activity_log where action = 'addon.update'`);

		await refused(() => call(alice, 'select public.revert_addon($1)', [logId]), /Only admins/);
		await call(admin2, 'select public.revert_addon($1)', [logId]);
		const [after] = await db.sql('select description, author from public.addons');
		assert.deepEqual(after, { description: row.description, author: '' });
		assert.equal((await logged()).at(-1), 'addon.revert');
	});

	test('what an addon looked like before an edit is kept for 90 days; the line itself stays', async () => {
		const tidy = (token = NIGHTLY_TOKEN) => db.asVisitor((q) => q('select public.nightly_tidy($1) as n', [token]));
		const row = await post(db, alice, addon('Atlas'));
		await call(alice, `update public.addons set author = 'Old edit' where id = $1`, [row.id]);
		await db.sql(`update public.activity_log set at = at - interval '91 days'`);
		await call(alice, `update public.addons set author = 'New edit' where id = $1`, [row.id]);
		await call(alice, 'delete from public.addons where id = $1', [row.id]);
		await db.sql(`update public.addon_trash set deleted_at = deleted_at - interval '91 days'`);

		await refused(() => tidy('wrong'), /Only the nightly job/);
		await refused(() => call(admin, 'select public.nightly_tidy($1)', [NIGHTLY_TOKEN]), /permission denied/);
		assert.equal((await tidy())[0].n, 1);
		const edits = await db.sql(`select id, details from public.activity_log where action = 'addon.update' order by id`);
		assert.deepEqual(edits[0].details, { changed: ['author'] });
		assert.equal(edits[1].details.before.author, 'Old edit');
		assert.equal((await db.sql('select * from public.addon_trash')).length, 0);
		await refused(() => call(admin, 'select public.revert_addon($1)', [edits[0].id]), /too old to revert/);
	});

	test('only the owner can remove something from the trash for good', async () => {
		const row = await post(db, alice, addon('Atlas'));
		await call(admin, 'delete from public.addons where id = $1', [row.id]);
		const [{ id: trashId }] = await db.sql('select id from public.addon_trash');

		await refused(() => call(admin, 'select public.purge_trash($1)', [[trashId]]), /Only the owner/);
		await refused(() => call(admin, 'delete from public.addon_trash'));
		await call(owner, 'select public.purge_trash($1)', [[trashId]]);
		assert.equal((await db.sql('select * from public.addon_trash')).length, 0);
	});

	test('the trash is cleared of anything older than 90 days', async () => {
		const old = await post(db, alice, addon('Ancient'));
		await call(alice, 'delete from public.addons where id = $1', [old.id]);
		await db.sql(`update public.addon_trash set deleted_at = now() - interval '91 days'`);

		const recent = await post(db, alice, addon('Recent'));
		await call(alice, 'delete from public.addons where id = $1', [recent.id]);
		assert.deepEqual(await db.sql('select name from public.addon_trash'), [{ name: 'Recent' }]);
	});
});

describe('limits', () => {
	const edit = (user, row, text) => call(user, 'update public.addons set author = $1 where id = $2', [text, row.id]);
	const remove = (user, row) => call(user, 'delete from public.addons where id = $1', [row.id]);
	// Posts as the database owner, past every limit, to set a scene quickly.
	const seed = async (count, poster) => {
		await db.sql(
			`insert into public.addons (slug, name, description, category, versions, owner)
			 select 'seed' || i, 'Seed' || i, 'A description that is long enough.', 'Miscellaneous',
				jsonb_build_array(jsonb_build_object('url', 'https://github.com/seed/addon' || i, 'note', '')), $2
			 from generate_series(1, $1::int) i`,
			[count, poster.id]
		);
		return db.sql('select id from public.addons order by id');
	};

	test('reaching a limit refuses the action and suspends nobody', async () => {
		const rows = await seed(25, alice);
		for (const row of rows.slice(0, 20)) await remove(admin, row);
		await refused(() => remove(admin, rows[20]), /at most 20 addons an hour/);

		assert.equal((await live()).length, 5);
		assert.deepEqual(await role(admin), { admin: true, owner: false, banned: false });
		// An hour later it works again.
		await db.sql(`update public.activity_log set at = at - interval '2 hours'`);
		await remove(admin, rows[20]);
	});

	test('a member can make 10 edits an hour and 50 a day', async () => {
		const mine = await post(db, alice, addon('Atlas'));
		for (let i = 0; i < 10; i++) await edit(alice, mine, `Draft ${i}`);
		await refused(() => edit(alice, mine, 'One too many'), /at most 10 edits an hour/);
		// A save that changes nothing is not an edit, and is not counted or refused.
		await edit(alice, mine, 'Draft 9');
		await db.sql(`update public.activity_log set at = at - interval '2 hours' where action = 'addon.update'`);
		await edit(alice, mine, 'Next hour');

		// Spread over a day, the hourly limit is never reached but the daily one is.
		await db.sql(
			`insert into public.activity_log (actor, action, at)
			 select $1, 'addon.update', now() - interval '3 hours' from generate_series(1, 39)`,
			[alice.id]
		);
		await refused(() => edit(alice, mine, 'Too many today'), /at most 50 edits a day/);
	});

	test('an admin can make 100 edits an hour, whoever posted the addon', async () => {
		const own = await post(db, admin, addon('Mine'));
		const theirs = await post(db, alice, addon('Theirs'));
		for (let i = 0; i < 50; i++) await edit(admin, own, `Draft ${i}`);
		for (let i = 0; i < 50; i++) await edit(admin, theirs, `Draft ${i}`);
		await refused(() => edit(admin, own, 'One too many'), /at most 100 edits an hour/);
		await refused(() => edit(admin, theirs, 'One too many'), /at most 100 edits an hour/);
		assert.equal((await role(admin)).banned, false);

		// Grouping and reverting are not edits, and still work at the limit.
		await call(admin, 'select public.group_addons($1)', [[own.id, theirs.id]]);
		const [{ id }] = await db.sql(`select id from public.activity_log where action = 'addon.update' order by id limit 1`);
		await call(admin, 'select public.revert_addon($1)', [id]);
	});

	test('a member can post 10 addons a day and an admin 50; approved imports do not count', async () => {
		for (let i = 0; i < 10; i++) await post(db, alice, addon(`Addon${i}`));
		await refused(() => post(db, alice, addon('OneTooMany')), /at most 10 addons a day/);

		for (let i = 0; i < 50; i++) await post(db, admin, addon(`Admin${i}`));
		await refused(() => post(db, admin, addon('OneTooMany')), /at most 50 addons a day/);

		// Deleting one does not give the day's post back.
		await call(alice, `delete from public.addons where name = 'Addon0'`);
		await refused(() => post(db, alice, addon('OneTooMany')), /at most 10 addons a day/);

		const items = Array.from({ length: 5 }, (_, i) => ({ name: `Wiki${i}`, url: `https://github.com/wiki/addon${i}` }));
		await db.queueImports(items);
		const ids = (await db.sql('select id from public.import_queue')).map((r) => r.id);
		assert.equal((await call(admin, 'select public.approve_imports($1) as n', [ids]))[0].n, 5);
	});

	test('deleting the account and logging in again does not start the day\'s posts over', async () => {
		const identity = `insert into auth.identities (user_id, provider, provider_id) values ($1, 'discord', $2)`;
		const leave = (user) => call(user, 'select public.delete_account()');
		await db.sql(identity, [alice.id, '555']);
		for (let i = 0; i < 10; i++) await post(db, alice, addon(`Addon${i}`));
		await leave(alice);
		// Only a fingerprint is kept, and nobody can read it.
		assert.match((await db.sql('select fingerprint from public.left_posts'))[0].fingerprint, /^[0-9a-f]{64}$/);
		await refused(() => call(admin, 'select * from public.left_posts'), /permission denied/);

		// The same Discord account logs in again and gets a new account.
		const again = await db.addUser('alice');
		await db.sql(identity, [again.id, '555']);
		await refused(() => post(db, again, addon('OneTooMany')), /at most 10 addons a day/);
		// Leaving a second time changes nothing.
		await leave(again);
		const third = await db.addUser('alice');
		await db.sql(identity, [third.id, '555']);
		await refused(() => post(db, third, addon('OneTooMany')), /at most 10 addons a day/);
		assert.equal((await live()).length, 10);

		// Someone else on Discord was never affected.
		await db.sql(identity, [bob.id, '556']);
		await post(db, bob, addon('Bagnon'));

		// A day later it works again, and the next account to leave clears the notes away.
		await db.sql(`update public.left_posts set posted_at = posted_at - interval '2 days'`);
		await post(db, third, addon('NextDay'));
		await leave(bob);
		assert.deepEqual(await db.sql('select distinct posted_at > now() - interval \'1 day\' as fresh from public.left_posts'), [{ fresh: true }]);
	});

	test('the owner has no limits', async () => {
		const rows = await seed(25, alice);
		for (const row of rows) await remove(owner, row);
		assert.deepEqual(await live(), []);
		const mine = await post(db, owner, addon('Mine'));
		for (let i = 0; i < 105; i++) await edit(owner, mine, `Draft ${i}`);
		for (let i = 0; i < 55; i++) await post(db, owner, addon(`Owner${i}`));
	});
});

describe('groups', () => {
	const group = (user, ...rows) => call(user, 'select public.group_addons($1)', [rows.map((r) => r.id)]);
	// Each group as "Main + Other, Other", sorted; addons outside a group are left out.
	const groups = async () =>
		(
			await db.sql(
				`select string_agg(name, ', ' order by is_main desc, name) as members
				 from public.addons where group_id is not null group by group_id order by 1`
			)
		).map((r) => r.members);
	const mains = async () =>
		(await db.sql('select name from public.addons where is_main order by name')).map((r) => r.name);

	let original, fork, third;
	beforeEach(async () => {
		original = await post(db, alice, addon('pfUI', 'https://github.com/shagu/pfUI'));
		fork = await post(db, bob, addon('pfUI fork', 'https://github.com/brues-code/pfUI'));
		third = await post(db, bob, addon('pfUI turtle', 'https://github.com/someone/pfUI-turtle'));
	});

	test('only admins can group; the first addon becomes the main version and nothing is deleted', async () => {
		await refused(() => group(alice, original, fork), /Only admins/);
		await group(admin, original, fork);

		assert.deepEqual(await groups(), ['pfUI, pfUI fork']);
		assert.deepEqual(await mains(), ['pfUI']);
		assert.deepEqual(await live(), ['pfUI', 'pfUI fork', 'pfUI turtle']);
		assert.equal((await db.sql('select * from public.addon_trash')).length, 0);
	});

	test('nobody can put their own addon in a group or make it the main version directly', async () => {
		await group(admin, original, fork);
		await refused(() => call(bob, 'update public.addons set is_main = true where id = $1', [fork.id]));
		await refused(() => call(bob, 'update public.addons set group_id = 1 where id = $1', [third.id]));
		await refused(() => call(bob, 'select public.set_main($1)', [fork.id]), /Only admins/);
		await refused(() => call(bob, 'select public.ungroup_addon($1)', [fork.id]), /Only admins/);
	});

	test('an admin can pick a different main version', async () => {
		await group(admin, original, fork, third);
		await call(admin2, 'select public.set_main($1)', [fork.id]);
		assert.deepEqual(await groups(), ['pfUI fork, pfUI, pfUI turtle']);
	});

	test('joining an addon to a grouped one brings it into that group and keeps its main version', async () => {
		await group(admin, original, fork);
		await group(admin, fork, third);
		assert.deepEqual(await groups(), ['pfUI, pfUI fork, pfUI turtle']);
	});

	test('two groups joined become one, with a single main version', async () => {
		const other = await post(db, alice, addon('pfUI classic', 'https://github.com/x/pfUI-classic'));
		await group(admin, original, fork);
		await group(admin, third, other);
		await group(admin, original, third);
		assert.deepEqual(await groups(), ['pfUI, pfUI classic, pfUI fork, pfUI turtle']);
	});

	test('removing an addon keeps the rest together; a group of one stops being a group', async () => {
		await group(admin, original, fork, third);
		await call(admin, 'select public.ungroup_addon($1)', [third.id]);
		assert.deepEqual(await groups(), ['pfUI, pfUI fork']);

		await call(admin, 'select public.ungroup_addon($1)', [fork.id]);
		assert.deepEqual(await groups(), []);
		assert.deepEqual(await mains(), []);
	});

	test('removing or deleting the main version promotes another', async () => {
		await group(admin, original, fork, third);
		await call(admin, 'select public.ungroup_addon($1)', [original.id]);
		assert.equal((await mains()).length, 1);

		const [{ id: mainId }] = await db.sql('select id from public.addons where is_main');
		await call(admin, 'delete from public.addons where id = $1', [mainId]);
		assert.deepEqual(await groups(), []);
		assert.equal((await live()).length, 2);
	});

	test('grouping does not count as an edit: no "updated" change and no edit in the log', async () => {
		const before = await db.sql('select id, updated_at from public.addons order by id');
		await group(admin, original, fork);
		await call(admin, 'select public.set_main($1)', [fork.id]);

		assert.deepEqual(await db.sql('select id, updated_at from public.addons order by id'), before);
		assert.deepEqual((await logged()).slice(-2), ['group.add', 'group.main']);
	});

	test('a poster can suggest their addon is a version of another; an admin decides', async () => {
		await refused(() => call(alice, 'select public.suggest_group($1, $2)', [fork.id, original.id]), /you posted/);
		await call(bob, 'select public.suggest_group($1, $2)', [fork.id, original.id]);
		// Asking twice, in either direction, is still one suggestion.
		await call(bob, 'select public.suggest_group($1, $2)', [fork.id, original.id]);

		assert.deepEqual(await groups(), []);
		// The poster can follow their own suggestion; other members see nothing.
		assert.deepEqual(await call(bob, 'select status from public.group_suggestions'), [{ status: 'pending' }]);
		assert.equal((await call(alice, 'select * from public.group_suggestions')).length, 0);
		const [suggestion] = await call(admin, 'select id, kind, suggested_by_name, status from public.group_suggestions');
		assert.deepEqual(suggestion, { id: suggestion.id, kind: 'user', suggested_by_name: 'bob', status: 'pending' });

		await refused(() => call(bob, 'select public.decide_suggestion($1, true)', [suggestion.id]), /Only admins/);
		await call(admin, 'select public.decide_suggestion($1, true)', [suggestion.id]);
		// The addon that was suggested as a version joins the other one, which stays the main version.
		assert.deepEqual(await groups(), ['pfUI, pfUI fork']);
		assert.deepEqual(await call(bob, 'select status from public.group_suggestions'), [{ status: 'accepted' }]);
	});

	test('a rejected suggestion changes nothing and is not offered again', async () => {
		await call(bob, 'select public.suggest_group($1, $2)', [fork.id, original.id]);
		const [{ id }] = await db.sql('select id from public.group_suggestions');
		await call(admin, 'select public.decide_suggestion($1, false)', [id]);
		await call(bob, 'select public.suggest_group($1, $2)', [fork.id, original.id]);

		assert.deepEqual(await groups(), []);
		assert.deepEqual(await db.sql('select status from public.group_suggestions'), [{ status: 'rejected' }]);
	});

	test('an admin can turn down a pair the site spotted, and a banned member cannot suggest', async () => {
		await refused(() => call(alice, 'select public.dismiss_pair($1, $2)', [original.id, fork.id]), /Only admins/);
		await call(admin, 'select public.dismiss_pair($1, $2)', [original.id, fork.id]);
		assert.deepEqual(await db.sql('select kind, status from public.group_suggestions'), [
			{ kind: 'auto', status: 'rejected' }
		]);

		await call(admin, 'select public.set_banned($1, true)', [bob.id]);
		await refused(() => call(bob, 'select public.suggest_group($1, $2)', [third.id, original.id]), /cannot suggest/);
	});

	test('a member can make 10 suggestions a day, and a rollback withdraws the ones still waiting', async () => {
		const others = [];
		for (let i = 0; i < 11; i++) others.push(await post(db, owner, addon(`Other${i}`)));
		// Posting the addons was long ago; only the suggestions are rolled back below.
		await db.sql(`update public.activity_log set at = at - interval '5 days'`);
		const suggest = (target) => call(bob, 'select public.suggest_group($1, $2)', [fork.id, target.id]);
		for (const other of others.slice(0, 10)) await suggest(other);
		await refused(() => suggest(others[10]), /at most 10 groups a day/);
		await db.sql(`update public.activity_log set at = at - interval '2 days' where action = 'group.suggest'`);
		await suggest(others[10]);

		// One was accepted in the meantime: that was an admin's decision, and it stays.
		const [{ id }] = await db.sql('select id from public.group_suggestions where target_id = $1', [others[0].id]);
		await call(admin, 'select public.decide_suggestion($1, true)', [id]);
		const result = (await call(admin, `select public.rollback_account($1, now() - interval '3 days', false) as r`, [bob.id]))[0].r;
		assert.equal(result.steps.filter((s) => s.kind === 'withdraw').length, 10);
		assert.deepEqual(await db.sql('select status from public.group_suggestions'), [{ status: 'accepted' }]);
	});
});

describe('reports', () => {
	const report = (user, row, reason = 'broken', note = '') =>
		call(user, 'select public.report_addon($1, $2, $3)', [row.id, reason, note]);
	const open = async () =>
		(await db.sql(`select reported_by_name, reason from public.reports where status = 'open' order by id`)).map(
			(r) => `${r.reported_by_name}: ${r.reason}`
		);

	test('anyone logged in can report an addon; a visitor or a banned account cannot', async () => {
		const row = await post(db, alice, addon('Atlas'));
		await report(bob, row, 'harmful', 'The download contains an .exe');
		assert.deepEqual(await open(), ['bob: harmful']);

		await refused(() => db.asVisitor((q) => q('select public.report_addon($1, $2, $3)', [row.id, 'broken', ''])));
		await call(admin, 'select public.set_banned($1, true)', [bob.id]);
		await refused(() => report(bob, row), /logged in/);
		await refused(() => report(alice, row, 'because'));
		await refused(() => report(alice, { id: 999999 }), /no longer exists/);
	});

	test('only admins can read reports, and nobody can write them directly', async () => {
		const row = await post(db, alice, addon('Atlas'));
		await report(bob, row);
		assert.equal((await call(bob, 'select * from public.reports')).length, 0);
		assert.equal((await call(admin, 'select * from public.reports')).length, 1);
		await refused(() => db.asVisitor((q) => q('select * from public.reports')), /permission denied/);
		await refused(() => call(bob, `update public.reports set status = 'dismissed'`));
		await refused(() => call(bob, 'delete from public.reports'));
	});

	test('one open report per account per addon, and at most 10 a day', async () => {
		const rows = [];
		for (let i = 0; i < 6; i++) rows.push(await post(db, alice, addon(`Addon${i}`)));
		for (let i = 0; i < 6; i++) rows.push(await post(db, admin, addon(`More${i}`)));
		await report(bob, rows[0]);
		await report(bob, rows[0], 'harmful');
		assert.deepEqual(await open(), ['bob: broken']);

		for (const row of rows.slice(1, 10)) await report(bob, row);
		await refused(() => report(bob, rows[10]), /at most 10/);
	});

	test('an admin closes a report either way, and it can then be reported again', async () => {
		const row = await post(db, alice, addon('Atlas'));
		await report(bob, row);
		const [{ id }] = await db.sql('select id from public.reports');
		await refused(() => call(bob, 'select public.decide_report($1, $2)', [id, 'dismissed']), /Only admins/);
		await refused(() => call(admin, 'select public.decide_report($1, $2)', [id, 'deleted']), /Unknown/);
		await call(admin, 'select public.decide_report($1, $2)', [id, 'dismissed']);
		await refused(() => call(admin, 'select public.decide_report($1, $2)', [id, 'handled']), /already/);
		assert.deepEqual(await open(), []);

		await report(bob, row, 'harmful');
		assert.deepEqual(await open(), ['bob: harmful']);
		assert.deepEqual((await logged()).slice(1), ['report.create', 'report.dismiss', 'report.create']);
	});

	test('deleting an addon removes its reports', async () => {
		const row = await post(db, alice, addon('Atlas'));
		await report(bob, row);
		await call(admin, 'delete from public.addons where id = $1', [row.id]);
		assert.equal((await db.sql('select * from public.reports')).length, 0);
	});
});

describe('undoing from the log', () => {
	const group = (user, ...rows) => call(user, 'select public.group_addons($1)', [rows.map((r) => r.id)]);
	const groups = async () =>
		(
			await db.sql(
				`select string_agg(name, ', ' order by is_main desc, name) as members
				 from public.addons where group_id is not null group by group_id order by 1`
			)
		).map((r) => r.members);
	const lastLine = async (action) =>
		(await db.sql('select id, details from public.activity_log where action = $1 order by id desc limit 1', [action]))[0];
	const undo = (user, line) => call(user, 'select public.undo_grouping($1)', [line.id]);
	const restore = async (user) => {
		const [{ id }] = await db.sql('select id from public.addon_trash order by id desc limit 1');
		await call(user, 'select public.restore_addon($1)', [id]);
	};

	let atlas, fork, third;
	beforeEach(async () => {
		atlas = await post(db, alice, addon('Atlas', 'https://github.com/a/Atlas'));
		fork = await post(db, bob, addon('Atlas fork', 'https://github.com/b/Atlas'));
		third = await post(db, bob, addon('Atlas turtle', 'https://github.com/c/Atlas'));
	});

	test('a restored addon keeps its id, so its earlier edits can still be reverted', async () => {
		await call(alice, `update public.addons set author = 'Vandal' where id = $1`, [atlas.id]);
		const edit = await lastLine('addon.update');
		await call(admin, 'delete from public.addons where id = $1', [atlas.id]);
		await restore(admin);

		const [back] = await db.sql(`select id, author from public.addons where name = 'Atlas'`);
		assert.deepEqual(back, { id: atlas.id, author: 'Vandal' });
		await call(admin, 'select public.revert_addon($1)', [edit.id]);
		assert.equal((await db.sql('select author from public.addons where id = $1', [atlas.id]))[0].author, '');
		// A new addon posted meanwhile never takes the id.
		const next = await post(db, alice, addon('Another'));
		assert.ok(next.id > third.id);
	});

	test('a restored addon returns to its group, as main version if it was', async () => {
		// A group of two falls apart when one is deleted, and is whole again after a restore.
		await group(admin, atlas, fork);
		await call(admin, 'delete from public.addons where id = $1', [atlas.id]);
		assert.deepEqual(await groups(), []);
		await restore(admin);
		assert.deepEqual(await groups(), ['Atlas, Atlas fork']);

		// A larger group lives on without it, and takes it back, here as an ordinary version.
		await group(admin, atlas, third);
		await call(admin, 'delete from public.addons where id = $1', [fork.id]);
		assert.deepEqual(await groups(), ['Atlas, Atlas turtle']);
		await restore(admin);
		assert.deepEqual(await groups(), ['Atlas, Atlas fork, Atlas turtle']);
	});

	test('every group change can be undone from its log line, and the undo too', async () => {
		await group(admin, atlas, fork);
		await group(admin, atlas, third);
		await undo(admin, await lastLine('group.add'));
		assert.deepEqual(await groups(), ['Atlas, Atlas fork']);
		// Undoing the undo puts the third back.
		await undo(admin, await lastLine('group.undo'));
		assert.deepEqual(await groups(), ['Atlas, Atlas fork, Atlas turtle']);

		await call(admin, 'select public.set_main($1)', [fork.id]);
		await undo(admin, await lastLine('group.main'));
		assert.deepEqual(await groups(), ['Atlas, Atlas fork, Atlas turtle']);

		await call(admin, 'select public.ungroup_addon($1)', [atlas.id]);
		await undo(admin, await lastLine('group.remove'));
		assert.deepEqual(await groups(), ['Atlas, Atlas fork, Atlas turtle']);

		await refused(() => undo(alice, { id: 1 }), /Only admins/);
		const posted = await lastLine('addon.create');
		await refused(() => undo(admin, posted), /nothing to undo/);
	});

	test('two groups thrown together come apart again in one step', async () => {
		const other = await post(db, alice, addon('Bagnon', 'https://github.com/a/Bagnon'));
		const otherFork = await post(db, bob, addon('Bagnon fork', 'https://github.com/b/Bagnon'));
		await group(admin, atlas, fork);
		await group(admin, other, otherFork);
		await group(admin, atlas, other);
		assert.deepEqual(await groups(), ['Atlas, Atlas fork, Bagnon, Bagnon fork']);
		await undo(admin, await lastLine('group.add'));
		assert.deepEqual(await groups(), ['Atlas, Atlas fork', 'Bagnon, Bagnon fork']);

		const many = [];
		for (let i = 0; i < 21; i++) many.push({ id: 1000 + i });
		await refused(() => group(admin, ...many), /at most 20/);
	});

	test('an approved import can be sent back to the queue', async () => {
		await db.queueImports([{ name: 'pfUI', url: 'https://github.com/shagu/pfUI' }]);
		const [{ id }] = await db.sql('select id from public.import_queue');
		await call(admin, 'select public.approve_imports($1)', [[id]]);
		const [made] = await db.sql(`select id from public.addons where name = 'pfUI'`);

		await refused(() => call(alice, 'select public.unapprove_import($1)', [made.id]), /Only admins/);
		await refused(() => call(admin, 'select public.unapprove_import($1)', [atlas.id]), /did not come from the import queue/);
		await call(admin, 'select public.unapprove_import($1)', [made.id]);

		assert.ok(!(await live()).includes('pfUI'));
		assert.deepEqual(await db.sql('select status, addon_id from public.import_queue'), [{ status: 'pending', addon_id: null }]);
		assert.deepEqual((await logged()).slice(-2), ['addon.delete', 'import.requeue']);
		// And approved again, as if nothing had happened.
		assert.equal((await call(admin, 'select public.approve_imports($1) as n', [[id]]))[0].n, 1);
	});

	test('an import published with changes is logged as an approval, not as an edit', async () => {
		await db.queueImports([{ name: 'pfUI', url: 'https://github.com/shagu/pfUI' }]);
		const [{ id }] = await db.sql('select id from public.import_queue');
		const made = await post(db, admin, addon('pfUI', 'https://github.com/shagu/pfUI'));
		await call(admin, 'select public.mark_imported($1, $2, true)', [id, made.id]);
		assert.deepEqual((await logged()).slice(-2), ['addon.create', 'import.approve']);
	});

	test('emptying the trash and turning down a suggestion are logged', async () => {
		await call(admin, 'delete from public.addons where id = $1', [atlas.id]);
		const [{ id }] = await db.sql('select id from public.addon_trash');
		await call(owner, 'select public.purge_trash($1)', [[id]]);
		const purge = await db.sql(`select subject, details from public.activity_log where action = 'trash.purge'`);
		assert.deepEqual(purge, [{ subject: 'Atlas', details: { names: ['Atlas'] } }]);

		await call(bob, 'select public.suggest_group($1, $2)', [third.id, fork.id]);
		const [suggestion] = await db.sql('select id from public.group_suggestions');
		await call(admin, 'select public.decide_suggestion($1, false)', [suggestion.id]);
		assert.equal((await logged()).at(-1), 'group.decline');
	});
});

describe('rolling an account back', () => {
	const rollback = async (user, target, preview = false, since = '1 hour') =>
		(
			await call(user, `select public.rollback_account($1, now() - $2::interval, $3) as r`, [target.id, since, preview])
		)[0].r;
	const kinds = (result) => result.steps.map((s) => `${s.kind} ${s.subject}`).sort();
	const author = async (row) => (await db.sql('select author from public.addons where id = $1', [row.id]))[0]?.author;
	const backdate = () => db.sql(`update public.activity_log set at = at - interval '2 hours'`);

	test('a member is rolled back: posts trashed, edits reverted, deletes restored, reports dismissed', async () => {
		const old = await post(db, alice, addon('Old'));
		const gone = await post(db, alice, addon('Gone'));
		const victim = await post(db, bob, addon('Victim'));
		await call(alice, `update public.addons set author = 'Before' where id = $1`, [old.id]);
		await backdate();

		// The damage: two edits of the same addon, a delete, two spam posts and a false report.
		await call(alice, `update public.addons set author = 'Vandal 1' where id = $1`, [old.id]);
		await call(alice, `update public.addons set author = 'Vandal 2' where id = $1`, [old.id]);
		await call(alice, 'delete from public.addons where id = $1', [gone.id]);
		const spam = await post(db, alice, addon('SpamOne'));
		await call(alice, `update public.addons set author = 'Spammer' where id = $1`, [spam.id]);
		await post(db, alice, addon('SpamTwo'));
		await call(alice, 'select public.report_addon($1, $2, $3)', [victim.id, 'harmful', '']);

		// The preview lists what would happen, and changes nothing.
		const expected = ['delete SpamOne', 'delete SpamTwo', 'dismiss Victim', 'restore Gone', 'revert Old'];
		const before = await logged();
		assert.deepEqual(kinds(await rollback(admin, alice, true)), expected);
		assert.deepEqual(await live(), ['Old', 'SpamOne', 'SpamTwo', 'Victim']);
		assert.equal(await author(old), 'Vandal 2');
		assert.deepEqual(await logged(), before);

		const result = await rollback(admin, alice);
		assert.deepEqual(kinds(result), expected);
		assert.deepEqual(result.skipped, []);
		assert.deepEqual(await live(), ['Gone', 'Old', 'Victim']);
		// Back to before the first edit in that time, not to before every edit ever.
		assert.equal(await author(old), 'Before');
		assert.equal((await db.sql(`select count(*)::int as n from public.reports where status = 'open'`))[0].n, 0);
		assert.equal((await logged()).at(-1), 'user.rollback');
		// Done once, there is nothing left to do.
		assert.deepEqual((await rollback(admin, alice)).steps, []);
	});

	test('an admin is rolled back by the owner: edits, deletes, groups, bans and import decisions', async () => {
		const one = await post(db, alice, addon('One'));
		const two = await post(db, bob, addon('Two'));
		const three = await post(db, bob, addon('Three'));
		await db.queueImports([
			{ name: 'Wiki one', url: 'https://github.com/wiki/one' },
			{ name: 'Wiki two', url: 'https://github.com/wiki/two' }
		]);
		const queue = await db.sql('select id from public.import_queue order by id');
		await backdate();

		await call(admin2, `update public.addons set author = 'Defaced' where id = $1`, [one.id]);
		await call(admin2, 'select public.group_addons($1)', [[one.id, two.id]]);
		await call(admin2, 'delete from public.addons where id = $1', [three.id]);
		await call(admin2, 'select public.set_banned($1, true)', [bob.id]);
		await call(admin2, 'select public.approve_imports($1)', [[queue[0].id]]);
		await call(admin2, 'select public.decide_imports($1, $2)', [[queue[1].id], 'rejected']);
		// Someone else edits the defaced addon afterwards; the preview says so.
		await call(admin, `update public.addons set category = 'PvP' where id = $1`, [one.id]);

		await refused(() => rollback(admin, admin2), /Only the owner/);
		const preview = await rollback(owner, admin2, true);
		assert.equal(preview.steps.find((s) => s.kind === 'revert').others, 1);

		const result = await rollback(owner, admin2);
		assert.deepEqual(kinds(result), [
			'requeue Wiki two',
			'restore Three',
			'revert One',
			'unapprove Wiki one',
			'unban bob',
			'ungroup One'
		]);
		assert.deepEqual(await live(), ['One', 'Three', 'Two']);
		assert.equal(await author(one), '');
		assert.equal((await db.sql('select count(*)::int as n from public.addons where group_id is not null'))[0].n, 0);
		assert.equal((await role(bob)).banned, false);
		assert.deepEqual(await db.sql('select status from public.import_queue order by id'), [
			{ status: 'pending' },
			{ status: 'pending' }
		]);
	});

	test('clearing up is not held by the delete limit, and who may roll back whom follows the ban rules', async () => {
		const others = [];
		for (let i = 0; i < 16; i++) others.push(await post(db, owner, addon(`Other${i}`)));
		for (let i = 0; i < 10; i++) await post(db, alice, addon(`Spam${i}`));
		// The admin deletes twenty addons by hand, and the limit stops the twenty-first.
		for (const row of others) await call(admin, 'delete from public.addons where id = $1', [row.id]);
		for (let i = 0; i < 4; i++) await call(admin, 'delete from public.addons where name = $1', [`Spam${i}`]);
		await refused(() => call(admin, 'delete from public.addons where name = $1', ['Spam4']), /at most 20 addons an hour/);

		// The rollback clears the other six all the same.
		const result = await rollback(admin, alice);
		assert.equal(result.steps.length, 6);
		assert.deepEqual(result.skipped, []);
		assert.deepEqual(await live(), []);

		await refused(() => rollback(alice, bob), /Only admins/);
		await refused(() => rollback(admin, admin), /cannot roll yourself back/);
		await refused(() => rollback(admin, owner), /owner cannot be rolled back/);
	});
});

describe('import queue', () => {
	const candidate = (name, url = `https://github.com/wiki/${name}`, extra = {}) => ({
		name,
		url,
		description: `${name} from the wiki`,
		images: [],
		alts: [],
		category: 'Miscellaneous',
		obsolete: false,
		parent: null,
		...extra
	});
	// As the nightly job, the only one that can add to the queue.
	const queue = (items) => db.queueImports(items);
	// One of the job's calls, made by a visitor holding this token.
	const nightly = (sql, token, ...params) => db.asVisitor((q) => q(sql, [token, ...params]));
	const stats = (...rows) => JSON.stringify(rows);
	const waiting = async () =>
		(await db.sql(`select name from public.import_queue where status = 'pending' order by name`)).map((r) => r.name);

	test('only the nightly job can queue, not even an admin, and only admins can see the queue', async () => {
		// Without the token nobody can, and the token is of no use to an account.
		const cheat = JSON.stringify([candidate('Cheat')]);
		for (const user of [alice, admin, owner]) {
			await refused(() => call(user, 'select public.queue_imports($1, $2::jsonb)', ['a guess', cheat]));
			await refused(() => call(user, 'select public.queue_imports($1, $2::jsonb)', [NIGHTLY_TOKEN, cheat]), /permission denied/);
		}
		await refused(() => db.queueImports([candidate('Cheat')], 'a guess'), /Only the nightly job/);
		await refused(() => db.queueImports([candidate('Cheat')], null), /Only the nightly job/);
		assert.equal(await queue([candidate('Atlas'), candidate('Bagnon')]), 2);
		assert.equal((await call(alice, 'select * from public.import_queue')).length, 0);
		assert.equal((await call(admin, 'select * from public.import_queue')).length, 2);
	});

	test('a link that is live, or was ever queued, is not queued again', async () => {
		await post(db, alice, addon('Atlas', 'https://github.com/someone/Atlas'));
		const items = [candidate('Atlas', 'https://github.com/Someone/atlas.git'), candidate('Bagnon')];

		assert.equal(await queue(items), 1);
		assert.deepEqual(await waiting(), ['Bagnon']);
		assert.equal(await queue(items), 0);

		const [{ id }] = await db.sql('select id from public.import_queue');
		await call(admin, `select public.decide_imports($1, 'rejected')`, [[id]]);
		assert.equal(await queue(items), 0);
		assert.deepEqual(await waiting(), []);
	});

	test('approving publishes the entry as written on the wiki, with credit', async () => {
		await queue([
			candidate('pfUI', 'https://github.com/brues-code/pfUI', {
				description: 'UI',
				alts: ['https://github.com/shagu/pfUI'],
				category: 'Interface Suites'
			})
		]);
		const [{ id }] = await db.sql('select id from public.import_queue');

		await refused(() => call(alice, 'select public.approve_imports($1)', [[id]]), /Only admins/);
		assert.equal((await call(admin, 'select public.approve_imports($1) as n', [[id]]))[0].n, 1);

		const [row] = await db.sql('select name, slug, description, category, author, source, owner, approved_by, jsonb_array_length(versions) as links from public.addons');
		assert.deepEqual(row, {
			name: 'pfUI',
			slug: 'pfui',
			description: 'UI',
			category: 'Interface Suites',
			author: 'brues-code',
			source: 'Turtle WoW Wiki',
			// It belongs to nobody; who approved it is kept for the admin's profile.
			owner: null,
			approved_by: admin.id,
			links: 1
		});
		assert.deepEqual(await waiting(), []);
		assert.equal((await logged()).at(-1), 'import.approve');
	});

	test('an import belongs to nobody: only admins can change it, whoever approved it', async () => {
		await queue([candidate('Atlas')]);
		const [{ id }] = await db.sql('select id from public.import_queue');
		await call(admin, 'select public.approve_imports($1)', [[id]]);
		const [atlas] = await db.sql('select id from public.addons');
		const edit = (user) => call(user, `update public.addons set description = 'Changed by someone, at some length.' where id = $1 returning id`, [atlas.id]);
		const remove = (user) => call(user, 'delete from public.addons where id = $1 returning id', [atlas.id]);

		assert.equal((await edit(alice)).length, 0);
		assert.equal((await edit(admin2)).length, 1);
		// An edit moves it to nobody else.
		assert.deepEqual(await db.sql('select owner, approved_by from public.addons'), [{ owner: null, approved_by: admin.id }]);
		await refused(() => call(alice, 'select public.suggest_group($1, $1)', [atlas.id]));
		const mine = await post(db, alice, addon('Bagnon'));
		await refused(() => call(alice, 'select public.suggest_group($1, $2)', [atlas.id, mine.id]), /an addon you posted/);

		// The admin who approved it leaves the organization: it is not theirs to change.
		await db.storeOrgMembers([]);
		assert.equal((await edit(admin)).length, 0);
		assert.equal((await remove(admin)).length, 0);
		assert.deepEqual(await live(), ['Atlas', 'Bagnon']);
	});

	test('deleting the account that approved an import leaves the import up', async () => {
		await queue([candidate('Atlas')]);
		const [{ id }] = await db.sql('select id from public.import_queue');
		await call(admin, 'select public.approve_imports($1)', [[id]]);
		await post(db, admin, addon('Bagnon'));

		await db.sql('delete from auth.users where id = $1', [admin.id]);
		// What the account wrote itself goes with it; what it approved does not.
		assert.deepEqual(await live(), ['Atlas']);
	});

	test('an import published with changes, or restored from the trash, belongs to nobody either', async () => {
		await queue([candidate('Atlas')]);
		const [{ id }] = await db.sql('select id from public.import_queue');
		const made = await post(db, admin, addon('Atlas', 'https://github.com/wiki/Atlas'));
		await call(admin, 'select public.mark_imported($1, $2, true)', [id, made.id]);
		const owners = () => db.sql('select owner, approved_by from public.addons');
		assert.deepEqual(await owners(), [{ owner: null, approved_by: admin.id }]);

		await call(admin2, 'delete from public.addons where id = $1', [made.id]);
		const [{ id: trashId }] = await db.sql('select id from public.addon_trash');
		await call(admin2, 'select public.restore_addon($1)', [trashId]);
		assert.equal((await owners())[0].owner, null);
		// Something a member posted still comes back to that member.
		const bagnon = await post(db, alice, addon('Bagnon'));
		await call(admin, 'delete from public.addons where id = $1', [bagnon.id]);
		const [{ id: second }] = await db.sql('select id from public.addon_trash order by id desc limit 1');
		await call(admin, 'select public.restore_addon($1)', [second]);
		assert.deepEqual(await db.sql(`select owner, approved_by from public.addons where name = 'Bagnon'`), [
			{ owner: alice.id, approved_by: null }
		]);
	});

	test('the wiki\'s other versions are queued as entries of their own and grouped once published', async () => {
		await queue([
			candidate('pfUI', 'https://github.com/brues-code/pfUI'),
			candidate('pfUI', 'https://github.com/shagu/pfUI', { group_key: 'github.com/brues-code/pfui' })
		]);
		const [main, alt] = (await db.sql('select id from public.import_queue order by id')).map((r) => r.id);

		// Either order works: here the alternative goes live first.
		await call(admin, 'select public.approve_imports($1)', [[alt]]);
		assert.equal((await db.sql('select count(*)::int as n from public.addons where group_id is not null'))[0].n, 0);
		await call(admin, 'select public.approve_imports($1)', [[main]]);

		const rows = await db.sql('select repo_url, is_main from public.addons where group_id is not null order by is_main desc');
		assert.deepEqual(rows, [
			{ repo_url: 'https://github.com/brues-code/pfUI', is_main: true },
			{ repo_url: 'https://github.com/shagu/pfUI', is_main: false }
		]);
	});

	test('a queued entry can be published straight into the group of a live addon', async () => {
		const liveOne = await post(db, alice, addon('Atlas', 'https://github.com/a/Atlas'));
		await queue([candidate('Atlas', 'https://github.com/b/Atlas')]);
		const [{ id }] = await db.sql('select id from public.import_queue');

		await refused(() => call(alice, 'select public.approve_into($1, $2)', [id, liveOne.id]), /Only admins/);
		await call(admin, 'select public.approve_into($1, $2)', [id, liveOne.id]);
		const rows = await db.sql('select repo_url, is_main from public.addons order by is_main desc');
		assert.deepEqual(rows, [
			{ repo_url: 'https://github.com/a/Atlas', is_main: true },
			{ repo_url: 'https://github.com/b/Atlas', is_main: false }
		]);
	});

	test('two entries with the same name both publish, at different addresses', async () => {
		await queue([candidate('aDF', 'https://github.com/one/aDF'), candidate('aDF', 'https://github.com/two/aDF')]);
		const ids = (await db.sql('select id from public.import_queue order by id')).map((r) => r.id);
		assert.equal((await call(admin, 'select public.approve_imports($1) as n', [ids]))[0].n, 2);
		assert.deepEqual((await db.sql('select slug from public.addons order by slug')).map((r) => r.slug), ['adf', 'adf-two']);
	});

	test('an entry that cannot be published stays in the queue with the reason', async () => {
		await queue([candidate('X')]);
		const [{ id }] = await db.sql('select id from public.import_queue');
		assert.equal((await call(admin, 'select public.approve_imports($1) as n', [[id]]))[0].n, 0);
		const [row] = await db.sql('select status, problem from public.import_queue');
		assert.equal(row.status, 'pending');
		assert.match(row.problem, /name/);
	});

	test('a wiki page that lists far fewer addons than before is refused whole', async () => {
		const many = Array.from({ length: 120 }, (_, i) => candidate(`Addon${i}`));
		assert.equal(await queue(many), 120);
		// A fifth fewer is a wiki that changed; half is a page that was not read properly.
		assert.equal(await queue([...many.slice(0, 100), candidate('Newcomer')]), 1);
		await refused(() => queue([...many.slice(0, 60), candidate('Another')]), /far fewer than the 101 it listed last time/);
		assert.equal((await db.sql('select count(*)::int as n from public.import_queue'))[0].n, 121);
	});

	test('links that come and go on the wiki over time do not add up against it', async () => {
		// The page stays the same length while all of its links are replaced, three times over.
		for (let round = 0; round < 4; round++) {
			const page = Array.from({ length: 110 }, (_, i) => candidate(`Round${round}Addon${i}`));
			assert.equal(await queue(page), 110);
		}
		assert.equal((await db.sql('select count(*)::int as n from public.import_queue'))[0].n, 440);
		// Nobody can read or change the measure.
		await refused(() => call(admin, 'select * from public.wiki_listing'), /permission denied/);
	});

	test('a waiting entry takes the category the job guesses now; a decided one keeps its own', async () => {
		await queue([candidate('Atlas'), candidate('Bagnon'), candidate('Cartographer')]);
		const ids = Object.fromEntries((await db.sql('select name, id from public.import_queue')).map((r) => [r.name, r.id]));
		await call(admin, 'select public.approve_imports($1)', [[ids.Bagnon]]);
		await call(admin, `select public.decide_imports($1, 'rejected')`, [[ids.Cartographer]]);

		const again = ['Atlas', 'Bagnon', 'Cartographer'].map((name) => candidate(name, undefined, { category: 'Map & Minimap' }));
		// Nothing is new, so nothing is counted as added.
		assert.equal(await queue(again), 0);
		assert.deepEqual(await db.sql('select name, category, status from public.import_queue order by name'), [
			{ name: 'Atlas', category: 'Map & Minimap', status: 'pending' },
			{ name: 'Bagnon', category: 'Miscellaneous', status: 'approved' },
			{ name: 'Cartographer', category: 'Miscellaneous', status: 'rejected' }
		]);
		assert.deepEqual(await db.sql('select category from public.addons'), [{ category: 'Miscellaneous' }]);
	});

	test('a rejected entry can be put back, and both decisions are logged', async () => {
		await queue([candidate('Atlas')]);
		const [{ id }] = await db.sql('select id from public.import_queue');
		await refused(() => call(alice, `select public.decide_imports($1, 'rejected')`, [[id]]), /Only admins/);

		await call(admin, `select public.decide_imports($1, 'rejected')`, [[id]]);
		assert.deepEqual(await waiting(), []);
		await call(admin2, `select public.decide_imports($1, 'pending')`, [[id]]);
		assert.deepEqual(await waiting(), ['Atlas']);
		assert.deepEqual(await logged(), ['import.reject', 'import.requeue']);
	});

	test('the nightly job gets the repositories to check and stores what GitHub said about them', async () => {
		await post(db, alice, addon('Atlas', 'https://github.com/wiki/Atlas'));
		await queue([candidate('Bagnon')]);
		const [{ repos }] = await nightly('select public.nightly_repos($1) as repos', NIGHTLY_TOKEN);
		assert.deepEqual(repos, ['github.com/wiki/atlas', 'github.com/wiki/bagnon']);

		const store = 'select public.store_repo_stats($1, $2::jsonb) as n';
		const bagnon = { key: 'github.com/wiki/bagnon', stars: 5, interface: 11200, canonical: 'github.com/wiki/bagnon' };
		// A repository that is neither queued nor live is left out.
		const [{ n }] = await nightly(store, NIGHTLY_TOKEN, stats(bagnon, { key: 'github.com/someone/else', stars: 1 }));
		assert.equal(n, 1);
		await nightly(store, NIGHTLY_TOKEN, stats({ ...bagnon, stars: 6, archived: true }));
		assert.deepEqual(await call(admin, 'select key, stars, archived, missing, interface from public.repo_stats'), [
			{ key: 'github.com/wiki/bagnon', stars: 6, archived: true, missing: false, interface: 11200 }
		]);
		await refused(() => call(admin, `insert into public.repo_stats (key) values ('github.com/a/b')`));
	});

	test('the nightly token is needed for each of its calls, and cannot be read back', async () => {
		await refused(() => nightly('select public.nightly_repos($1)', 'a guess'), /Only the nightly job/);
		await refused(() => nightly('select public.store_repo_stats($1, $2::jsonb)', 'a guess', stats()), /Only the nightly job/);
		for (const read of [db.asVisitor, (work) => db.as(owner, work), db.asService]) {
			await refused(() => read((q) => q('select * from public.nightly_token')), /permission denied/);
			await refused(() => read((q) => q('select public.is_nightly($1)', [NIGHTLY_TOKEN])), /permission denied/);
		}
	});

	test('a new token replaces the old one', async () => {
		await db.sql(
			`insert into public.nightly_token (hash) values (encode(sha256('a new one'::bytea), 'hex'))
			 on conflict (id) do update set hash = excluded.hash`
		);
		await refused(() => queue([candidate('Atlas')]), /Only the nightly job/);
		assert.equal(await db.queueImports([candidate('Atlas')], 'a new one'), 1);
	});

	test('the secret key opens nothing: not the queue, the stats or the job\'s calls', async () => {
		await refused(() => db.asService((q) => q('select * from public.import_queue')), /permission denied/);
		await refused(() => db.asService((q) => q(`insert into public.repo_stats (key) values ('github.com/a/b')`)), /permission denied/);
		await refused(
			() => db.asService((q) => q('select public.queue_imports($1, $2::jsonb)', [NIGHTLY_TOKEN, '[]'])),
			/permission denied/
		);
	});

	test('repository stats are for admins: visitors and members see none', async () => {
		await db.sql(`insert into public.repo_stats (key, stars) values ('github.com/wiki/atlas', 5)`);
		await refused(() => db.asVisitor((q) => q('select * from public.repo_stats')), /permission denied/);
		assert.equal((await call(alice, 'select * from public.repo_stats')).length, 0);
		assert.equal((await call(admin, 'select * from public.repo_stats')).length, 1);
	});

	test('a repository that was renamed is not queued under its new address', async () => {
		await post(db, alice, addon('Atlas', 'https://github.com/old-owner/Atlas'));
		await db.sql(
			`insert into public.repo_stats (key, canonical) values ('github.com/old-owner/atlas', 'github.com/new-owner/atlas')`
		);
		assert.equal(await queue([candidate('Atlas', 'https://github.com/new-owner/Atlas')]), 0);
	});
});
