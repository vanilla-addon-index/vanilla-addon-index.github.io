-- Private cache of completed immutable checks. Mutable repository facts are still
-- checked daily. Never exposed in public addon responses or snapshots.
create table public.repo_check_cache (
	url text primary key,
	state jsonb not null check (jsonb_typeof(state) = 'object' and octet_length(state::text) <= 65536),
	checked_at timestamptz not null default now()
);
alter table public.repo_check_cache enable row level security;
revoke all on public.repo_check_cache from public, anon, authenticated, service_role;

create or replace function public.nightly_links(token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
	if not public.is_nightly(token) then
		raise exception 'Only the nightly job can list the repositories to check.';
	end if;
	return (
		select coalesce(
			jsonb_agg(
				jsonb_build_object('key', l.key, 'url', l.url, 'readme', l.readme)
					|| case when l.readme then jsonb_build_object('images', to_jsonb(l.images)) else '{}' end
					|| case when c.url is not null then jsonb_build_object('cache', c.state) else '{}' end
				order by l.key, l.url
			),
			'[]'
		)
		from (
			select q.key, q.url, q.readme_checked_at is null as readme, q.images
			from public.import_queue q
			where q.status = 'pending'
			union
			select public.link_key(v ->> 'url'), v ->> 'url', false, '{}'
			from public.addons a, jsonb_array_elements(a.versions) v
		) l
		left join public.repo_check_cache c on c.url = l.url
	);
end;
$$;

create function public.store_repo_check_cache(token text, items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare stored integer;
begin
	if not public.is_nightly(token) then
		raise exception 'Only the nightly job can store repository check cache.';
	end if;
	insert into public.repo_check_cache (url, state)
	select i.url, i.state
	from jsonb_to_recordset(items) as i(url text, state jsonb)
	where jsonb_typeof(i.state -> 'version') = 'number' and i.state ->> 'version' ~ '^[1-9][0-9]*$'
		and i.url in (
			select q.url from public.import_queue q where q.status = 'pending'
			union
			select v ->> 'url' from public.addons a, jsonb_array_elements(a.versions) v
		)
	on conflict (url) do update set state = excluded.state, checked_at = now();
	get diagnostics stored = row_count;
	return stored;
end;
$$;
revoke all on function public.store_repo_check_cache(text, jsonb) from public, authenticated, service_role;
grant execute on function public.store_repo_check_cache(text, jsonb) to anon;

notify pgrst, 'reload schema';
