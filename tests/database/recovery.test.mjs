import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { NIGHTLY_TOKEN, addon, post } from '../helpers/db.mjs';
import { createRulesContext } from '../helpers/rules-context.mjs';

let db, owner, admin, admin2, alice, bob, refused, call, live, logged, role;
beforeEach(async () => {
	({ db, owner, admin, admin2, alice, bob, refused, call, live, logged, role } = await createRulesContext());
});
afterEach(() => db.close());

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
