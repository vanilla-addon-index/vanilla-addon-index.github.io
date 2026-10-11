// Both values are public by design (they ship in the browser bundle).
// Access control is enforced by row-level security, see supabase/schema.sql.
export const SUPABASE_URL = 'https://mefmmugajnbbotioplfw.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_sqg1NI9Q496ChlukskE_GQ_FCQBtgvK';

export const SITE_NAME = 'Vanilla Addon Index';
export const SITE_TAGLINE = 'Addons for the 1.12.1 client, in one place.';
// Where the site is served, without a trailing slash.
export const SITE_URL = 'https://vanilla-addon-index.github.io';
export const REPO_URL = 'https://github.com/vanilla-addon-index/vanilla-addon-index.github.io';

// Login providers. Each one must also be enabled in Supabase under Authentication -> Sign In / Providers.
export const OAUTH_PROVIDERS = ['discord', 'github'] as const;
export const PROVIDER_NAMES: Record<string, string> = { discord: 'Discord', github: 'GitHub' };

// Must match the check on addons.category in supabase/validation.sql; a test compares the two.
export const CATEGORIES = [
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
] as const;

// What the wiki import falls back to when it cannot guess. Posters must pick one themselves.
export const DEFAULT_CATEGORY = 'Miscellaneous';

// Must match the check on addons.images in supabase/schema.sql.
export const MAX_IMAGES = 5;

// Links per addon, the main one included. Must match addons_links() in supabase/versions.sql.
export const MAX_VERSIONS = 10;
