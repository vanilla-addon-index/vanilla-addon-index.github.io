import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { NIGHTLY_TOKEN, addon, post } from '../helpers/db.mjs';
import { createRulesContext } from '../helpers/rules-context.mjs';

let db, owner, admin, admin2, alice, bob, refused, call, live, logged;
beforeEach(async () => {
	({ db, owner, admin, admin2, alice, bob, refused, call, live, logged } = await createRulesContext());
});
afterEach(() => db.close());

describe('import queue', () => {
	test('the migration normalizes existing pending imports without renaming published addons', async () => {
		await db.raw('drop trigger normalize_import_name on public.import_queue; drop function public.normalize_import_name();');
		await db.queueImports([{name:'Better Character Panel', url:'https://github.com/a/BetterCharacterPanel', parent:'Parent Addon'}]);
		const liveAddon = await post(db, alice, addon('Existing Title', 'https://github.com/a/ExistingTitle'));
		await db.raw(readFileSync(new URL('../../supabase/migrations/20261016000004_import_names.sql', import.meta.url), 'utf8'));
		assert.deepEqual(await db.sql('select name, parent from public.import_queue'), [{name:'BetterCharacterPanel', parent:'ParentAddon'}]);
		assert.equal((await db.sql('select name from public.addons where id = $1', [liveAddon.id]))[0].name, 'Existing Title');
	});

	test('spaced wiki names and parent references are normalized before approval', async () => {
		await db.queueImports([{
			name: 'Better Character\u00a0Panel', url: 'https://github.com/a/BetterCharacterPanel',
			description: 'Improves the character and inspect panel', category: 'UI & Appearance',
			images: [], alts: [], parent: 'Parent Addon'
		}]);
		const [entry] = await db.sql('select id, name, parent from public.import_queue');
		assert.equal(entry.name, 'BetterCharacterPanel');
		assert.equal(entry.parent, 'ParentAddon');
		await db.sql('update public.import_queue set name = $1 where id = $2', ['Better Character Panel', entry.id]);
		assert.equal((await db.sql('select name from public.import_queue'))[0].name, 'BetterCharacterPanel');
		await call(admin, 'select public.approve_imports($1)', [[entry.id]]);
		assert.equal((await db.sql('select name from public.addons'))[0].name, 'BetterCharacterPanel');
		await db.queueImports([{name:'Other Panel', url:'https://github.com/a/OtherPanel', description:'Another useful addon', category:'UI & Appearance'}]);
		const [other] = await db.sql("select id from public.import_queue where status = 'pending'");
		await call(admin, 'select public.publish_import($1, $2::jsonb)', [other.id, JSON.stringify({name:'Reviewed Panel', description:'Another useful addon', category:'UI & Appearance', images:[]})]);
		assert.equal((await db.sql("select name from public.addons where name = 'ReviewedPanel'"))[0].name, 'ReviewedPanel');
	});

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
				category: 'UI & Appearance'
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
			category: 'UI & Appearance',
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

		// The admin who approved it is an admin no longer: it is not theirs to change.
		await call(owner, 'select public.set_admin($1, false)', [admin.id]);
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

	test('same-name wiki versions publish as links on one canonical page', async () => {
 await queue([candidate('pfUI','https://github.com/brues-code/pfUI'),candidate('pfUI','https://github.com/shagu/pfUI')]);
 const ids=(await db.sql('select id from public.import_queue')).map(r=>r.id);
 assert.equal((await call(admin,'select public.approve_imports($1) as n',[ids]))[0].n,2);
 const rows=await db.sql('select * from public.addons');
 assert.equal(rows.length,1);assert.equal(rows[0].versions.length,2);assert.equal(rows[0].owner,null);
 });

	test('a queued entry can add its link directly to a live page', async () => {
 const a=await post(db,alice,addon('Atlas','https://github.com/a/Atlas'));
 await queue([candidate('Atlas fork','https://github.com/b/Atlas')]);
 const [{id}]=await db.sql('select id from public.import_queue');
 await refused(()=>call(alice,'select public.approve_into($1,$2)',[id,a.id]),/Only admins/);
 await call(admin,'select public.approve_into($1,$2)',[id,a.id]);
 const rows=await db.sql('select * from public.addons');assert.equal(rows.length,1);assert.equal(rows[0].versions.length,2);
 });

	test('two imports with the same name publish at one address', async () => {
 await queue([candidate('aDF','https://github.com/one/aDF'),candidate('aDF','https://github.com/two/aDF')]);
 const ids=(await db.sql('select id from public.import_queue order by id')).map(r=>r.id);
 assert.equal((await call(admin,'select public.approve_imports($1) as n',[ids]))[0].n,2);
 assert.deepEqual(await db.sql('select slug, jsonb_array_length(versions) as n from public.addons'),[{slug:'adf',n:2}]);
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

	test('only the owner can restore owner rejections, including in mixed batches', async () => {
		await queue([candidate('OwnerRejected'), candidate('AdminRejected')]);
		const rows = await db.sql('select id, name from public.import_queue');
		const ids = Object.fromEntries(rows.map(r => [r.name, r.id]));
		await call(owner, "select public.decide_imports($1, 'rejected')", [[ids.OwnerRejected]]);
		await call(admin, "select public.decide_imports($1, 'rejected')", [[ids.AdminRejected]]);
		assert.deepEqual(await db.sql('select rejected_by_owner from public.import_queue where id = $1', [ids.OwnerRejected]), [{rejected_by_owner:true}]);
		for (const user of [admin, admin2]) {
			await refused(() => call(user, "select public.decide_imports($1, 'pending')", [[ids.OwnerRejected]]), /Only the owner/);
		}
		await refused(() => call(admin2, "select public.decide_imports($1, 'pending')", [[ids.AdminRejected, ids.OwnerRejected]]), /Only the owner/);
		assert.deepEqual(await waiting(), []);
		await call(admin2, "select public.decide_imports($1, 'pending')", [[ids.AdminRejected]]);
		await call(owner, "select public.decide_imports($1, 'pending')", [[ids.OwnerRejected]]);
		assert.deepEqual(await waiting(), ['AdminRejected', 'OwnerRejected']);
		assert.ok((await db.sql('select rejected_by_owner from public.import_queue')).every(r => !r.rejected_by_owner));
		await call(admin, "select public.decide_imports($1, 'rejected')", [[ids.OwnerRejected]]);
		await call(admin2, "select public.decide_imports($1, 'pending')", [[ids.OwnerRejected]]);
	});

	test('the nightly job gets the repositories to check and stores what GitHub said about them', async () => {
		await post(db, alice, addon('Atlas', 'https://github.com/wiki/Atlas'));
		await queue([candidate('Bagnon')]);
		// Each link as it was written, branch and capital letters included, next to its key.
		await post(db, bob, addon('Port', 'https://github.com/Someone/Port/tree/Vanilla-Port'));
		const [{ links }] = await nightly('select public.nightly_links($1) as links', NIGHTLY_TOKEN);
		assert.deepEqual(links, [
			{ key: 'github.com/someone/port', url: 'https://github.com/Someone/Port/tree/Vanilla-Port', readme: false },
			{ key: 'github.com/wiki/atlas', url: 'https://github.com/wiki/Atlas', readme: false },
			// Waiting, and not looked at yet: it comes with the pictures it has, here none.
			{ key: 'github.com/wiki/bagnon', url: 'https://github.com/wiki/Bagnon', readme: true, images: [] }
		]);

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

	test('partial repository checks preserve known versions while successful absence can clear them', async () => {
		await queue([candidate('Bagnon')]);
		const store = (row) => nightly('select public.store_repo_stats($1, $2::jsonb)', NIGHTLY_TOKEN, stats({ key: 'github.com/wiki/bagnon', ...row }));
		await store({ stars: 5, interface: 11200 });
		await store({ stars: 6, interface: null, interface_checked: false });
		assert.deepEqual(await db.sql('select stars, interface from public.repo_stats'), [{ stars: 6, interface: 11200 }]);
		await store({ stars: 7, interface: null, interface_checked: true });
		assert.deepEqual(await db.sql('select stars, interface from public.repo_stats'), [{ stars: 7, interface: null }]);
		await store({ interface: null, interface_checked: false });
		assert.equal((await db.sql('select interface from public.repo_stats'))[0].interface, null);
	});

	test('the pictures of a waiting entry are looked at once, and what is settled replaces what it had', async () => {
		const shot = (name) => `https://raw.githubusercontent.com/wiki/${name}/main/shot.png`;
		await queue([candidate('Bare'), candidate('Shown', undefined, { images: [shot('dead'), shot('wiki')] }), candidate('Empty'), candidate('Gone')]);
		const ids = Object.fromEntries((await db.sql('select name, id from public.import_queue')).map((r) => [r.name, r.id]));
		await call(admin, `select public.decide_imports($1, 'rejected')`, [[ids.Gone]]);
		const store = 'select public.store_queue_images($1, $2::jsonb) as n';
		const items = (...list) => JSON.stringify(list.map(([name, ...images]) => ({ key: `github.com/wiki/${name.toLowerCase()}`, images })));
		const wants = async () => (await nightly('select public.nightly_links($1) as links', NIGHTLY_TOKEN))[0].links.filter((l) => l.readme);
		// Every waiting entry, with the pictures it has from the wiki.
		assert.deepEqual((await wants()).map((l) => `${l.key}: ${l.images.length}`), ['github.com/wiki/bare: 0', 'github.com/wiki/empty: 0', 'github.com/wiki/shown: 2']);

		// Seven found for one, none for another; one whose dead picture is dropped and whose
		// README adds one; one that is no longer waiting.
		const seven = Array.from({ length: 7 }, (_, i) => shot(`bare${i}`));
		const [{ n }] = await nightly(store, NIGHTLY_TOKEN, items(['Bare', ...seven, 'http://insecure.example/a.png'], ['Empty'], ['Shown', shot('wiki'), shot('readme')], ['Gone', shot('gone')]));
		assert.equal(n, 2);
		const stored = async () => Object.fromEntries((await db.sql('select name, images from public.import_queue')).map((r) => [r.name, r.images]));
		let images = await stored();
		assert.deepEqual(images.Bare, seven.slice(0, 5));
		assert.deepEqual(images.Shown, [shot('wiki'), shot('readme')]);
		assert.deepEqual(images.Empty, []);
		assert.deepEqual(images.Gone, []);
		// Each entry is looked at once: sent again, nothing changes.
		assert.deepEqual(await wants(), []);
		await nightly(store, NIGHTLY_TOKEN, items(['Shown', shot('later')], ['Empty', shot('later')]));
		images = await stored();
		assert.deepEqual(images.Shown, [shot('wiki'), shot('readme')]);
		assert.deepEqual(images.Empty, []);

		await refused(() => nightly(store, 'a guess', items()), /Only the nightly job/);
		await refused(() => call(admin, 'select public.store_queue_images($1, $2::jsonb)', [NIGHTLY_TOKEN, items()]), /permission denied/);
		// Approved as it is, the entry is published with the pictures found.
		await call(admin, 'select public.approve_imports($1)', [[ids.Bare]]);
		assert.deepEqual((await db.sql(`select images from public.addons where name = 'Bare'`))[0].images, seven.slice(0, 5));
	});

	test('the nightly token is needed for each of its calls, and cannot be read back', async () => {
		await refused(() => nightly('select public.nightly_links($1)', 'a guess'), /Only the nightly job/);
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
