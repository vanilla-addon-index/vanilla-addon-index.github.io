alter table public.addons drop constraint addons_category_check;
alter table public.addons add constraint addons_category_check check (category in (
 'Action Bars', 'Auction & Economy', 'Bags & Inventory', 'Boss Mods',
 'Buffs & Debuffs', 'Chat & Social', 'Class', 'Combat', 'Libraries', 'Loot Distribution',
 'Macros', 'Map & Minimap', 'Professions', 'PvP', 'Quests & Leveling', 'Raid & Party',
 'Tooltip', 'UI & Appearance', 'Unit Frames', 'Miscellaneous'
));

-- Audited published tools: point systems, companion tools, reserves, rolls and
-- master-loot distribution. Never bulk-move everything that mentions loot.
update public.addons set category = 'Loot Distribution'
where category in ('Raid & Party', 'Chat & Social') and slug in (
 'dkplist', 'dkpauctionbidder', 'webdkpelysium', 'dpepgp', 'ez-epgp', 'epgpexport',
 'guildroll', 'titanguild', 'chaosreserves', 'chatlootbidder', 'easyloot', 'lootres',
 'rollfor', 'roundrobinhood', 'lootblare', 'lootblare2-0', 'raidrollbuddy',
 'raidrollhelper', 'smartroll', 'cleanrolls', 'xckmasterlootadvanced',
 'automasterlooter', 'masterlootbyclass'
);

notify pgrst, 'reload schema';
