-- Run once in the Supabase SQL editor, after reports.sql. Safe to run again.
--
-- The form on the site checks what is typed into it, but anyone with an account can also
-- write to the database directly. These rules hold whichever way an addon arrives:
--   * the category is one from the site's list
--   * a link carries its address and its note, and nothing else
--   * links and screenshot addresses have a length limit
--   * the name is tidied, so it cannot be blank or hold line breaks

-- Must match CATEGORIES in src/lib/config.ts; a test compares the two.
alter table public.addons drop constraint if exists addons_category_check;
alter table public.addons add constraint addons_category_check check (
	category in (
		'Action Bars',
		'Auction & Economy',
		'Bags & Inventory',
		'Boss Mods',
		'Buffs & Debuffs',
		'Chat & Social',
		'Class',
		'Combat',
		'Interface Suites',
		'Libraries',
		'Map & Minimap',
		'Professions',
		'PvP',
		'Quests & Leveling',
		'Raid & Party',
		'Tooltip',
		'Unit Frames',
		'Miscellaneous'
	)
);

create or replace function public.addons_clean() returns trigger
language plpgsql set search_path = '' as $$
declare
	longest integer;
begin
	-- Runs of spaces, tabs and line breaks become one space; the 2 to 60 character rule
	-- on the column then applies to what is left.
	new.name := btrim(regexp_replace(new.name, '\s+', ' ', 'g'));
	new.author := btrim(regexp_replace(new.author, '\s+', ' ', 'g'));

	-- Only the address and the note of each link are kept. Whether they are sound is
	-- checked next, by addons_links.
	if jsonb_typeof(new.versions) = 'array' then
		select
			coalesce(jsonb_agg(jsonb_build_object('url', v ->> 'url', 'note', coalesce(v ->> 'note', '')) order by position), '[]'),
			max(char_length(v ->> 'url'))
		into new.versions, longest
		from jsonb_array_elements(new.versions) with ordinality as each(v, position);
		if longest > 300 then
			raise exception 'A link can be at most 300 characters.';
		end if;
	end if;

	if exists (select 1 from unnest(new.images) image where char_length(image) > 500) then
		raise exception 'A screenshot link can be at most 500 characters.';
	end if;
	return new;
end;
$$;

-- Named to run before addons_links and addons_slug, which use the tidied values.
drop trigger if exists addons_clean on public.addons;
create trigger addons_clean
	before insert or update on public.addons
	for each row execute function public.addons_clean();
