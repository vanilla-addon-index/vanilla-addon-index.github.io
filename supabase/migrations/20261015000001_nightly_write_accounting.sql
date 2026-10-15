-- Keep facts stable when only the time of a successful check changes. The existing
-- admin row format remains unchanged through repo_stats_current. Keep the original
-- repo_stats table and columns so older data-only backups still restore normally.

create table public.repo_stats_checks (
	key text primary key references public.repo_stats(key) on delete cascade,
	checked_at timestamptz not null
);
insert into public.repo_stats_checks (key, checked_at)
select key, checked_at from public.repo_stats;
alter table public.repo_stats_checks enable row level security;
revoke all on public.repo_stats_checks from public, anon, authenticated, service_role;
grant select on public.repo_stats_checks to authenticated;
create policy "admins read repo check times" on public.repo_stats_checks for select to authenticated
	using (public.is_admin());

create view public.repo_stats_current with (security_invoker = true) as
select f.key, f.stars, f.pushed_at, f.archived, f.fork_of, f.missing,
	coalesce(c.checked_at, f.checked_at) as checked_at, f.interface, f.canonical
from public.repo_stats f left join public.repo_stats_checks c using (key);
revoke all on public.repo_stats_current from public, anon, authenticated, service_role;
grant select on public.repo_stats_current to authenticated;

-- The explicit third argument requests accounting. Preserve the two-argument
-- integer-returning interface for older importers and existing callers.
create function public.store_repo_stats(token text, stats jsonb, report boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
	if not public.is_nightly(token) then
		raise exception 'Only the nightly job can store repository stats.';
	end if;
	with incoming as materialized (
		select distinct on (s.value ->> 'key')
			s.value ->> 'key' as key, s.value
		from jsonb_array_elements(stats) with ordinality s(value, n)
		where s.value ->> 'key' in (select public.nightly_keys())
		order by s.value ->> 'key', s.n desc
	), prepared as materialized (
		select s.key, coalesce((s.value ->> 'stars')::integer, 0) as stars,
			(s.value ->> 'pushed_at')::timestamptz as pushed_at,
			coalesce((s.value ->> 'archived')::boolean, false) as archived,
			s.value ->> 'fork_of' as fork_of,
			coalesce((s.value ->> 'missing')::boolean, false) as missing,
			case when (s.value ->> 'interface_checked')::boolean is false
				then p.interface else (s.value ->> 'interface')::integer end as interface,
			s.value ->> 'canonical' as canonical
		from incoming s left join public.repo_stats p using (key)
	), facts as (
		insert into public.repo_stats as previous
			(key, stars, pushed_at, archived, fork_of, missing, interface, canonical, checked_at)
		select key, stars, pushed_at, archived, fork_of, missing, interface, canonical, now()
		from prepared
		on conflict (key) do update set
			stars = excluded.stars, pushed_at = excluded.pushed_at,
			archived = excluded.archived, fork_of = excluded.fork_of,
			missing = excluded.missing, interface = excluded.interface,
			canonical = excluded.canonical, checked_at = excluded.checked_at
		where row(previous.stars, previous.pushed_at, previous.archived, previous.fork_of,
			previous.missing, previous.interface, previous.canonical)
			is distinct from row(excluded.stars, excluded.pushed_at, excluded.archived, excluded.fork_of,
				excluded.missing, excluded.interface, excluded.canonical)
		returning key
	), checks as (
		insert into public.repo_stats_checks as previous (key, checked_at)
		select key, now() from prepared
		on conflict (key) do update set checked_at = excluded.checked_at
		where previous.checked_at is distinct from excluded.checked_at
		returning key
	)
	select jsonb_build_object(
		'accepted', (select count(*) from prepared),
		'facts_written', (select count(*) from facts),
		'facts_unchanged', (select count(*) from prepared) - (select count(*) from facts),
		'checks_written', (select count(*) from checks)
	) into result;
	return result;
end;
$$;
revoke all on function public.store_repo_stats(text, jsonb, boolean) from public, authenticated, service_role;
grant execute on function public.store_repo_stats(text, jsonb, boolean) to anon;

create or replace function public.store_repo_stats(token text, stats jsonb) returns integer
language sql security definer set search_path = '' as $$
	select (public.store_repo_stats(token, stats, true) ->> 'accepted')::integer;
$$;

-- Identical cache saves, including a replay after a lost response, need no new
-- tuple. checked_at remains the time the cache state was last written.
create or replace function public.store_repo_check_cache(token text, items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare stored integer;
begin
	if not public.is_nightly(token) then
		raise exception 'Only the nightly job can store repository check cache.';
	end if;
	insert into public.repo_check_cache as previous (url, state)
	select i.url, i.state
	from jsonb_to_recordset(items) as i(url text, state jsonb)
	where jsonb_typeof(i.state -> 'version') = 'number' and i.state ->> 'version' ~ '^[1-9][0-9]*$'
		and i.url in (
			select q.url from public.import_queue q where q.status = 'pending'
			union
			select v ->> 'url' from public.addons a, jsonb_array_elements(a.versions) v
		)
	on conflict (url) do update set state = excluded.state, checked_at = now()
		where previous.state is distinct from excluded.state;
	get diagnostics stored = row_count;
	return stored;
end;
$$;

-- Run once per import. Preserve every URL still referenced by any published
-- version or pending entry, even if several spellings share a review key.
create function public.prune_repo_check_cache(token text) returns integer
language plpgsql security definer set search_path = '' as $$
declare removed integer;
begin
	if not public.is_nightly(token) then
		raise exception 'Only the nightly job can prune repository check cache.';
	end if;
	delete from public.repo_check_cache c where not exists (
		select 1 from public.import_queue q where q.status = 'pending' and q.url = c.url
	) and not exists (
		select 1 from public.addons a, jsonb_array_elements(a.versions) v where v ->> 'url' = c.url
	);
	get diagnostics removed = row_count;
	return removed;
end;
$$;
revoke all on function public.prune_repo_check_cache(text) from public, authenticated, service_role;
grant execute on function public.prune_repo_check_cache(text) to anon;

notify pgrst, 'reload schema';
