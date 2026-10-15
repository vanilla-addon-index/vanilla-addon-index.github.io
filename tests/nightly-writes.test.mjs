import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {afterEach, beforeEach, test} from 'node:test';
import {NIGHTLY_TOKEN, addon, createDb, post} from './db.mjs';

let db, member, admin, url, key;
beforeEach(async () => {
	db = await createDb();
	member = await db.addUser('writer');
	admin = await db.addUser('reviewer', 'admin');
	const row = await post(db, member, addon('Atlas'));
	url = row.repo_url;
	key = (await db.sql('select public.link_key($1) as key', [url]))[0].key;
});
afterEach(() => db.close());
const facts = (extra = {}) => ({key, stars:5, pushed_at:null, archived:false, fork_of:null, missing:false, interface:11200, canonical:key, ...extra});
const store = (rows, token = NIGHTLY_TOKEN) => db.asVisitor((q) => q('select public.store_repo_stats($1, $2::jsonb, true) as report', [token, JSON.stringify(rows)]));
const cache = (items) => db.asVisitor((q) => q('select public.store_repo_check_cache($1, $2::jsonb) as n', [NIGHTLY_TOKEN, JSON.stringify(items)]));
const prune = (token = NIGHTLY_TOKEN) => db.asVisitor((q) => q('select public.prune_repo_check_cache($1) as n', [token]));

test('unchanged checks update only narrow bookkeeping while the admin checked_at remains current', async () => {
	assert.deepEqual((await store([facts()]))[0].report, {accepted:1, facts_written:1, facts_unchanged:0, checks_written:1});
	await db.sql("update public.repo_stats set checked_at = '2000-01-01'");
	await db.sql("update public.repo_stats_checks set checked_at = '2000-01-01'");
	const before = (await db.sql('select ctid::text as tuple, checked_at from public.repo_stats'))[0];
	const report = (await store([facts()]))[0].report;
	assert.deepEqual(report, {accepted:1, facts_written:0, facts_unchanged:1, checks_written:1});
	assert.deepEqual((await db.sql('select ctid::text as tuple, checked_at from public.repo_stats'))[0], before);
	const checked = await db.as(admin, (q) => q('select checked_at, stars, interface from public.repo_stats_current'));
	assert.ok(new Date(checked[0].checked_at) > new Date('2000-01-01'));
	assert.equal(checked[0].stars, 5);
	assert.equal(checked[0].interface, 11200);
	assert.deepEqual(await db.as(member, (q) => q('select * from public.repo_stats')), []);
	assert.deepEqual(await db.as(member, (q) => q('select * from public.repo_stats_current')), []);
	assert.deepEqual(await db.as(member, (q) => q('select * from public.repo_stats_checks')), []);
});

test('upgrading an existing facts table preserves values, last-check times and legacy restore columns', async () => {
	// Recreate the pre-migration layout with data, then run the actual migration.
	await db.raw(`drop view public.repo_stats_current;
		drop table public.repo_stats_checks;
		drop function public.store_repo_stats(text, jsonb, boolean);
		drop function public.prune_repo_check_cache(text);`);
	await db.sql(`insert into public.repo_stats
		(key, stars, pushed_at, archived, fork_of, missing, checked_at, interface, canonical)
		values ($1, 12, null, false, null, false, '2001-01-01T00:00:00Z', 11200, $1)`, [key]);
	await db.raw(readFileSync(new URL('../supabase/migrations/20261015000001_nightly_write_accounting.sql', import.meta.url), 'utf8'));
	const rows = await db.as(admin, (q) => q('select stars, interface, checked_at from public.repo_stats_current'));
	assert.equal(rows[0].stars, 12);
	assert.equal(rows[0].interface, 11200);
	assert.equal(new Date(rows[0].checked_at).toISOString(), '2001-01-01T00:00:00.000Z');
	assert.equal((await store([facts({stars:12})]))[0].report.facts_written, 0);
});

test('changed facts write once, partial files preserve versions, and confirmed absence can clear them', async () => {
	await store([facts()]);
	let report = (await store([facts({stars:6, interface:null, interface_checked:false})]))[0].report;
	assert.equal(report.facts_written, 1);
	assert.deepEqual(await db.sql('select stars, interface from public.repo_stats'), [{stars:6, interface:11200}]);
	report = (await store([facts({stars:6, interface:null, interface_checked:false})]))[0].report;
	assert.equal(report.facts_written, 0);
	assert.equal(report.facts_unchanged, 1);
	await store([facts({stars:6, interface:null, interface_checked:true})]);
	assert.equal((await db.sql('select interface from public.repo_stats'))[0].interface, null);
	// All nullable fields, rename and missing state participate in the comparison.
	for (const patch of [{fork_of:'github.com/a/parent'}, {pushed_at:'2026-01-01'}, {canonical:'github.com/a/renamed'}, {missing:true}, {archived:true}]) {
		assert.equal((await store([facts(patch)]))[0].report.facts_written, 1);
	}
});

