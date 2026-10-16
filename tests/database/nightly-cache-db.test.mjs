import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { NIGHTLY_TOKEN, addon, createDb, post } from '../helpers/db.mjs';

let db, user;
beforeEach(async () => { db = await createDb(); user = await db.addUser('cache-test'); });
afterEach(() => db.close());
const store = (items, token = NIGHTLY_TOKEN) => db.asVisitor((q) => q('select public.store_repo_check_cache($1, $2::jsonb) as n', [token, JSON.stringify(items)]));
const links = () => db.asVisitor((q) => q('select public.nightly_links($1) as links', [NIGHTLY_TOKEN]));

test('cache storage and retrieval require the narrow nightly token; direct reads and writes are private', async () => {
	await assert.rejects(store([], 'wrong'), /Only the nightly job/);
	for (const read of [db.asVisitor, (work) => db.as(user, work), db.asService]) {
		await assert.rejects(read((q) => q('select * from public.repo_check_cache')), /permission denied/);
		await assert.rejects(read((q) => q("insert into public.repo_check_cache (url, state) values ('x', '{}')")), /permission denied/);
	}
	await assert.rejects(db.as(user, (q) => q('select public.store_repo_check_cache($1, $2::jsonb)', [NIGHTLY_TOKEN, '[]'])), /permission denied/);
});

test('each original branch or folder URL gets its own cache even when review keys coincide', async () => {
	const first = 'https://github.com/a/Atlas/tree/vanilla/Folder';
	const second = 'https://github.com/a/Atlas/tree/other/Folder';
	const live = await post(db, user, addon('Atlas', first));
	const queued = 'https://github.com/q/Queued';
	await db.queueImports([{ name: 'Queued Atlas', url: queued, description: 'A queued repository', images: [], alts: [], category: 'Miscellaneous', obsolete: false, parent: null }]);
	const state = (tag) => ({ version: 1, kind: 'github', tag });
	assert.equal((await store([{ url: first, state: state('first') }, {url:queued,state:state('queued')}, { url: 'https://github.com/unlisted/No', state: state('unlisted') }]))[0].n, 2);
	const response = (await links())[0].links;
	assert.equal(response.find((row) => row.url === first).cache.tag, 'first');
	const key = response.find((row) => row.url === first).key;
	assert.equal(response.find((row) => row.url === queued).cache.tag, 'queued');
	await db.sql('update public.addons set versions = $1::jsonb where id = $2', [JSON.stringify([{url:second,note:''}]), live.id]);
	await store([{url:second, state:state('second')}]);
	const changed = (await links())[0].links.find((row) => row.url === second);
	assert.equal(changed.key, key);
	assert.equal(changed.cache.tag, 'second');
	await db.sql('update public.addons set versions = $1::jsonb where id = $2', [JSON.stringify([{url:first,note:''}]), live.id]);
	assert.equal((await links())[0].links.find((row) => row.url === first).cache.tag, 'first');
	await assert.rejects(db.asVisitor((q) => q('select cache from public.addons')), /does not exist/);
});

test('oversized or non-object caches cannot poison storage; invalid versions are ignored', async () => {
	const row = await post(db, user, addon('Atlas'));
	assert.equal((await store([{ url: row.repo_url, state: {version:0} }]))[0].n, 0);
	await assert.rejects(store([{ url: row.repo_url, state: {version:1, data:'x'.repeat(66000)} }]), /check constraint/);
	assert.equal((await db.sql('select count(*)::int as n from public.repo_check_cache'))[0].n, 0);
	assert.ok(!(await links())[0].links[0].cache);
});

test('removed links cannot update or retrieve their old cache entries', async () => {
	const row = await post(db, user, addon('Atlas'));
	await store([{ url: row.repo_url, state: { version:1, marker:'old' } }]);
	await db.sql('delete from public.addons where id = $1', [row.id]);
	assert.equal((await store([{url:row.repo_url, state:{version:1, marker:'new'}}]))[0].n, 0);
	assert.equal((await links())[0].links.length, 0);
	assert.equal((await db.sql('select state from public.repo_check_cache'))[0].state.marker, 'old');
});
