import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { addon, createDb, NIGHTLY_TOKEN, post } from '../helpers/db.mjs';

test('OctoWoW candidates require review, preserve decisions, and publish with their own credit', async () => {
	const db = await createDb();
	try {
		const admin = await db.addUser('admin', 'admin');
		const items = [{url:'https://octowow.st/git/Ade/AdeAlts',name:'AdeAlts',description:'Tracks alts',category:''}];
		const queue = (token = NIGHTLY_TOKEN) => db.sql('select public.queue_octowow_imports($1, $2::jsonb) as n', [token, JSON.stringify(items)]);
		await assert.rejects(queue('wrong'), /Only the nightly job/);
		assert.equal((await queue())[0].n, 1);
		assert.equal((await queue())[0].n, 0);
		let [row] = await db.sql('select * from public.import_queue');
		assert.equal(row.source, 'OctoWoW');
		assert.equal(row.status, 'pending');
		assert.deepEqual(await db.sql('select * from public.addons'), []);
		await db.as(admin, q => q("select public.decide_imports($1, 'rejected')", [[row.id]]));
		await queue();
		assert.equal((await db.sql('select status from public.import_queue'))[0].status, 'rejected');
		await db.as(admin, q => q("select public.decide_imports($1, 'pending')", [[row.id]]));
		await db.as(admin, q => q('select public.publish_import($1, $2::jsonb)', [row.id, JSON.stringify({name:'AdeAlts',description:'Tracks alts',category:'Miscellaneous'})]));
		assert.equal((await db.sql('select source from public.addons'))[0].source, 'OctoWoW');
		assert.equal((await queue())[0].n, 0);
		assert.deepEqual(await db.sql('select * from public.wiki_listing'), []);
	} finally { await db.close(); }
});

test('screenshot repair retries only empty pending OctoWoW imports and stores their recovered images', async () => {
	const db = await createDb();
	try {
		for (const [name, host, status, images] of [
			['AnySCT', 'octowow.st/git', 'pending', []],
			['AutoSpam', 'octowow.st/git', 'pending', ['https://raw.githubusercontent.com/a/b/main/image.png']],
			['Rejected', 'octowow.st/git', 'rejected', []],
			['Approved', 'octowow.st/git', 'approved', []],
			['Other', 'github.com', 'pending', []]
		]) {
			await db.sql(`insert into public.import_queue(key,url,name,status,images,readme_checked_at)
				values($1,$2,$3,$4,$5,now())`, [`${host}/a/${name}`.toLowerCase(), `https://${host}/a/${name}`, name, status, images]);
		}
		await db.raw(readFileSync(new URL('../../supabase/migrations/20261022000002_octowow_screenshots.sql', import.meta.url), 'utf8'));
		const rows = await db.sql('select name, readme_checked_at from public.import_queue');
		assert.deepEqual(rows.filter(row => row.readme_checked_at === null).map(row => row.name), ['AnySCT']);
		const image = 'https://octowow.st/git/ShempError/AnySCT/media/branch/main/screenshots/hero-miss-resist-wait.png';
		assert.equal((await db.sql("select public.host_allowed($1, 'image') as ok", [image]))[0].ok, true);
		await db.sql('select public.store_queue_images($1,$2::jsonb)', [NIGHTLY_TOKEN, JSON.stringify([{key:'octowow.st/git/a/anysct',images:[image]}])]);
		const [recovered] = await db.sql("select images, readme_checked_at from public.import_queue where name='AnySCT'");
		assert.deepEqual(recovered.images, [image]);
		assert.ok(recovered.readme_checked_at);
	} finally { await db.close(); }
});

