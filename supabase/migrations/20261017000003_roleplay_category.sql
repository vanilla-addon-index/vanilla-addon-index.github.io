alter table public.addons drop constraint addons_category_check;
alter table public.addons add constraint addons_category_check check (category in (
 'Action Bars', 'Auction & Economy', 'Bags & Inventory', 'Boss Mods',
 'Buffs & Debuffs', 'Chat & Social', 'Class', 'Combat', 'Libraries', 'Loot Distribution',
 'Macros', 'Map & Minimap', 'Professions', 'PvP', 'Quests & Leveling', 'Raid & Party',
 'Roleplay', 'Tooltip', 'UI & Appearance', 'Unit Frames', 'Miscellaneous'
));

-- Only the four audited dedicated RP tools. General social and cosmetic addons
-- keep their existing categories; do not infer RP from an emote or notes feature.
update public.addons set category = 'Roleplay'
where category = 'Chat & Social' and slug in (
 'turtlerp', 'erea-rp', 'roleplayinghelper', 'journal'
);

notify pgrst, 'reload schema';
