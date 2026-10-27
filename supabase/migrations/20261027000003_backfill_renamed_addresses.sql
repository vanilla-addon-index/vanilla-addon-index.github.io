-- Repair addresses left behind by renames made before automatic address updates.
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
	if exists (select 1 from public.addons a where a.id is distinct from new.id and (a.slug = new.slug or new.slug = any (a.aliases))) then
		host := public.slugify(
			case when split_part(key, '/', 1) = 'github.com' then split_part(key, '/', 2) else split_part(key, '/', 1) end
		);
		if host <> '' then
			stem := stem || '-' || host;
			new.slug := stem;
		end if;
	end if;
	while exists (select 1 from public.addons a where a.id is distinct from new.id and (a.slug = new.slug or new.slug = any (a.aliases))) loop
		n := n + 1;
		new.slug := stem || '-' || n;
	end loop;
	if tg_op = 'UPDATE' then
		-- Keep all earlier addresses, including across repeated renames and renames back.
		select coalesce(array_agg(distinct address order by address), '{}'::text[]) into new.aliases
		from unnest(old.aliases || new.aliases || array[old.slug]) address
		where address <> new.slug;
	end if;
	return new;
end;
$$;

-- Named to run after addons_links, which has checked the links by then.
drop trigger if exists addons_slug on public.addons;
create trigger addons_slug
	before insert or update of name on public.addons
	for each row execute function public.addons_slug();

-- Reuse the normal allocator, including collision protection and alias preservation.
-- Re-saving an unchanged name can also repair its address in future.
update public.addons set name = name where slug <> coalesce(nullif(public.slugify(name), ''), 'addon');
