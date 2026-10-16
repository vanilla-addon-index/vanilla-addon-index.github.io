// Fresh accounts and database for each database-rule test.
import assert from 'node:assert/strict';
import { createDb } from './db.mjs';

export async function createRulesContext() {
	const db = await createDb();
	const owner = await db.addUser('owner', 'owner');
	const admin = await db.addUser('admin', 'admin');
	const admin2 = await db.addUser('admin2', 'admin');
	const alice = await db.addUser('alice');
	const bob = await db.addUser('bob');
	const refused = (work, message) => assert.rejects(work, message ? { message } : undefined);
	const call = (user, sql, params) => db.as(user, (q) => q(sql, params));
	const live = async () => (await db.sql('select name from public.addons order by name')).map((r) => r.name);
	const logged = async () => (await db.sql('select action from public.activity_log order by id')).map((r) => r.action);
	const role = async (user) => (await call(user, 'select public.my_role() as r'))[0].r;
	return { db, owner, admin, admin2, alice, bob, refused, call, live, logged, role };
}