test('pending mirror imports are hidden only while the exact source is published', async () => {
	const db = await createDb();
	try {
		const admin = await db.addUser('mirror-admin', 'admin');
		const member = await db.addUser('mirror-member');
		const source = 'https://github.com/akzkak/CombatLedger';
		const mirror = { name: 'CombatLedger', url: 'https://octowow.st/git/lightblade/CombatLedger' };
		const queue = items => db.asVisitor(q => q('select public.queue_octowow_imports($1, $2::jsonb)', [
			NIGHTLY_TOKEN, JSON.stringify(items)
		]));
		const visible = () => db.as(admin, q => q('select url from public.pending_imports'));
		await queue([mirror]);
		assert.deepEqual(await visible(), [{ url: mirror.url }]);
		await queue([{ ...mirror, mirror_source: source }]);
		assert.deepEqual(await visible(), [{ url: mirror.url }]);
		await db.queueImports([{ name: 'Source', url: source }]);
		assert.equal((await visible()).some(row => row.url === mirror.url), true);
		const branch = await post(db, admin, addon('Branch', source + '/tree/main'));
		assert.equal((await visible()).some(row => row.url === mirror.url), true);
		await db.sql('delete from public.addons where id = $1', [branch.id]);
		const published = await post(db, admin, addon('Published', source));
		assert.equal((await visible()).some(row => row.url === mirror.url), false);
		const [waiting] = await db.asVisitor(q => q('select public.nightly_waiting($1) as counts', [NIGHTLY_TOKEN]));
		assert.equal(waiting.counts.imports, (await visible()).length);
		assert.deepEqual(await db.as(member, q => q('select url from public.pending_imports')), []);
		await queue([{ ...mirror, mirror_source: null }]);
		assert.equal((await visible()).some(row => row.url === mirror.url), true);
		await queue([{ ...mirror, mirror_source: source }]);
		await db.sql('delete from public.addons where id = $1', [published.id]);
		assert.equal((await visible()).some(row => row.url === mirror.url), true);
	} finally {
		await db.close();
	}
});

test('reviewed cleanup removes only the mirror version and keeps it available for future review', async () => {
	const db = await createDb();
	try {
		const admin = await db.addUser('cleanup-admin', 'admin');
		const member = await db.addUser('cleanup-member');
		const source = 'https://github.com/akzkak/CombatLedger';
		const root = 'https://github.com/linkandzelda91/CombatLedger';
		const mirror = 'https://octowow.st/git/lightblade/CombatLedger';
		const versions = [source, root, mirror].map(url => ({ url, note: '' }));
		const published = await post(db, admin, addon('CombatLedger', source, {
			versions: JSON.stringify(versions)
		}));
		await db.sql('update public.addons set pinned_link = $2 where id = $1', [published.id, mirror]);
		const retire = (user, url = source) => db.as(user, q =>
			q('select public.retire_repository_mirror($1, $2, $3)', [published.id, mirror, url]));
		await assert.rejects(retire(admin), /relationship could not be confirmed/);
		await db.asVisitor(q => q('select public.queue_octowow_imports($1, $2::jsonb)', [
			NIGHTLY_TOKEN, JSON.stringify([{ name: 'CombatLedger', url: mirror, mirror_source: source }])
		]));
		await assert.rejects(retire(member), /Only admins/);
		await assert.rejects(retire(admin, root), /relationship could not be confirmed/);
		await retire(admin);
		const [remaining] = await db.sql('select id, slug, versions, pinned_link from public.addons where id = $1', [published.id]);
		assert.equal(remaining.id, published.id);
		assert.equal(remaining.slug, published.slug);
		assert.equal(remaining.pinned_link, source);
		assert.deepEqual(remaining.versions, versions.slice(0, 2));
		assert.deepEqual(await db.as(admin, q => q('select url from public.pending_imports')), []);
		await db.sql('update public.addons set versions = $2 where id = $1', [published.id, JSON.stringify(versions.slice(1, 2))]);
		assert.deepEqual(await db.as(admin, q => q('select url from public.pending_imports')), [{ url: mirror }]);
	} finally {
		await db.close();
	}
});
