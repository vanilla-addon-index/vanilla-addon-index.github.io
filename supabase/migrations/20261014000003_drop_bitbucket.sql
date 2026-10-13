-- bitbucket.org leaves the sites a member's link may be on: no addon on the wiki's list
-- is kept there. An admin can still list one from anywhere.

-- Replaces the version in the drop sourceforge migration. LINK_HOSTS in
-- src/lib/config.ts is the same list; a test compares the two.
create or replace function public.allowed_hosts(kind text) returns text[]
language sql immutable set search_path = '' as $$
	select case kind
		when 'link' then array[
			'github.com', 'gitlab.com', 'codeberg.org', 'gitea.com',
			'octowow.st/git'
		]
		when 'image' then array[
			'github.com', '*.githubusercontent.com', 'gitlab.com', 'codeberg.org',
			'i.imgur.com', 'i.postimg.cc', 'i.ibb.co'
		]
	end;
$$;

-- Replaces the version in the link author migration: an owner is read from a link on the
-- sites above and no other. linkAuthor() in src/lib/links.ts has the same rules, and a
-- test compares the two.
create or replace function public.link_author(url text) returns text
language sql immutable set search_path = '' as $$
	with link as (
		select regexp_match(btrim(url), '^(?:https?://)?(?:www\.)?([^/?#]+)/([^?#]*)', 'i') as m
	),
	parts as (
		select lower(m[1]) as host, array_remove(string_to_array(m[2], '/'), '') as path from link
	),
	owned as (
		select host,
			case
				when host <> 'octowow.st' then path
				when lower(path[1]) = 'git' then path[2:]
				else '{}'::text[]
			end as path
		from parts
	)
	select coalesce(
		(
			select path[1] from owned
			where host in ('github.com', 'gitlab.com', 'codeberg.org', 'gitea.com', 'octowow.st')
				and cardinality(path) >= 2
		),
		''
	);
$$;
