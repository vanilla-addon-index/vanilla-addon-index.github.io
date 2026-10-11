-- A link into a folder of a GitHub repository is that folder, not the whole repository.
-- Some repositories are collections of many addons, one per folder; every link into one
-- used to count as the same link, so only one addon of a collection could be listed.
--
--   github.com/owner/repo                        -> github.com/owner/repo
--   github.com/owner/repo/tree/vanilla           -> github.com/owner/repo            (a branch)
--   github.com/owner/repo/tree/master/p/Atlas    -> github.com/owner/repo/p/atlas    (a folder)
--   github.com/owner/repo/blob/master/Atlas.zip  -> github.com/owner/repo/atlas.zip  (a file)
--
-- The branch is left out, so one folder reached through "master", "main" or a commit is
-- one link. A branch whose name has a slash in it reads as a folder; all that costs is
-- that such a link is not recognised as the repository's own.
--
-- linkKey() in src/lib/links.ts has the same rules; a test compares the two.
create or replace function public.link_key(url text) returns text
language sql immutable set search_path = '' as $$
	select case
		when u ~ '^github\.com/[^/]+/[^/]+' then
			regexp_replace(substring(u from '^github\.com/[^/]+/[^/]+'), '\.git$', '')
				|| coalesce('/' || substring(u from '^github\.com/[^/]+/[^/]+/(?:tree|blob)/[^/]+/(.*[^/])/*$'), '')
		else
			regexp_replace(regexp_replace(regexp_replace(u, '/-/.*$', ''), '/+$', ''), '\.git$', '')
	end
	from (
		select regexp_replace(regexp_replace(lower(btrim(url)), '^https?://(www\.)?', ''), '[?#].*$', '') as u
	) cleaned;
$$;

-- What is already stored under the old rule. No addon changes for a reader, so this is
-- no edit: not in the log, and "updated" stays as it was.
alter table public.addons disable trigger user;
update public.addons a
set link_keys = k.keys
from (
	select b.id, array_agg(distinct public.link_key(v ->> 'url')) as keys
	from public.addons b, jsonb_array_elements(b.versions) v
	group by b.id
) k
where k.id = a.id and a.link_keys is distinct from k.keys;
alter table public.addons enable trigger user;

-- The queue remembers every link it has ever held by its key, so those move too: first
-- the entries that point at one as the version they belong to, then the entries themselves.
update public.import_queue q
set group_key = public.link_key(m.url)
from public.import_queue m
where q.group_key = m.key and m.key <> public.link_key(m.url);
update public.import_queue set key = public.link_key(url) where key <> public.link_key(url);
