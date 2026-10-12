-- Two repairs.
--
-- 1. The nightly import was stopped by the database for taking too long. The job signs in
--    like any visitor, and a visitor's statement gets three seconds. queue_imports worked
--    out each wiki entry's key again for every repository it compared it with: about a
--    thousand entries against about a thousand repositories, a million times through the
--    same few rules, and more with every addon that was approved. Each key is now worked
--    out once, and the links that are already taken are gathered once, so the time no
--    longer grows with the list. What it queues and refuses is unchanged.
--
-- 2. git.sr.ht leaves the sites a member's link may be on: nobody keeps a World of
--    Warcraft addon there. An admin can still list one from anywhere.

-- Replaces the version in the allowed hosts migration. LINK_HOSTS in src/lib/config.ts
-- is the same list; a test compares the two.
create or replace function public.allowed_hosts(kind text) returns text[]
language sql immutable set search_path = '' as $$
	select case kind
		when 'link' then array[
			'github.com', 'gitlab.com', 'codeberg.org', 'bitbucket.org', 'sourceforge.net', 'gitea.com',
			'octowow.st/git'
		]
		when 'image' then array[
			'github.com', '*.githubusercontent.com', 'gitlab.com', 'codeberg.org',
			'i.imgur.com', 'i.postimg.cc', 'i.ibb.co'
		]
	end;
$$;

-- Replaces the version in the suggestion limit and wiki measure migration.
create or replace function public.queue_imports(token text, items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
	listed integer := jsonb_array_length(items);
	last integer;
	added integer;
begin
	if not public.is_nightly(token) then
		raise exception 'Only the nightly job can queue imports.';
	end if;

	select w.entries into last from public.wiki_listing w where w.id;
	-- A list that is only starting out has nothing to measure against.
	if last >= 100 and listed < last * 0.8 then
		raise exception 'The wiki lists % addons, far fewer than the % it listed last time. Nothing was queued: check that the page still reads properly.', listed, last;
	end if;

	with entries as materialized (
		-- Each entry with its key, worked out once, and its place on the wiki's page.
		select i, public.link_key(i ->> 'url') as key, place
		from jsonb_array_elements(items) with ordinality as listed_entries(i, place)
		where (i ->> 'url') ~ '^https://\S+$' and btrim(coalesce(i ->> 'name', '')) <> ''
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
			key, url, name, description, images, alts, category, obsolete, parent, group_key
		)
		select
			e.key,
			e.i ->> 'url',
			left(btrim(e.i ->> 'name'), 120),
			coalesce(e.i ->> 'description', ''),
			array(select jsonb_array_elements_text(coalesce(e.i -> 'images', '[]'))),
			array(select jsonb_array_elements_text(coalesce(e.i -> 'alts', '[]'))),
			coalesce(e.i ->> 'category', 'Miscellaneous'),
			coalesce((e.i ->> 'obsolete')::boolean, false),
			e.i ->> 'parent',
			nullif(e.i ->> 'group_key', '')
		from entries e
		where not exists (select 1 from taken t where t.key = e.key)
		-- Queued in the order the wiki lists them, as before.
		order by e.place
		on conflict (key) do update set category = excluded.category
			where import_queue.status = 'pending' and import_queue.category is distinct from excluded.category
		-- xmax is 0 for a row this statement inserted, and not for one it changed.
		returning (xmax = 0) as is_new
	)
	select count(*) filter (where is_new) into added from queued;

	insert into public.wiki_listing (id, entries) values (true, listed)
	on conflict (id) do update set entries = excluded.entries, at = now();
	return added;
end;
$$;
