-- Two changes to how the nightly job's wiki entries are taken in.
--
-- 1. A wiki page that suddenly lists far fewer addons is refused. The page is hand-written
--    markup: a renamed heading or a broken edit can make most of it unreadable without
--    any error, and the job would quietly queue what little was left. The queue remembers
--    every entry the wiki has ever had, so it is the measure: fewer than four fifths of
--    that is not a wiki that shrank, it is a page that was not read properly.
--
-- 2. The category of an entry that is still waiting follows the job's current guess.
--    Nobody can edit an entry in the queue, so its category is only ever that guess, and
--    a better rule should reach the entries already there.
--
-- Replaces queue_imports(text, jsonb) in the nightly token migration. Returns how many
-- entries are new, as before.
create or replace function public.queue_imports(token text, items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
	listed integer := jsonb_array_length(items);
	known integer;
	added integer;
begin
	if not public.is_nightly(token) then
		raise exception 'Only the nightly job can queue imports.';
	end if;

	select count(*) into known from public.import_queue;
	-- A queue that is only starting out has nothing to measure against.
	if known >= 100 and listed < known * 0.8 then
		raise exception 'The wiki lists % addons, far fewer than the % seen so far. Nothing was queued: check that the page still reads properly.', listed, known;
	end if;

	with taken as (
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
		on conflict (key) do update set category = excluded.category
			where import_queue.status = 'pending' and import_queue.category is distinct from excluded.category
		-- xmax is 0 for a row this statement inserted, and not for one it changed.
		returning (xmax = 0) as is_new
	)
	select count(*) filter (where is_new) into added from taken;
	return added;
end;
$$;
