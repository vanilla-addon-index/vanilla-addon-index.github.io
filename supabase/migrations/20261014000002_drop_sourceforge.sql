-- sourceforge.net leaves the sites a member's link may be on. It is a download site that
-- also offers repositories, not a place addons are kept: the wiki's list has no link to
-- it, and its links name a project and nobody. An admin can still list one from anywhere.

-- Replaces the version in the faster queue and hosts migration. LINK_HOSTS in
-- src/lib/config.ts is the same list; a test compares the two.
create or replace function public.allowed_hosts(kind text) returns text[]
language sql immutable set search_path = '' as $$
	select case kind
		when 'link' then array[
			'github.com', 'gitlab.com', 'codeberg.org', 'bitbucket.org', 'gitea.com',
			'octowow.st/git'
		]
		when 'image' then array[
			'github.com', '*.githubusercontent.com', 'gitlab.com', 'codeberg.org',
			'i.imgur.com', 'i.postimg.cc', 'i.ibb.co'
		]
	end;
$$;
