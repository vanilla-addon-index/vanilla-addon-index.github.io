alter table public.addons drop constraint addons_category_check;
alter table public.addons add constraint addons_category_check check (category in (
 'Action Bars', 'Auction & Economy', 'Bags & Inventory', 'Boss Mods',
 'Buffs & Debuffs', 'Chat & Social', 'Class', 'Combat', 'Hardcore', 'Libraries', 'Loot Distribution',
 'Macros', 'Map & Minimap', 'Professions', 'PvP', 'Quests & Leveling', 'Raid & Party',
 'Roleplay', 'Tooltip', 'UI & Appearance', 'Unit Frames', 'Miscellaneous'
));

-- The 13 published entries audited for Hardcore, including HCWarn, HC-TradeBoard,
-- and SelfFound. Do not move generic death, healing, trading, or Turtle WoW tools.
update public.addons set category = 'Hardcore'
where (slug, category) in (
 ('clifftells', 'Chat & Social'),
 ('deathlog', 'Map & Minimap'),
 ('hardcorealarms', 'Miscellaneous'),
 ('hardcoredeath', 'Chat & Social'),
 ('hcdeaths', 'Miscellaneous'),
 ('hcfilter', 'Chat & Social'),
 ('hcrank', 'Tooltip'),
 ('hcwarn', 'Miscellaneous'),
 ('hc-tradeboard', 'Miscellaneous'),
 ('ripmap', 'Map & Minimap'),
 ('selffound', 'Auction & Economy'),
 ('turtlechatcolors', 'Chat & Social'),
 ('turtlehardcorechattamer', 'Chat & Social')
);

notify pgrst, 'reload schema';
