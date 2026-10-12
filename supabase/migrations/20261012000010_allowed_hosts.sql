-- Anyone with an account can post an addon, and nobody reviews it first: that is how the
-- list is meant to work. What a member posts is a link people will download from and
-- pictures their browsers will load, so both are kept to sites known for hosting code
-- and pictures. A link to some site of the poster's own, where anything could be
-- waiting, is refused.
--
-- A screenshot is only ever shown as a picture: an address that is not one shows nothing,
-- and is never offered as a link or a download. So the site it is kept on is what
-- matters, not how its address ends; GitHub itself serves many pictures from addresses
-- with no ending at all.
--
-- An admin is not held to any of this: an addon kept somewhere else is listed by asking
-- one, and the imports from the wiki, which an admin approves, keep the links they have.
-- A link or screenshot an addon already has stays when a member edits it.
--
-- LINK_HOSTS and IMAGE_HOSTS in src/lib/config.ts are the same lists,
-- and src/lib/hosts.ts reads an address the same way; a test compares them.

-- An entry that starts with "*." stands for every site under that name. One with a slash
-- in it stands for that part of a site only: "octowow.st/git" is what is under /git there.
create or replace function public.allowed_hosts(kind text) returns text[]
language sql immutable set search_path = '' as $$
	select case kind
		when 'link' then array[
			'github.com', 'gitlab.com', 'codeberg.org', 'bitbucket.org', 'sourceforge.net', 'gitea.com', 'git.sr.ht',
			'octowow.st/git'
		]
		when 'image' then array[
			'github.com', '*.githubusercontent.com', 'gitlab.com', 'codeberg.org',
			'i.imgur.com', 'i.postimg.cc', 'i.ibb.co'
		]
	end;
$$;

-- Whether an address is on one of those sites. The site is what comes between "https://"
-- and the first slash; an address that hides another site in front of an "@", or uses a
-- backslash, which browsers read as a slash, is refused whatever it claims to be. Where
-- only part of a site is allowed, so is an address that climbs back out of it with "..".
create or replace function public.host_allowed(url text, kind text) returns boolean
language sql immutable set search_path = '' as $$
	select coalesce(
		url !~ '\\'
		and site !~ '@'
		and exists (
			select 1
			from unnest(public.allowed_hosts(kind)) h
			cross join lateral (select nullif(substr(h, nullif(position('/' in h), 0)), '') as part) p
			where case
				when h like '*.%' then right(host, length(h) - 1) = substr(h, 2)
				when p.part is not null then
					host = split_part(h, '/', 1)
					and path !~* '(\.\.|%2e)'
					and (path = p.part or left(path, length(p.part) + 1) = p.part || '/')
				else host = h
			end
		),
		false
	)
	from (
		select
			site,
			lower(regexp_replace(regexp_replace(site, ':\d+$', ''), '^www\.', '', 'i')) as host,
			coalesce(substring(url from '^https://[^/?#]+([^?#]*)'), '') as path
		from (select substring(url from '^https://([^/?#]+)') as site) a
	) b;
$$;

create or replace function public.addons_hosts() returns trigger
language plpgsql set search_path = '' as $$
declare
	bad text;
begin
	-- The database's own work (auth.uid() is empty), an admin, and a restore from the trash.
	if auth.uid() is null or public.is_admin() or public.doing('restore') then
		return new;
	end if;

	-- Whether a link is sound at all is for addons_links to say, which runs after this.
	if jsonb_typeof(new.versions) = 'array' then
		select v ->> 'url' into bad
		from jsonb_array_elements(new.versions) v
		where (v ->> 'url') ~ '^https://\S+$'
			and not public.host_allowed(v ->> 'url', 'link')
			and (
				tg_op = 'INSERT'
				or not exists (select 1 from jsonb_array_elements(old.versions) o where o ->> 'url' = v ->> 'url')
			)
		limit 1;
		if bad is not null then
			raise exception 'The link must be on one of these sites: %. For an addon kept anywhere else, ask an admin to list it.',
				array_to_string(public.allowed_hosts('link'), ', ');
		end if;
	end if;

	select i into bad
	from unnest(new.images) i
	where i ~ '^https://\S+$'
		and not public.host_allowed(i, 'image')
		and (tg_op = 'INSERT' or not i = any (old.images))
	limit 1;
	if bad is not null then
		raise exception 'Screenshots must be kept on one of these sites: %.',
			array_to_string(public.allowed_hosts('image'), ', ');
	end if;

	return new;
end;
$$;

-- Named to run after addons_clean, which has tidied the links by then.
drop trigger if exists addons_hosts on public.addons;
create trigger addons_hosts
	before insert or update on public.addons
	for each row execute function public.addons_hosts();

grant execute on function public.allowed_hosts(text) to anon, authenticated;
grant execute on function public.host_allowed(text, text) to anon, authenticated;
