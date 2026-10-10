// What each kind of account may and may not do, checked against the real database rules.
//
//   npm test
//
// Every test gets its own throwaway database with dummy accounts; see db.mjs.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { addon, createDb, post } from './db.mjs';

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
		assert.deepEqual(await db.asVisitor((q) => q(poster)), [{ username: null }]);
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

	test('role and ban flags cannot be read from the profiles table', async () => {
		await refused(() => call(alice, 'select banned from public.profiles'));
		await refused(() => call(alice, 'select is_owner from public.profiles'));
		await refused(() => call(admin, 'select is_owner from public.profiles'));
		await refused(() => db.asVisitor((q) => q('select * from public.profiles')));
	});

	test('an admin who leaves the organization loses admin rights', async () => {
		await db.sql(`update extensions.fake_github set members = '[]'`);
		await db.sql(`update public.org_cache set checked_at = 'epoch'`);
		assert.equal((await role(admin)).admin, false);
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

		await call(alice, `update public.addons set summary = 'Maps' where id = $1`, [mine.id]);
		const touched = await call(alice, `update public.addons set summary = 'Hacked' where id = $1 returning id`, [
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

	test('a member can post at most 10 addons a day; an admin has no limit', async () => {
		for (let i = 0; i < 10; i++) await post(db, alice, addon(`Addon${i}`));
		await refused(() => post(db, alice, addon('OneTooMany')), /at most 10 addons a day/);
		for (let i = 0; i < 12; i++) await post(db, admin, addon(`Admin${i}`));
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

	test('a link that is already listed is refused, however it is spelled', async () => {
		await post(db, alice, addon('pfQuest', 'https://github.com/shagu/pfQuest'));
		await refused(
			() => post(db, bob, addon('pfQuest copy', 'https://github.com/Shagu/pfquest.git')),
			/already listed under "pfQuest"/
		);
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
		await call(admin, 'select public.set_banned($1, true, false)', [alice.id]);

		assert.equal((await role(alice)).banned, true);
		assert.equal((await call(alice, 'select name from public.addons')).length, 1);
		await refused(() => post(db, alice, addon('Another')));
		assert.equal((await call(alice, `update public.addons set summary = 'x' where id = $1 returning id`, [mine.id])).length, 0);
		assert.equal((await call(alice, 'delete from public.addons where id = $1 returning id', [mine.id])).length, 0);

		await call(admin, 'select public.set_banned($1, false, false)', [alice.id]);
		await post(db, alice, addon('Another'));
	});

	test('a member cannot ban anyone', async () => {
		await refused(() => call(alice, 'select public.set_banned($1, true, false)', [bob.id]), /Only admins/);
	});

	test('an admin cannot suspend another admin; the owner can', async () => {
		await refused(() => call(admin, 'select public.set_banned($1, true, false)', [admin2.id]), /Only the owner/);
		await call(owner, 'select public.set_banned($1, true, false)', [admin2.id]);
		assert.deepEqual(await role(admin2), { admin: false, owner: false, banned: true });
	});

	test('a suspended admin can no longer use admin powers', async () => {
		const theirs = await post(db, alice, addon('Atlas'));
		await call(owner, 'select public.set_banned($1, true, false)', [admin.id]);
		assert.equal((await call(admin, 'delete from public.addons where id = $1 returning id', [theirs.id])).length, 0);
		await refused(() => call(admin, 'select public.set_banned($1, true, false)', [bob.id]), /Only admins/);
		assert.equal((await call(admin, 'select * from public.activity_log')).length, 0);
	});

	test('nobody can ban the owner, and nobody can ban themselves', async () => {
		await refused(() => call(admin, 'select public.set_banned($1, true, false)', [owner.id]), /owner cannot be banned/);
		await refused(() => call(owner, 'select public.set_banned($1, true, false)', [owner.id]), /cannot ban yourself/);
	});

	test('banning with "trash their addons" moves everything they posted to the trash', async () => {
		await post(db, alice, addon('Atlas'));
		await post(db, alice, addon('Bagnon'));
		await post(db, bob, addon('Cartographer'));
		await call(admin, 'select public.set_banned($1, true, true)', [alice.id]);

		assert.deepEqual(await live(), ['Cartographer']);
		const trash = await db.sql('select name, reason from public.addon_trash order by name');
		assert.deepEqual(trash, [
			{ name: 'Atlas', reason: 'ban' },
			{ name: 'Bagnon', reason: 'ban' }
		]);
	});
});

describe('log, trash and undo', () => {
	test('every change is logged with who did it', async () => {
		const row = await post(db, alice, addon('Atlas'));
		await call(admin, `update public.addons set summary = 'Maps' where id = $1`, [row.id]);
		await call(admin, 'delete from public.addons where id = $1', [row.id]);

		const [edit] = await db.sql(`select details from public.activity_log where action = 'addon.update'`);
		assert.deepEqual(edit.details.changed, ['summary']);
		assert.equal(edit.details.before.summary, '');
		assert.deepEqual(edit.details.after, { summary: 'Maps' });

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

describe('the brake', () => {
	test('an admin who deletes more than 20 addons in an hour is suspended and stopped', async () => {
		const posters = [alice, bob, owner];
		const rows = [];
		for (let i = 0; i < 25; i++) rows.push(await post(db, posters[i % 3], addon(`Addon${i}`)));

		for (const row of rows) await call(admin, 'delete from public.addons where id = $1', [row.id]);

		assert.equal((await live()).length, 5);
		assert.deepEqual(await role(admin), { admin: false, owner: false, banned: true });
		assert.ok((await logged()).includes('user.autosuspend'));
	});

	test('an admin who rewrites more than 100 addons posted by others in an hour is suspended', async () => {
		const row = await post(db, alice, addon('Atlas'));
		for (let i = 0; i < 105; i++) {
			await call(admin, 'update public.addons set summary = $1 where id = $2', [`Defaced ${i}`, row.id]);
		}
		assert.deepEqual(await role(admin), { admin: false, owner: false, banned: true });
		assert.equal((await db.sql('select summary from public.addons'))[0].summary, 'Defaced 99');
	});

	test('editing your own addons never trips the brake', async () => {
		const row = await post(db, admin, addon('Mine'));
		for (let i = 0; i < 105; i++) {
			await call(admin, 'update public.addons set summary = $1 where id = $2', [`Draft ${i}`, row.id]);
		}
		assert.equal((await role(admin)).banned, false);
	});

	test('the owner is not subject to the brake', async () => {
		const rows = [];
		for (let i = 0; i < 25; i++) rows.push(await post(db, [alice, bob, admin][i % 3], addon(`Addon${i}`)));
		for (const row of rows) await call(owner, 'delete from public.addons where id = $1', [row.id]);
		assert.deepEqual(await live(), []);
		assert.equal((await role(owner)).banned, false);
	});

	test('banning a member and trashing their addons does not count against the admin', async () => {
		for (let i = 0; i < 10; i++) await post(db, alice, addon(`Spam${i}`));
		const others = [];
		for (let i = 0; i < 15; i++) others.push(await post(db, owner, addon(`Other${i}`)));

		// Ten addons go to the trash with the ban, then fifteen ordinary deletes: 25 in all,
		// but only the fifteen count towards the limit of 20.
		await call(admin, 'select public.set_banned($1, true, true)', [alice.id]);
		for (const row of others) await call(admin, 'delete from public.addons where id = $1', [row.id]);

		assert.deepEqual(await live(), []);
		assert.equal((await role(admin)).banned, false);
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
		assert.equal((await call(bob, 'select * from public.group_suggestions')).length, 0);
		const [suggestion] = await call(admin, 'select id, kind, suggested_by_name, status from public.group_suggestions');
		assert.deepEqual(suggestion, { id: suggestion.id, kind: 'user', suggested_by_name: 'bob', status: 'pending' });

		await refused(() => call(bob, 'select public.decide_suggestion($1, true)', [suggestion.id]), /Only admins/);
		await call(admin, 'select public.decide_suggestion($1, true)', [suggestion.id]);
		// The addon that was suggested as a version joins the other one, which stays the main version.
		assert.deepEqual(await groups(), ['pfUI, pfUI fork']);
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

		await call(admin, 'select public.set_banned($1, true, false)', [bob.id]);
		await refused(() => call(bob, 'select public.suggest_group($1, $2)', [third.id, original.id]), /cannot suggest/);
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
	const queue = (user, items) =>
		call(user, 'select public.queue_imports($1::jsonb) as added', [JSON.stringify(items)]).then((r) => r[0].added);
	const waiting = async () =>
		(await db.sql(`select name from public.import_queue where status = 'pending' order by name`)).map((r) => r.name);

	test('only admins and the nightly job can queue, and only admins can see the queue', async () => {
		await refused(() => queue(alice, [candidate('Atlas')]), /Only admins/);
		assert.equal(await queue(admin, [candidate('Atlas')]), 1);
		assert.equal(
			await db.asService((q) => q('select public.queue_imports($1::jsonb) as added', [JSON.stringify([candidate('Bagnon')])])).then((r) => r[0].added),
			1
		);
		assert.equal((await call(alice, 'select * from public.import_queue')).length, 0);
		assert.equal((await call(admin, 'select * from public.import_queue')).length, 2);
	});

	test('a link that is live, or was ever queued, is not queued again', async () => {
		await post(db, alice, addon('Atlas', 'https://github.com/someone/Atlas'));
		const items = [candidate('Atlas', 'https://github.com/Someone/atlas.git'), candidate('Bagnon')];

		assert.equal(await queue(admin, items), 1);
		assert.deepEqual(await waiting(), ['Bagnon']);
		assert.equal(await queue(admin, items), 0);

		const [{ id }] = await db.sql('select id from public.import_queue');
		await call(admin, `select public.decide_imports($1, 'rejected')`, [[id]]);
		assert.equal(await queue(admin, items), 0);
		assert.deepEqual(await waiting(), []);
	});

	test('approving publishes the entry as written on the wiki, with credit', async () => {
		await queue(admin, [
			candidate('pfUI', 'https://github.com/brues-code/pfUI', {
				description: 'UI',
				alts: ['https://github.com/shagu/pfUI'],
				category: 'Interface Suites'
			})
		]);
		const [{ id }] = await db.sql('select id from public.import_queue');

		await refused(() => call(alice, 'select public.approve_imports($1)', [[id]]), /Only admins/);
		assert.equal((await call(admin, 'select public.approve_imports($1) as n', [[id]]))[0].n, 1);

		const [row] = await db.sql('select name, slug, description, category, author, source, owner, jsonb_array_length(versions) as links from public.addons');
		assert.deepEqual(row, {
			name: 'pfUI',
			slug: 'pfui',
			description: 'UI',
			category: 'Interface Suites',
			author: 'brues-code',
			source: 'Turtle WoW Wiki',
			owner: admin.id,
			links: 1
		});
		assert.deepEqual(await waiting(), []);
		assert.equal((await logged()).at(-1), 'import.approve');
	});

	test('the wiki\'s other versions are queued as entries of their own and grouped once published', async () => {
		await queue(admin, [
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
		await queue(admin, [candidate('Atlas', 'https://github.com/b/Atlas')]);
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
		await queue(admin, [candidate('aDF', 'https://github.com/one/aDF'), candidate('aDF', 'https://github.com/two/aDF')]);
		const ids = (await db.sql('select id from public.import_queue order by id')).map((r) => r.id);
		assert.equal((await call(admin, 'select public.approve_imports($1) as n', [ids]))[0].n, 2);
		assert.deepEqual((await db.sql('select slug from public.addons order by slug')).map((r) => r.slug), ['adf', 'adf-2']);
	});

	test('an entry that cannot be published stays in the queue with the reason', async () => {
		await queue(admin, [candidate('X')]);
		const [{ id }] = await db.sql('select id from public.import_queue');
		assert.equal((await call(admin, 'select public.approve_imports($1) as n', [[id]]))[0].n, 0);
		const [row] = await db.sql('select status, problem from public.import_queue');
		assert.equal(row.status, 'pending');
		assert.match(row.problem, /name/);
	});

	test('a rejected entry can be put back, and both decisions are logged', async () => {
		await queue(admin, [candidate('Atlas')]);
		const [{ id }] = await db.sql('select id from public.import_queue');
		await refused(() => call(alice, `select public.decide_imports($1, 'rejected')`, [[id]]), /Only admins/);

		await call(admin, `select public.decide_imports($1, 'rejected')`, [[id]]);
		assert.deepEqual(await waiting(), []);
		await call(admin2, `select public.decide_imports($1, 'pending')`, [[id]]);
		assert.deepEqual(await waiting(), ['Atlas']);
		assert.deepEqual(await logged(), ['import.reject', 'import.requeue']);
	});

	test('the nightly job can read what it needs and store repository stats', async () => {
		await post(db, alice, addon('Atlas'));
		await queue(admin, [candidate('Bagnon')]);
		await db.asService(async (q) => {
			assert.equal((await q(`select key from public.import_queue where status = 'pending'`)).length, 1);
			assert.equal((await q('select link_keys from public.addons')).length, 1);
			await q(
				`insert into public.repo_stats (key, stars, interface, canonical) values ('github.com/wiki/bagnon', 5, 11200, 'github.com/wiki/bagnon')
				 on conflict (key) do update set stars = excluded.stars`
			);
		});
		assert.equal((await db.asVisitor((q) => q('select stars from public.repo_stats')))[0].stars, 5);
		await refused(() => call(admin, `insert into public.repo_stats (key) values ('github.com/a/b')`));
	});

	test('a repository that was renamed is not queued under its new address', async () => {
		await post(db, alice, addon('Atlas', 'https://github.com/old-owner/Atlas'));
		await db.sql(
			`insert into public.repo_stats (key, canonical) values ('github.com/old-owner/atlas', 'github.com/new-owner/atlas')`
		);
		assert.equal(await queue(admin, [candidate('Atlas', 'https://github.com/new-owner/Atlas')]), 0);
	});
});
