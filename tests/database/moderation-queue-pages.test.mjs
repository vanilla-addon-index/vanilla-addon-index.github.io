import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRulesContext } from '../helpers/rules-context.mjs';

test('moderators can page and search the full review queues by ID', async () => {
	const { db, admin, alice, call, refused } = await createRulesContext();
	try {
		const sql = 'select public.moderation_queue_page($1, $2, $3, $4) as page';
		const read = async (queue, after = 0, search = '', summary = false) =>
			(await call(admin, sql, [queue, after, search, summary]))[0].page;
		const args = ['reports', 0, '', true];
		await refused(() => db.asVisitor(q => q(sql, args)), /permission denied/);
		await refused(() => call(alice, sql, args), /Only admins/);
		await db.sql(`insert into public.addons(name, description, category, versions)
			select 'Addon ' || i, 'A test addon for moderation paging.', 'Combat',
				jsonb_build_array(jsonb_build_object('url', 'https://github.com/test/addon-' || i, 'note', ''))
			from generate_series(1, 54) i`);
		await db.sql(`insert into public.reports(addon_id,reason,note,reported_by_name)
			select id, case when id = 54 then 'harmful' else 'broken' end,
				case when id = 54 then 'Check 100% of this.' else '' end, 'Former member'
			from public.addons order by id`);
		await db.sql(`insert into public.addon_edit_requests(addon_id,proposed_by,base,changes)
			select id, $1, '{}', case when id = 54 then '{"versions":[]}'::jsonb else '{"name":"Changed"}'::jsonb end
			from public.addons order by id`, [alice.id]);
		await db.sql(`insert into public.addon_link_requests(addon_id,proposed_by,url,key)
			select 1, $1, 'https://github.com/member/link-' || i, 'github.com/member/link-' || i
			from generate_series(1, 1003) i`, [alice.id]);

		const first = await read('reports', 0, '', true);
		assert.deepEqual(first.report_counts, { broken: 53, harmful: 1 });
		assert.equal(first.rows.length, 51);
		assert.equal(first.rows[49].id, 50);
		await db.sql("update public.reports set status = 'dismissed' where id in (2, 50)");
		const next = await read('reports', first.rows[49].id);
		assert.deepEqual(next.rows.map(row => row.id), [51, 52, 53, 54]);
		assert.equal(next.report_counts, null);
		assert.deepEqual((await read('reports', 0, 'Harmful or malicious Check 100%')).rows.map(r => r.id), [54]);
		assert.deepEqual((await read('reports', 0, 'Addon 54')).rows.map(r => r.id), [54]);
		assert.deepEqual((await read('reports', 0, '% of this.')).rows.map(r => r.id), [54]);

		assert.equal((await read('edits')).rows.length, 51);
		assert.deepEqual((await read('edits', 50)).rows.map(r => r.id), [51, 52, 53, 54]);
		assert.deepEqual((await read('edits', 0, 'Alice Download links')).rows.map(r => r.id), [54]);
		assert.equal((await read('links')).rows.length, 51);
		assert.deepEqual((await read('links', 1000)).rows.map(r => r.id), [1001, 1002, 1003]);
		assert.deepEqual((await read('links', 0, 'link-1003 alice')).rows.map(r => r.id), [1003]);
	} finally {
		await db.close();
	}
});
