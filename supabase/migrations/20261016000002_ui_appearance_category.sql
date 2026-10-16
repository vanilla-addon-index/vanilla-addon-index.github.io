-- Broaden the suite category to include smaller visual interface addons.
alter table public.addons drop constraint addons_category_check;

-- Normalize the old label on writes too, so existing history, trash restores and
-- browser tabs opened before deployment continue to work.
create function public.addons_category_alias() returns trigger
language plpgsql set search_path = '' as $$
begin
 if new.category = 'Interface Suites' then new.category := 'UI & Appearance'; end if;
 return new;
end;
$$;
revoke all on function public.addons_category_alias() from public, anon, authenticated, service_role;
create trigger addons_a_category_alias before insert or update on public.addons
 for each row execute function public.addons_category_alias();

update public.addons set category = 'UI & Appearance' where category = 'Interface Suites';
update public.import_queue set category = 'UI & Appearance' where category = 'Interface Suites';

-- Keep pending contributor proposals consistent with the renamed live category.
update public.addon_edit_requests
set base = case when base ->> 'category' = 'Interface Suites' then jsonb_set(base, '{category}', '"UI & Appearance"') else base end,
 changes = case when changes ->> 'category' = 'Interface Suites' then jsonb_set(changes, '{category}', '"UI & Appearance"') else changes end
where status = 'pending' and (base ->> 'category' = 'Interface Suites' or changes ->> 'category' = 'Interface Suites');

alter table public.addons add constraint addons_category_check check (category in (
'Action Bars',
	'Auction & Economy',
	'Bags & Inventory',
	'Boss Mods',
	'Buffs & Debuffs',
	'Chat & Social',
	'Class',
	'Combat',
	'Libraries',
	'Map & Minimap',
	'Professions',
	'PvP',
	'Quests & Leveling',
	'Raid & Party',
	'Tooltip',
	'UI & Appearance',
	'Unit Frames',
	'Miscellaneous'
));

notify pgrst, 'reload schema';
