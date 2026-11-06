// Display fixtures based on user-supplied references, never production imports.
// Download links are deliberately empty until the real repositories are verified.
const entries = [
	['VanillaFixes', 'UI & Appearance', 'Rendering and client patching reference.'],
	['DXVK', 'UI & Appearance', 'Rendering compatibility reference.'],
	['Vanilla Tweaks', 'UI & Appearance', 'Client patching and customization reference.'],
	['VanillaHelpers', 'Libraries', 'Core engine and API plugin reference.'],
	['PerfBoost', 'Miscellaneous', 'Performance plugin reference supplied with an accompanying addon.', 'avitasia'],
	['UnitXP_SP3', 'Libraries', 'DLL and UnitXP_SP3_Addon are distributed together in releases.'],
	['SuperWoW', 'Libraries', 'Client mod reference with a separate SuperAPI addon.'],
	['ClassicAPI', 'Libraries', 'Core engine and API plugin reference.'],
	['AuctionQueryThrottle', 'Auction & Economy', 'Auction query plugin reference.'],
	['Nampower', 'Libraries', 'Client mod reference with an accompanying addon.'],
	['No1600x1200', 'UI & Appearance', 'Display-related client plugin reference.'],
	['VanillaMultiMonitorFix', 'UI & Appearance', 'Multi-monitor client plugin reference.'],
	['Interact', 'Miscellaneous', 'Core engine plugin reference.'],
	['WowPresence', 'Chat & Social', 'Presence integration reference.', 'Dusk-92'],
	...['weirdperformance', 'transmogfix', 'bigcursor', 'customassets', 'logsessions', 'minimapicons', 'pngscreenshots', 'worldmarkers'].map(name => [
		`${name}.dll`, name === 'minimapicons' ? 'Map & Minimap' : 'Miscellaneous',
		'WeirdUtils module reference. Some components are supplied as pre-compiled binaries; consult the project documentation and releases.'
	])
];

const quote = value => `'${String(value).replaceAll("'", "''")}'`;

/** Add missing demo entries only; preserve existing entries and local edits. */
export function dllDemoSql() {
	return entries.map(([name, category, description, author = '']) => `
insert into public.addons (name, description, category, author, entry_type, versions, shared, source, owner)
select ${quote(name)}, ${quote(`${description}\n\nLocal demo data for layout review. Download links and compatibility have not been verified.`)},
 ${quote(category)}, ${quote(author)}, 'dll', '[]'::jsonb, true, 'Local DLL demo', null
where not exists (select 1 from public.addons where public.addon_name_key(name) = public.addon_name_key(${quote(name)}));
`).join('\n');
}
