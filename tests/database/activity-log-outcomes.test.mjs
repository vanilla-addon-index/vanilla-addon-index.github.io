import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addon, createDb, NIGHTLY_TOKEN, post } from '../helpers/db.mjs';

async function scenario(t) {
	const db = await createDb();
	t.after(() => db.close());
	const owner = await db.addUser('siteowner', 'owner');
	const member = await db.addUser('member');
	const entry = await post(db, member, addon('AuditLogFixture'));
	const act = (sql, args) => db.as(owner, query => query(sql, args));
	const log = (pattern) => act('select id, action, actor_name, addon_id, details from public.activity_log where action like $1 order by id', [pattern]);
	return { db, owner, member, entry, act, log };
}

test('pin changes survive edit retention while no-op pins produce no entries', async t => {
	const { db, entry, act, log } = await scenario(t);
	const second = 'https://github.com/test/another-link';
	await act('select public.request_addon_link($1,$2)', [entry.id, second]);
	for (const url of [entry.repo_url, second, null, null]) {
		await act('select public.pin_addon_link($1,$2)', [entry.id, url]);
	}
	const pins = (await log('addon.update')).filter(row => row.details.pin_change);
	assert.deepEqual(pins.map(row => row.details.pin_change), ['pinned', 'repinned', 'unpinned']);
	assert.equal(pins[2].details.before.pinned_link, second);
	assert.equal(pins[2].details.after.pinned_link, null);
	await db.sql("update public.activity_log set at = now() - interval '91 days' where id = $1", [pins[2].id]);
	await db.asVisitor(query => query('select public.nightly_tidy($1)', [NIGHTLY_TOKEN]));
	const [trimmed] = await db.sql('select details from public.activity_log where id = $1', [pins[2].id]);
	assert.deepEqual(trimmed.details, { changed: ['pinned_link'], pin_change: 'unpinned' });
});

test('link and edit reviews record the outcome and the fields actually accepted', async t => {
	const { db, member, entry, act, log } = await scenario(t);
	const url = 'https://github.com/member/audit-proposal';
	const propose = (sql, args) => db.as(member, query => query(sql, args));
	await propose('select public.request_addon_link($1,$2)', [entry.id, url]);
	const [{ id: linkId }] = await db.sql('select id from public.addon_link_requests where url = $1', [url]);
	await act('select public.decide_addon_link($1,false)', [linkId]);
	await assert.rejects(() => act('select public.decide_addon_link($1,true)', [linkId]), /no longer pending/);
	assert.deepEqual((await log('review.link.%')).map(row => [row.action, row.actor_name, row.details.url]), [
		['review.link.proposed', member.username, url],
		['review.link.rejected', 'siteowner', url]
	]);

	// A shared page lets its contributor propose changes.
	await act('select public.request_addon_link($1,$2)', [entry.id, 'https://github.com/test/shared-version']);
	const [{ proposal }] = await propose(
		"select public.propose_addon_edit(id, '{\"author\":\"New author\",\"description\":\"Suggested description\"}', to_jsonb(a)) as proposal from public.addons a where id = $1",
		[entry.id]
	);
	await act("select public.decide_addon_edit($1,true,array['description'])", [proposal]);
	assert.deepEqual((await log('review.edit.%')).map(row => [row.action, row.details.fields]), [
		['review.edit.proposed', ['author', 'description']],
		['review.edit.accepted', ['description']]
	]);
});

test('moving a link records both pages and requeue targets the selected approval', async t => {
	const { db, entry, act, log } = await scenario(t);
	const urls = ['https://github.com/test/first-import', 'https://github.com/test/second-import'];
	for (const [index, url] of urls.entries()) {
		const [{ id }] = await db.sql(
			"insert into public.import_queue (key,url,name,category,source) values (public.link_key($1),$1,$2,'Combat','Test') returning id",
			[url, 'Queued ' + index]
		);
		await act('select public.publish_import($1,null,$2)', [id, entry.id]);
	}
	const [first, second] = await log('import.attach');
	assert.deepEqual([first.details.url, second.details.url], urls);
	const requeue = async (id) => (await act('select public.requeue_import_approval($1) as changed', [id]))[0].changed;
	assert.equal(await requeue(first.id), true);
	assert.equal(await requeue(first.id), false);
	assert.equal((await log('import.requeue'))[0].details.undid, first.id);
	assert.equal((await db.sql('select status from public.import_queue where url = $1', [urls[1]]))[0].status, 'approved');

	const [{ made }] = await act('select public.split_addon_link($1,$2,$3) as made', [entry.id, urls[1], 'Separated Fixture']);
	const [split] = await log('addon.split');
	assert.deepEqual(split.details, { url: urls[1], target: 'Separated Fixture', related_addon_id: made });
	assert.equal(split.addon_id, entry.id);
	assert.equal((await log('import.approve')).length, 0);
	await act('select public.merge_addons($1,$2)', [made, entry.id]);
	const [merge] = await log('addon.merge');
	assert.deepEqual(merge.details.urls, [urls[1]]);
	assert.equal(merge.details.related_addon_id, entry.id);
	assert.equal(merge.addon_id, made);
});
