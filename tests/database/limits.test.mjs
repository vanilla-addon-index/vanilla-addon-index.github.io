import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { addon, post } from '../helpers/db.mjs';
import { createRulesContext } from '../helpers/rules-context.mjs';

let db, owner, admin, alice, bob, refused, call, live, role;
beforeEach(async () => {
	({ db, owner, admin, alice, bob, refused, call, live, role } = await createRulesContext());
});
afterEach(() => db.close());

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

	test('an admin can make 30 edits an hour, whoever posted the addon', async () => {
		const own = await post(db, admin, addon('Mine'));
		const theirs = await post(db, alice, addon('Theirs'));
		for (let i = 0; i < 15; i++) await edit(admin, own, `Draft ${i}`);
		for (let i = 0; i < 15; i++) await edit(admin, theirs, `Draft ${i}`);
		await refused(() => edit(admin, own, 'One too many'), /at most 30 edits an hour/);
		await refused(() => edit(admin, theirs, 'One too many'), /at most 30 edits an hour/);
		assert.equal((await role(admin)).banned, false);

		// Grouping still works, but manual reverts share the edit budget.
		await call(admin, 'select public.group_addons($1)', [[own.id, theirs.id]]);
		const [{ id }] = await db.sql(`select id from public.activity_log where action = 'addon.update' order by id limit 1`);
		await refused(() => call(admin, 'select public.revert_addon($1)', [id]), /at most 30 edits an hour/);
	});

	test('alternating History reverts exhaust the same budget as ordinary edits', async () => {
		const row = await post(db, alice, addon('RevertVictim'));
		await edit(alice, row, 'Changed');
		const latest = async () => (await db.sql("select id from public.activity_log where addon_id=$1 and action in ('addon.update','addon.revert') order by id desc limit 1", [row.id]))[0].id;
		for (let i = 0; i < 30; i++) await call(admin, 'select public.revert_addon($1)', [await latest()]);
		const before = await db.sql('select author from public.addons where id=$1', [row.id]);
		const logId = await latest();
		await refused(() => call(admin, 'select public.revert_addon($1)', [logId]), /at most 30 edits an hour/);
		await refused(() => edit(admin, row, 'Ordinary edit'), /at most 30 edits an hour/);
		assert.deepEqual(await db.sql('select author from public.addons where id=$1', [row.id]), before);
		assert.equal((await db.sql("select count(*)::int as n from public.activity_log where actor=$1 and action='addon.revert'", [admin.id]))[0].n, 30);
		// The owner can still recover the page at another admin's limit.
		await call(owner, 'select public.revert_addon($1)', [logId]);
		await db.sql("update public.activity_log set at=at-interval '2 hours' where actor=$1", [admin.id]);
		await call(admin, 'select public.revert_addon($1)', [await latest()]);
	});

	test('a no-op revert works at the limit without spending budget or adding history', async () => {
		const row = await post(db, alice, addon('NoOpRevert'));
		await edit(alice, row, 'Changed');
		const [{ id }] = await db.sql("select id from public.activity_log where action='addon.update'");
		await call(admin, 'select public.revert_addon($1)', [id]);
		await db.sql("insert into public.activity_log(actor,action) select $1,'addon.update' from generate_series(1,29)", [admin.id]);
		const before = await db.sql('select count(*)::int as n from public.activity_log');
		await call(admin, 'select public.revert_addon($1)', [id]);
		assert.deepEqual(await db.sql('select count(*)::int as n from public.activity_log'), before);
	});

	test('admins share a rolling 90-per-day budget across edits and reverts', async () => {
		const row = await post(db, alice, addon('DailyReverts'));
		await edit(alice, row, 'Changed');
		const latest = async () => (await db.sql("select id from public.activity_log where addon_id=$1 and action in ('addon.update','addon.revert') order by id desc limit 1", [row.id]))[0].id;
		// Three full hourly allowances fit within the daily allowance.
		for (let hour = 0; hour < 3; hour++) {
			for (let i = 0; i < 30; i++) {
				if (i % 2 === 0) await edit(admin, row, `Hour ${hour} edit ${i}`);
				else await call(admin, 'select public.revert_addon($1)', [await latest()]);
			}
			await db.sql("update public.activity_log set at=at-interval '2 hours' where actor=$1", [admin.id]);
		}
		const logId = await latest();
		const before = await db.sql('select author from public.addons where id=$1', [row.id]);
		await refused(() => edit(admin, row, 'One too many today'), /at most 90 edits a day/);
		await refused(() => call(admin, 'select public.revert_addon($1)', [logId]), /at most 90 edits a day/);
		assert.deepEqual(await db.sql('select author from public.addons where id=$1', [row.id]), before);
		// Saving the same content and repeating an already-applied revert stay free.
		await edit(admin, row, before[0].author);
		const [{ id: applied }] = await db.sql("select id from public.activity_log where addon_id=$1 and action='addon.update' order by id desc limit 1", [row.id]);
		await call(admin, 'select public.revert_addon($1)', [applied]);
		assert.equal((await db.sql("select count(*)::int as n from public.activity_log where actor=$1 and action in ('addon.update','addon.revert')", [admin.id]))[0].n, 90);
		assert.equal((await role(admin)).banned, false);
		await call(owner, 'select public.revert_addon($1)', [logId]);
		// Once older activity leaves the rolling day, the allowance becomes available.
		await db.sql("update public.activity_log set at=at-interval '25 hours' where actor=$1", [admin.id]);
		await edit(admin, row, 'Available again');
	});

	test('pin-only edits and their History reverts consume the edit budget', async () => {
		const row = await post(db, admin, addon('PinnedRevert'));
		const url = row.versions[0].url;
		await db.sql("insert into public.activity_log(actor,action) select $1,'addon.revert' from generate_series(1,29)", [admin.id]);
		await call(admin, 'select public.pin_addon_link($1,$2)', [row.id, url]);
		const [{ id }] = await db.sql("select id from public.activity_log where addon_id=$1 and action='addon.update' order by id desc limit 1", [row.id]);
		await refused(() => call(admin, 'select public.revert_addon($1)', [id]), /at most 30 edits an hour/);
		await refused(() => call(admin, 'select public.pin_addon_link($1,null)', [row.id]), /at most 30 edits an hour/);
		await call(admin, 'select public.pin_addon_link($1,$2)', [row.id, url]);
		assert.equal((await db.sql('select pinned_link from public.addons where id=$1', [row.id]))[0].pinned_link,url);
	});

	test('restoring a contributor link through History is limited before changing provenance', async () => {
		const row = await post(db, alice, addon('RemovedLinkRevert'));
		const url = 'https://github.com/bob/RemovedLinkRevert';
		const [{ id: request }] = await call(bob, 'select public.request_addon_link($1,$2) as id', [row.id,url]);
		await call(admin, 'select public.decide_addon_link($1,true)', [request]);
		await call(bob, 'select public.remove_own_addon_link($1,$2)', [row.id,url]);
		const [{ id }] = await db.sql("select id from public.activity_log where details ? 'removed_links' order by id desc limit 1");
		await db.sql("insert into public.activity_log(actor,action) select $1,'addon.revert' from generate_series(1,30)", [admin.id]);
		const before = await db.sql('select versions from public.addons where id=$1', [row.id]);
		await refused(() => call(admin, 'select public.revert_addon($1)', [id]), /at most 30 edits an hour/);
		assert.deepEqual(await db.sql('select versions from public.addons where id=$1', [row.id]),before);
		assert.equal((await db.sql('select url from public.addon_link_contributions where url=$1', [url])).length,0);
		await call(owner, 'select public.revert_addon($1)', [id]);
		assert.equal((await db.sql('select submitted_by from public.addon_link_contributions where url=$1', [url]))[0].submitted_by,bob.id);
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
		const [{ id }] = await db.sql("select id from public.activity_log where addon_id=$1 and action='addon.update' order by id limit 1", [mine.id]);
		await call(owner, 'select public.revert_addon($1)', [id]);
		for (let i = 0; i < 55; i++) await post(db, owner, addon(`Owner${i}`));
	});
});
