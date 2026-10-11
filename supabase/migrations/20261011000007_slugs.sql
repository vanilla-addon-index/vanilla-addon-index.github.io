-- An addon's address (/addon/<slug>) is made by the database from its name. The site used
-- to send it, which let anyone with an account claim any free address, such as that of a
-- well-known addon not listed yet, for an entry with a different name.

-- "Big Wigs!" -> "big-wigs". slugify() in src/lib/addons.svelte.ts has the same rules.
create or replace function public.slugify(name text) returns text
language sql immutable set search_path = '' as $$
	select btrim(regexp_replace(normalize(lower(name), NFKD), '[^a-z0-9]+', '-', 'g'), '-');
$$;

-- Whatever address the client sends is replaced. Two addons with one name are told apart
-- by who hosts them (pfui, pfui-someone), and by a number after that.
create or replace function public.addons_slug() returns trigger
language plpgsql set search_path = '' as $$
declare
	key text := public.link_key(new.versions -> 0 ->> 'url');
	host text;
	stem text;
	n integer := 1;
begin
	-- A restored addon gets back the address it had.
	if public.doing('restore') then
		return new;
	end if;

	stem := coalesce(nullif(public.slugify(new.name), ''), 'addon');
	new.slug := stem;
	-- An address that once led to an addon merged into another still belongs to that one.
	if exists (select 1 from public.addons a where a.slug = new.slug or new.slug = any (a.aliases)) then
		host := public.slugify(
			case when split_part(key, '/', 1) = 'github.com' then split_part(key, '/', 2) else split_part(key, '/', 1) end
		);
		if host <> '' then
			stem := stem || '-' || host;
			new.slug := stem;
		end if;
	end if;
	while exists (select 1 from public.addons a where a.slug = new.slug or new.slug = any (a.aliases)) loop
		n := n + 1;
		new.slug := stem || '-' || n;
	end loop;
	return new;
end;
$$;

-- Named to run after addons_links, which has checked the links by then.
drop trigger if exists addons_slug on public.addons;
create trigger addons_slug
	before insert on public.addons
	for each row execute function public.addons_slug();

grant execute on function public.slugify(text) to anon, authenticated, service_role;
