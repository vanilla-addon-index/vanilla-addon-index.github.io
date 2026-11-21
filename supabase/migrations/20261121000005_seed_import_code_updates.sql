-- Deploy needs the exact links inserted by this call. The existing nightly RPCs still
-- return counts and share the same discovery and deduplication rules.
create function public.queue_import_candidates(token text, items jsonb, source text) returns text[]
language plpgsql security definer set search_path = '' as $$
declare
	is_wiki boolean := source = 'wiki';
	listed integer := jsonb_array_length(items);
	last integer;
	added text[];
begin
	if not public.is_nightly(token) then
		raise exception 'Only the nightly job can queue imports.';
	end if;
	if source is null or source not in ('wiki', 'octowow') then
		raise exception 'Unknown import source.';
	end if;
	if is_wiki then
		select w.entries into last from public.wiki_listing w where w.id;
		-- A list that is only starting out has nothing to measure against.
		if last >= 100 and listed < last * 0.8 then
			raise exception 'The wiki lists % addons, far fewer than the % it listed last time. Nothing was queued: check that the page still reads properly.', listed, last;
		end if;
	end if;

	with entries as materialized (
		-- Each entry with its key, worked out once, and its place in the source listing.
		select i, public.link_key(i ->> 'url') as key, place
		from jsonb_array_elements(items) with ordinality as listed_entries(i, place)
		where btrim(coalesce(i ->> 'name', '')) <> ''
			and (i ->> 'url') ~ case when is_wiki then '^https://\S+$'
				else '^https://octowow\.st/git/[^/?#[:space:]]+/[^/?#[:space:]]+$' end
	),
	ordered_entries as (
		select e.*, row_number() over (partition by e.key order by e.place) as occurrence
		from entries e
	),
	live as materialized (
		select distinct unnest(a.link_keys) as key from public.addons a
	),
	taken as materialized (
		-- Every link that is live, and the other address of a repository that is live under
		-- its old or its new one: a renamed repository is the same addon under either.
		select key from live
		union
		select s.key from public.repo_stats s where s.canonical in (select key from live)
		union
		select s.canonical from public.repo_stats s where s.canonical is not null and s.key in (select key from live)
	),
	queued as (
		insert into public.import_queue (
			key, url, name, description, images, alts, category, obsolete, parent, group_key, source
		)
		select
			e.key,
			e.i ->> 'url',
			left(btrim(e.i ->> 'name'), 120),
			coalesce(e.i ->> 'description', ''),
			array(select jsonb_array_elements_text(coalesce(e.i -> 'images', '[]'))),
			array(select jsonb_array_elements_text(coalesce(e.i -> 'alts', '[]'))),
			case when is_wiki then coalesce(e.i ->> 'category', 'Miscellaneous') else '' end,
			coalesce((e.i ->> 'obsolete')::boolean, false),
			e.i ->> 'parent',
			nullif(e.i ->> 'group_key', ''),
			case when is_wiki then 'Turtle WoW Wiki' else 'OctoWoW' end
		from ordered_entries e
		where (is_wiki or e.occurrence = 1)
			and not exists (select 1 from taken t where t.key = e.key)
		-- Queued in the order the source lists them, as before.
		order by e.place
		on conflict (key) do update set category = excluded.category
			where is_wiki and import_queue.status = 'pending' and import_queue.category is distinct from excluded.category
		-- xmax is 0 for a row this statement inserted, and not for one it changed.
		returning url, (xmax = 0) as is_new
	)
	select coalesce(array_agg(url) filter (where is_new), '{}') into added from queued;

	if is_wiki then
		insert into public.wiki_listing (id, entries) values (true, listed)
		on conflict (id) do update set entries = excluded.entries, at = now();
	else
		perform public.store_repository_mirrors(token, items);
	end if;
	return added;
end;
$$;

revoke all on function public.queue_import_candidates(text, jsonb, text) from public, authenticated, service_role;
grant execute on function public.queue_import_candidates(text, jsonb, text) to anon;

create or replace function public.queue_imports(token text, items jsonb) returns integer
language sql security definer set search_path = '' as $$
 select cardinality(public.queue_import_candidates(token, items, 'wiki'));
$$;

create or replace function public.queue_octowow_imports(token text, items jsonb) returns integer
language sql security definer set search_path = '' as $$
 select cardinality(public.queue_import_candidates(token, items, 'octowow'));
$$;
drop function public.queue_octowow_candidates(text, jsonb);

-- Deploy fills missing dates. Leave an existing date alone if Nightly has already
-- checked the same link while Deploy was fetching it.
create function public.seed_import_code_updates(token text, updates jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare saved text[];
begin
 if not public.is_nightly(token) then raise exception 'Only the nightly job can store code updates.'; end if;

 -- Approval locks the same queue row. Whichever runs second can see the first one's
 -- work, so the published page gets the date even if approval races with this write.
 perform q.id from public.import_queue q
 where q.status in ('pending', 'approved')
  and q.url in (select i->>'url' from jsonb_array_elements(updates) i)
 order by q.id for update;

 with inserted as (
  insert into public.repo_code_updates (url, committed_at, history_url)
  select u.url, u.date, u.history_url
  from jsonb_to_recordset(updates) as u(url text, date timestamptz, history_url text)
  join public.import_queue q on q.url = u.url
  where u.date is not null and u.history_url is not null
   and (q.status = 'pending' or (q.status = 'approved' and exists (
    select 1 from public.addons a, jsonb_array_elements(a.versions) v where v->>'url' = u.url
   )))
  on conflict (url) do nothing
  returning url
 )
 select coalesce(array_agg(url), '{}') into saved from inserted;

 if cardinality(saved) > 0 then
  perform set_config('app.doing', 'code_refresh', true);
  update public.addons a set versions = a.versions
  where exists (select 1 from jsonb_array_elements(a.versions) v where v->>'url' = any(saved));
  perform set_config('app.doing', '', true);
 end if;
 return cardinality(saved);
end;
$$;
revoke all on function public.seed_import_code_updates(text, jsonb) from public, authenticated, service_role;
grant execute on function public.seed_import_code_updates(text, jsonb) to anon;

notify pgrst, 'reload schema';