test('old callers keep their integer result; duplicate keys and unlisted inputs cannot inflate accounting', async () => {
	const response = await db.asVisitor((q) => q('select public.store_repo_stats($1, $2::jsonb) as n', [NIGHTLY_TOKEN, JSON.stringify([facts()])]));
	assert.equal(response[0].n, 1);
	const report = (await store([facts({stars:7}), facts({stars:8}), facts({key:'github.com/unlisted/no'})]))[0].report;
	assert.equal(report.accepted, 1);
	assert.equal(report.facts_written, 1);
	assert.equal((await db.sql('select stars from public.repo_stats'))[0].stars, 8);
	assert.equal((await store([]))[0].report.accepted, 0);
});

test('a refused facts batch cannot partially advance its check bookkeeping', async () => {
	await store([facts()]);
	await db.sql("update public.repo_stats_checks set checked_at = '2000-01-01T00:00:00Z'");
	const before = await db.sql('select * from public.repo_stats_checks');
	await assert.rejects(store([facts({stars:'invalid'})]), /invalid input syntax/);
	assert.deepEqual(await db.sql('select * from public.repo_stats_checks'), before);
	assert.equal((await db.sql('select stars from public.repo_stats'))[0].stars, 5);
});

test('the new write path and bookkeeping retain token and admin-only read boundaries', async () => {
	await assert.rejects(store([facts()], 'wrong'), /Only the nightly job/);
	await assert.rejects(prune('wrong'), /Only the nightly job/);
	for (const role of [db.asVisitor, db.asService]) {
		for (const table of ['repo_stats', 'repo_stats_current', 'repo_stats_checks']) {
			await assert.rejects(role((q) => q(`select * from public.${table}`)), /permission denied/);
		}
	}
	await assert.rejects(db.as(admin, (q) => q('select public.store_repo_stats($1, $2::jsonb, true)', [NIGHTLY_TOKEN, '[]'])), /permission denied/);
	await assert.rejects(db.as(member, (q) => q('select public.prune_repo_check_cache($1)', [NIGHTLY_TOKEN])), /permission denied/);
	await assert.rejects(db.as(admin, (q) => q("update public.repo_stats_checks set checked_at = now()")), /permission denied/);
});

test('identical cache replays do not rewrite stored state or its last-write timestamp', async () => {
	const item = {url, state:{version:1, kind:'github', head:'a'.repeat(40)}};
	assert.equal((await cache([item]))[0].n, 1);
	await db.sql("update public.repo_check_cache set checked_at = '2000-01-01'");
	const before = await db.sql('select ctid::text as tuple, checked_at from public.repo_check_cache');
	assert.equal((await cache([item]))[0].n, 0);
	assert.deepEqual(await db.sql('select ctid::text as tuple, checked_at from public.repo_check_cache'), before);
	assert.equal((await cache([{url, state:{...item.state, head:'b'.repeat(40)}}]))[0].n, 1);
});

test('pruning removes only URLs with no published version or pending use', async () => {
	const secondary = 'https://github.com/a/secondary/tree/main/Folder';
	const pending = 'https://github.com/q/pending';
	await db.sql('update public.addons set versions = versions || $1::jsonb', [JSON.stringify([{url:secondary, note:''}])]);
	await db.queueImports([{name:'Pending', url:pending, description:'A pending addon', category:'Miscellaneous', images:[], alts:[], obsolete:false, parent:null}]);
	for (const address of [url, secondary, pending, 'https://github.com/old/removed']) {
		await db.sql('insert into public.repo_check_cache(url, state) values ($1, $2::jsonb)', [address, '{"version":1}']);
	}
	assert.equal((await prune())[0].n, 1);
	assert.deepEqual((await db.sql('select url from public.repo_check_cache order by url')).map((r) => r.url), [url, secondary, pending].sort());
	await db.sql("update public.import_queue set status = 'rejected'");
	assert.equal((await prune())[0].n, 1);
	assert.equal((await prune())[0].n, 0);
	assert.equal((await db.sql('select count(*)::int as n from public.repo_stats'))[0].n, 0);
});
