import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { PUBLIC_ADDON_COLUMNS } from '../../src/lib/config.ts';
import { NIGHTLY_TOKEN, addon, post } from '../helpers/db.mjs';
import { createRulesContext } from '../helpers/rules-context.mjs';
import { askForge, forgePlace } from '../../src/lib/forges.ts';

let db, admin, alice, bob, refused, call, logged;
beforeEach(async () => {
	({ db, admin, alice, bob, refused, call, logged } = await createRulesContext());
});
afterEach(() => db.close());

describe('public code update dates', () => {
	const storeDates = (updates, token = NIGHTLY_TOKEN) => db.asVisitor((q) =>
		q('select public.store_code_updates($1, $2::jsonb) as n', [token, JSON.stringify(updates)])
	);
	const metadata = async (id) => (await db.asVisitor((q) => q(
		`select code_update, updated_at::text as stamp from public.addons where id = $1`, [id]
	)))[0];

	test('OctoWoW fetched dates save alongside GitHub dates and reach public link facts', async () => {
		const url = 'https://octowow.st/git/Ade/AdeAlts';
		const octo = await post(db, alice, addon('AdeAlts', url));
		const github = await post(db, bob, addon('Atlas'));
		const date = '2026-10-14T12:30:33Z';
		const facts = await askForge(forgePlace(url), async (endpoint) => {
			if (endpoint.endsWith('/Ade/AdeAlts')) return {status:200, body:{id:154, full_name:'Ade/AdeAlts', default_branch:'main'}};
			if (endpoint.includes('/commits?')) return {status:200, body:[{commit:{committer:{date}}}]};
			return null;
		});
		assert.ok(facts.code_update);
		const update = {url, date:facts.code_update.date, history_url:facts.code_update.url};
		assert.equal((await storeDates([update, {url:github.repo_url, date, history_url:github.repo_url + '/commits/HEAD'}]))[0].n, 2);
		const snapshot = (await metadata(octo.id)).code_update;
		assert.equal(Date.parse(snapshot.date), Date.parse(date));
		assert.equal(snapshot.url, url + '/commits/branch/main');
		assert.ok((await metadata(github.id)).code_update);
		for (const history_url of ['https://octowow.st/forum/commits', 'https://octowow.st/git.evil/commits', 'https://octowow.st.evil/git/commits', 'http://octowow.st/git/Ade/AdeAlts']) {
			await assert.rejects(storeDates([{...update, history_url}]), /repo_code_updates_history_url_check/);
		}
	});

	test('successful checks reach the public snapshot without adding listing edits to History', async () => {
		const row = await post(db, alice, addon('Atlas'));
		const before = await metadata(row.id);
		const history = await logged();
		const date = { url: row.repo_url, date: '2024-06-14T14:00:48Z', history_url: row.repo_url + '/commits/HEAD' };
		await refused(() => storeDates([date], 'wrong'), /Only the nightly job/);
		assert.equal((await storeDates([date]))[0].n, 1);
		const after = await metadata(row.id);
		assert.equal(Date.parse(after.code_update.date), Date.parse(date.date));
		assert.equal(after.code_update.url, date.history_url);
		assert.notEqual(after.stamp, before.stamp);
		assert.deepEqual(await logged(), history);
		const [snapshot] = await db.asVisitor((q) => q(`select ${PUBLIC_ADDON_COLUMNS} from public.addons`));
		assert.deepEqual(JSON.parse(JSON.stringify(snapshot)).code_update, after.code_update);
		await refused(() => db.asVisitor((q) => q('select * from public.repo_code_updates')));
		await refused(() => call(alice, 'select * from public.repo_code_updates'));

		// A failed or partial check leaves the last known date and freshness stamp intact.
		await storeDates([]);
		await storeDates([{ ...date, date: null }]);
		await storeDates([date]);
		assert.deepEqual(await metadata(row.id), after);
	});

	test('dates follow the primary link, with separate dates for branches, mirrors and forks', async () => {
		const url = 'https://github.com/a/Atlas/tree/vanilla/Atlas';
		const other = 'https://github.com/a/Atlas/tree/main/Atlas';
		const mirror = 'https://gitlab.com/a/Atlas';
		const row = await post(db, admin, { ...addon('Atlas', url), versions: [{ url, note: '' }, { url: mirror, note: '' }] });
		const fork = await post(db, bob, addon('Atlas fork', 'https://github.com/b/Atlas'));
		const date = (link, year) => ({ url: link, date: `${year}-01-01T00:00:00Z`, history_url: link.split('/tree/')[0] + '/commits/HEAD' });
		await storeDates([date(url, 2020), date(mirror, 2026), date(fork.repo_url, 2023)]);
		assert.equal(new Date((await metadata(row.id)).code_update.date).getUTCFullYear(), 2026);
		assert.equal(new Date((await metadata(fork.id)).code_update.date).getUTCFullYear(), 2023);
		await call(admin, 'update public.addons set versions = $1::jsonb where id = $2', [JSON.stringify([{ url: other, note: '' }]), row.id]);
		assert.equal((await metadata(row.id)).code_update, null);
		await storeDates([date(other, 2022)]);
		assert.equal(new Date((await metadata(row.id)).code_update.date).getUTCFullYear(), 2022);
	});

	test('clients cannot invent a date, and an import inherits a previously checked date', async () => {
		const row = await post(db, alice, addon('Atlas'));
		await refused(() => call(alice, 'update public.addons set code_update = $1::jsonb where id = $2', [JSON.stringify({ date: '2099-01-01', url: 'https://github.com/a/Atlas' }), row.id]));
		assert.equal((await metadata(row.id)).code_update, null);
		await db.queueImports([{ name: 'pfUI', url: 'https://github.com/shagu/pfUI' }]);
		await storeDates([{ url: 'https://github.com/shagu/pfUI', date: '2023-01-01T00:00:00Z', history_url: 'https://github.com/shagu/pfUI/commits/HEAD' }]);
		const [{ id }] = await db.sql('select id from public.import_queue');
		await call(admin, 'select public.approve_imports($1)', [[id]]);
		const [made] = await db.sql(`select id from public.addons where name = 'pfUI'`);
		assert.equal(new Date((await metadata(made.id)).code_update.date).getUTCFullYear(), 2023);
		assert.equal((await storeDates([{ url: 'https://github.com/unknown/repo', date: '2023-01-01', history_url: 'https://github.com/unknown/repo/commits/HEAD' }]))[0].n, 0);
	});
});
