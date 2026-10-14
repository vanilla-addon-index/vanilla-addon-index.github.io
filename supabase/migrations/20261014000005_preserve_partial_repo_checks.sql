-- A failed directory or .toc request is not evidence that an addon has no game version.
-- Older callers omit interface_checked and retain their existing full-replacement behavior.
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
		case when s.interface_checked is false then previous.interface else s.interface end,
		s.canonical,
		now()
	from jsonb_to_recordset(stats) as s (
		key text, stars integer, pushed_at timestamptz, archived boolean,
		fork_of text, missing boolean, interface integer, canonical text, interface_checked boolean
	)
	left join public.repo_stats previous on previous.key = s.key
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

notify pgrst, 'reload schema';
