-- The nightly job gets a token of its own instead of the project's secret key. The secret
-- key can also list, delete and log in as any account; the token is good for the three
-- things below and nothing else. The job signs in like any visitor and passes the token
-- along with each call.
--
-- Only the token's SHA-256 is stored, in a table nobody can read through the API.
-- `npm run nightly:token` makes a token and prints the statement that stores it here;
-- running that statement again with a new token replaces the old one.
create table if not exists public.nightly_token (
	-- At most one row.
	id boolean primary key default true check (id),
	hash text not null check (hash ~ '^[0-9a-f]{64}$'),
	set_at timestamptz not null default now()
);
alter table public.nightly_token enable row level security;
revoke all on public.nightly_token from anon, authenticated, service_role;

create or replace function public.is_nightly(token text) returns boolean
language sql stable security definer set search_path = '' as $$
	select exists (
		select 1 from public.nightly_token t
		where t.hash = encode(sha256(convert_to(coalesce(token, ''), 'UTF8')), 'hex')
	);
$$;

-- Every repository the job should ask GitHub about: queued and live.
create or replace function public.nightly_keys() returns setof text
language sql stable security definer set search_path = '' as $$
	select q.key from public.import_queue q where q.status = 'pending'
	union
	select unnest(a.link_keys) from public.addons a;
$$;

-- 1. Adds candidates whose link is neither live nor already in the queue. Returns how many.
-- The same as queue_imports(jsonb) in the groups migration, which it replaces, except for
-- who may call it.
create or replace function public.queue_imports(token text, items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
	added integer;
begin
	if not public.is_nightly(token) then
		raise exception 'Only the nightly job can queue imports.';
	end if;

	insert into public.import_queue (
		key, url, name, description, images, alts, category, obsolete, parent, group_key
	)
	select
		public.link_key(i ->> 'url'),
		i ->> 'url',
		left(btrim(i ->> 'name'), 120),
		coalesce(i ->> 'description', ''),
		array(select jsonb_array_elements_text(coalesce(i -> 'images', '[]'))),
		array(select jsonb_array_elements_text(coalesce(i -> 'alts', '[]'))),
		coalesce(i ->> 'category', 'Miscellaneous'),
		coalesce((i ->> 'obsolete')::boolean, false),
		i ->> 'parent',
		nullif(i ->> 'group_key', '')
	from jsonb_array_elements(items) i
	where (i ->> 'url') ~ '^https://\S+$'
		and btrim(coalesce(i ->> 'name', '')) <> ''
		and not exists (
			select 1 from public.addons a where a.link_keys @> array[public.link_key(i ->> 'url')]
		)
		-- A renamed repository is the same addon under either address.
		and not exists (
			select 1
			from public.repo_stats s
			join public.addons a on a.link_keys @> array[s.key] or a.link_keys @> array[s.canonical]
			where public.link_key(i ->> 'url') in (s.key, s.canonical)
		)
	on conflict (key) do nothing;

	get diagnostics added = row_count;
	return added;
end;
$$;

-- 2. The repositories to check, as one list: the API returns at most 1000 rows, and a
-- list is one value.
create or replace function public.nightly_repos(token text) returns text[]
language plpgsql stable security definer set search_path = '' as $$
begin
	if not public.is_nightly(token) then
		raise exception 'Only the nightly job can list the repositories to check.';
	end if;
	return array(select k from public.nightly_keys() k order by k);
end;
$$;

-- 3. Stores what GitHub said. Only for repositories on that list, so the table cannot be
-- filled with anything else. Returns how many were stored.
create or replace function public.store_repo_stats(token text, stats jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
	stored integer;
begin
	if not public.is_nightly(token) then
		raise exception 'Only the nightly job can store repository stats.';
	end if;

	insert into public.repo_stats (key, stars, pushed_at, archived, fork_of, missing, interface, canonical, checked_at)
	select
		s.key,
		coalesce(s.stars, 0),
		s.pushed_at,
		coalesce(s.archived, false),
		s.fork_of,
		coalesce(s.missing, false),
		s.interface,
		s.canonical,
		now()
	from jsonb_to_recordset(stats) as s (
		key text, stars integer, pushed_at timestamptz, archived boolean,
		fork_of text, missing boolean, interface integer, canonical text
	)
	where s.key in (select public.nightly_keys())
	on conflict (key) do update set
		stars = excluded.stars,
		pushed_at = excluded.pushed_at,
		archived = excluded.archived,
		fork_of = excluded.fork_of,
		missing = excluded.missing,
		interface = excluded.interface,
		canonical = excluded.canonical,
		checked_at = excluded.checked_at;

	get diagnostics stored = row_count;
	return stored;
end;
$$;

revoke all on function public.is_nightly(text) from public, anon, authenticated, service_role;
revoke all on function public.nightly_keys() from public, anon, authenticated, service_role;
revoke all on function public.queue_imports(text, jsonb) from public, authenticated, service_role;
revoke all on function public.nightly_repos(text) from public, authenticated, service_role;
revoke all on function public.store_repo_stats(text, jsonb) from public, authenticated, service_role;
grant execute on function public.queue_imports(text, jsonb) to anon;
grant execute on function public.nightly_repos(text) to anon;
grant execute on function public.store_repo_stats(text, jsonb) to anon;

-- The secret key's way in is closed: nothing signs in with it any more.
drop function if exists public.queue_imports(jsonb);
drop function if exists public.may_import();
revoke all on public.addons, public.import_queue, public.repo_stats from service_role;
