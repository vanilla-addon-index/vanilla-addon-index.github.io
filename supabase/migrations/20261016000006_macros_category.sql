alter table public.addons drop constraint addons_category_check;
alter table public.addons add constraint addons_category_check check (category in (
	'Action Bars', 'Auction & Economy', 'Bags & Inventory', 'Boss Mods',
	'Buffs & Debuffs', 'Chat & Social', 'Class', 'Combat', 'Libraries', 'Macros',
	'Map & Minimap', 'Professions', 'PvP', 'Quests & Leveling', 'Raid & Party',
	'Tooltip', 'UI & Appearance', 'Unit Frames', 'Miscellaneous'
));
notify pgrst, 'reload schema';
