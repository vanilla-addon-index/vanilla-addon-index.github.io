// A throwaway copy of the database for tests: real Postgres running inside Node (PGlite),
// with the project's own migrations applied in order. Nothing here
// touches the hosted Supabase project.
//
// Supabase provides a few things the SQL files rely on. They are stood in for below:
// the three API roles, the auth schema, and the http extension an early migration uses.
import { readdirSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

// Every migration, in the order its name gives: the same files, in the same order, that
// build the hosted database and the local copy of the backend.
const MIGRATIONS = new URL('../../supabase/migrations/', import.meta.url);
const SQL_FILES = readdirSync(MIGRATIONS).filter((file) => file.endsWith('.sql')).sort();

const SUPABASE_STAND_IN = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create schema extensions;

create table auth.users (
	id uuid primary key default gen_random_uuid(),
	raw_user_meta_data jsonb not null default '{}'
);
create table auth.identities (
	id uuid primary key default gen_random_uuid(),
	user_id uuid not null references auth.users on delete cascade,
	provider text not null,
	provider_id text not null
);

-- Supabase puts the caller's login token in this setting for every API request.
create function auth.jwt() returns jsonb language sql stable as $$
	select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;
create function auth.uid() returns uuid language sql stable as $$
	select nullif(auth.jwt() ->> 'sub', '')::uuid;
$$;

-- The http extension, which an early migration needs to exist. Nothing calls it any more.
create type extensions.http_header as (field text, value text);
create type extensions.http_request as (
	method text, uri text, headers extensions.http_header[], content_type text, content text
);
create type extensions.http_response as (
	status integer, content_type text, headers extensions.http_header[], content text
);
create function extensions.http_header(text, text) returns extensions.http_header
language sql as $$ select row($1, $2)::extensions.http_header $$;
create function extensions.http(extensions.http_request) returns extensions.http_response
language sql as $$ select 200, 'application/json', null::extensions.http_header[], '[]' $$;

grant usage on schema public, auth, extensions to anon, authenticated, service_role;
`;

// What the nightly job signs its calls with; see the nightly token migration.
export const NIGHTLY_TOKEN = 'the-nightly-token';

let template;

// Building the schema takes a second or two, so it is done once and copied for each test.
async function build(beforeSharedMigration) {
	const db = new PGlite();
	await db.exec(SUPABASE_STAND_IN);
	for (const file of SQL_FILES) {
		if (file === '20261015000002_shared_addon_links.sql' && beforeSharedMigration) await beforeSharedMigration(db);
		const sql = readFileSync(new URL(file, MIGRATIONS), 'utf8')
			// Stood in for above; PGlite cannot install it.
			.replace(/^create extension if not exists http[^;]*;/m, '');
		try {
			await db.exec(sql);
		} catch (error) {
			throw new Error(`supabase/migrations/${file} failed: ${error.message}`, { cause: error });
		}
	}
	const copy = await db.dumpDataDir('none');
	await db.close();
	return copy;
}

export async function createDb({beforeSharedMigration} = {}) {
	if (!beforeSharedMigration) template ??= build();
	const db = new PGlite({ loadDataDir: await (beforeSharedMigration ? build(beforeSharedMigration) : template) });
	await db.query(`insert into public.nightly_token (hash) values (encode(sha256(convert_to($1, 'UTF8')), 'hex'))`, [NIGHTLY_TOKEN]);

	// One call is one API request: its own transaction, as one caller.
	async function request(role, claims, work) {
		await db.exec('begin');
		try {
			await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
			await db.exec(`set local role ${role}`);
			const result = await work(async (sql, params) => (await db.query(sql, params)).rows);
			await db.exec('commit');
			return result;
		} catch (error) {
			await db.exec('rollback');
			throw error;
		}
	}

	return {
		close: () => db.close(),

		/** Runs a whole SQL file, as the database owner. */
		raw: (sql) => db.exec(sql),

		/** Runs as the database owner, the way the Supabase SQL editor does. */
		sql: async (sql, params) => (await db.query(sql, params)).rows,

		as: (user, work) => request('authenticated', { sub: user.id, role: 'authenticated' }, work),
		asVisitor: (work) => request('anon', { role: 'anon' }, work),
		/** The project's secret key, which nothing of ours uses any more. */
		asService: (work) => request('service_role', { role: 'service_role' }, work),

		/** The nightly job adding wiki entries to the import queue. Returns how many were new. */
		queueImports: async (items, token = NIGHTLY_TOKEN) =>
			(
				await request('anon', { role: 'anon' }, (q) =>
					q('select public.queue_imports($1, $2::jsonb) as added', [token, JSON.stringify(items)])
				)
			)[0].added,

		/**
		 * Creates an account the way a first login does.
		 * role: 'member' (default), 'admin' or 'owner'.
		 */
		async addUser(username, role = 'member') {
			const [{ id }] = (
				await db.query(`insert into auth.users (raw_user_meta_data) values ($1) returning id`, [
					JSON.stringify({ user_name: username })
				])
			).rows;
			const user = { id, username };
			if (role === 'owner') {
				await db.query(`update public.profiles set is_owner = true where id = $1`, [id]);
			}
			if (role === 'admin') {
				await db.query(`update public.profiles set is_admin = true where id = $1`, [id]);
			}
			return user;
		}
	};
}

/** The fields the submit form sends for a new addon. */
export const addon = (name, url = `https://github.com/someone/${name}`, extra = {}) => ({
	slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
	name,
	description: 'A description that is long enough.',
	category: 'Miscellaneous',
	versions: JSON.stringify([{ url, note: '' }]),
	...extra
});

/** Posts an addon as the given user and returns its row. */
export async function post(db, user, fields) {
	const columns = Object.keys(fields);
	const [row] = await db.as(user, (q) =>
		q(
			`insert into public.addons (${columns.join(', ')}) values (${columns.map((_, i) => `$${i + 1}`).join(', ')}) returning *`,
			Object.values(fields)
		)
	);
	return row;
}

/** Establish approved contributions for tests of shared-page behavior. */
export async function approveLinkSuggestions(db, admin) {
	const requests = await db.sql("select id from public.addon_link_requests where status = 'pending' order by id");
	for (const request of requests) await db.as(admin, q => q('select public.decide_addon_link($1,true)', [request.id]));
}
