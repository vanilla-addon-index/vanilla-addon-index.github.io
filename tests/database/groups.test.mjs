import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { addon, post } from '../helpers/db.mjs';
import { createRulesContext } from '../helpers/rules-context.mjs';

let db, owner, admin, admin2, alice, bob, refused, call, live, logged;
beforeEach(async () => {
	({ db, owner, admin, admin2, alice, bob, refused, call, live, logged } = await createRulesContext());
});
afterEach(() => db.close());

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
