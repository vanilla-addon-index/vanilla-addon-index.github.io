import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { NIGHTLY_TOKEN, addon, post } from '../helpers/db.mjs';
import { createRulesContext } from '../helpers/rules-context.mjs';

let db, admin, alice, bob, refused, call, logged;
beforeEach(async () => {
	({ db, admin, alice, bob, refused, call, logged } = await createRulesContext());
});
afterEach(() => db.close());

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

	test('the nightly job is told how much is waiting for an admin, and nothing more', async () => {
		const waiting = async (token = NIGHTLY_TOKEN) => (await db.asVisitor((q) => q('select public.nightly_waiting($1) as w', [token])))[0].w;
		assert.deepEqual(await waiting(), { reports: 0, suggestions: 0, imports: 0 });
		const atlas = await post(db, bob, addon('Atlas'));
		assert.deepEqual(await waiting(), { reports: 0, suggestions: 0, imports: 0 });
		await report(alice, atlas);
		await report(bob, atlas, 'harmful');
		const mine = await post(db, alice, addon('Fork'));
		await call(alice, 'select public.suggest_group($1, $2)', [mine.id, atlas.id]);
		assert.deepEqual(await waiting(), { reports: 2, suggestions: 1, imports: 0 });
		// A new addon is nothing an admin has to act on, and a closed report no longer waits.
		const [{ id }] = await db.sql('select id from public.reports order by id limit 1');
		await call(admin, `select public.decide_report($1, 'dismissed')`, [id]);
		assert.deepEqual(await waiting(), { reports: 1, suggestions: 1, imports: 0 });
		await db.sql("insert into public.import_queue(key,url,name,status) values ('github.com/a/new','https://github.com/a/new','New','pending'),('github.com/a/dead','https://github.com/a/dead','Dead','dead'),('github.com/a/rejected','https://github.com/a/rejected','Rejected','rejected')");
		assert.deepEqual(await waiting(), { reports: 1, suggestions: 1, imports: 1 });
		await refused(() => waiting('a guess'), /Only the nightly job/);
		await refused(() => call(admin, 'select public.nightly_waiting($1)', [NIGHTLY_TOKEN]), /permission denied/);
	});

	test('deleting an addon removes its reports', async () => {
		const row = await post(db, alice, addon('Atlas'));
		await report(bob, row);
		await call(admin, 'delete from public.addons where id = $1', [row.id]);
		assert.equal((await db.sql('select * from public.reports')).length, 0);
	});
});
