// Both values are public by design (they ship in the browser bundle).
// Access control is enforced by row-level security, see the schema migration.
//
// `npm run dev:local` points the site at the copy of the backend running on this computer
// instead (see scripts/local.mjs), through these two settings in .env.localdb.
const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
export const SUPABASE_URL = env.VITE_SUPABASE_URL ?? 'https://mefmmugajnbbotioplfw.supabase.co';
export const SUPABASE_ANON_KEY = env.VITE_SUPABASE_ANON_KEY ?? 'sb_publishable_sqg1NI9Q496ChlukskE_GQ_FCQBtgvK';

// True when the site runs against that local copy. The login page then offers the test
// accounts, one click each, and the list is read from the database for everyone: the daily
// snapshot is of the real site.
export const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(SUPABASE_URL);

export const SITE_NAME = 'Vanilla Addon Index';
export const SITE_TAGLINE = 'Addons for the 1.12.1 client, in one place.';
// Where the site is served, without a trailing slash.
export const SITE_URL = 'https://vanilla-addon-index.github.io';
// Its public members are admins; the nightly job reads who they are.
export const GITHUB_ORG = 'vanilla-addon-index';
export const REPO_URL = 'https://github.com/vanilla-addon-index/vanilla-addon-index.github.io';

// Login providers. Each one must also be enabled in Supabase under Authentication -> Sign In / Providers.
export const OAUTH_PROVIDERS = ['discord', 'github'] as const;
export const PROVIDER_NAMES: Record<string, string> = { discord: 'Discord', github: 'GitHub' };

// Must match the check on addons.category in the validation migration; a test compares the two.
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

// The columns of an addon a visitor may read; see the private owner migration, which must
// list the same ones. Who posted or approved an addon is for accounts only.
export const PUBLIC_ADDON_COLUMNS =
	'id,slug,name,description,category,author,versions,repo_url,link_keys,aliases,images,source,group_id,is_main,created_at,updated_at';

// Must match the check on addons.images in the schema migration.
export const MAX_IMAGES = 5;

// Links per addon, the main one included. Must match addons_links() in the versions migration.
export const MAX_VERSIONS = 10;
