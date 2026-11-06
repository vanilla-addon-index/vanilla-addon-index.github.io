-- Client mods reuse the existing, history-aware category field for their kind.
alter table public.addons drop constraint if exists addons_category_check;

create or replace function public.addons_client_kind() returns trigger
language plpgsql set search_path = '' as $$
begin
 if new.entry_type = 'dll' and new.category not in ('Util','DLL','MPQ') then
  new.category := 'DLL';
 elsif new.entry_type = 'addon' and new.category in ('Util','DLL','MPQ') then
  new.category := 'Miscellaneous';
 end if;
 return new;
end;
$$;
drop trigger if exists addons_ac_client_kind on public.addons;
create trigger addons_ac_client_kind before insert or update on public.addons
 for each row execute function public.addons_client_kind();

update public.addons set category = 'DLL'
where entry_type = 'dll' and category not in ('Util','DLL','MPQ');

alter table public.addons add constraint addons_category_check check (
 (entry_type = 'addon' and category in (
 'Action Bars', 'Auction & Economy', 'Bags & Inventory', 'Boss Mods',
 'Buffs & Debuffs', 'Chat & Social', 'Class', 'Combat', 'Hardcore', 'Libraries', 'Loot Distribution',
 'Macros', 'Map & Minimap', 'Professions', 'PvP', 'Quests & Leveling', 'Raid & Party',
 'Roleplay', 'Tooltip', 'UI & Appearance', 'Unit Frames', 'Miscellaneous'
 )) or (entry_type = 'dll' and category in ('Util','DLL','MPQ'))
);
