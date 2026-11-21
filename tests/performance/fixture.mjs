import { createHash } from 'node:crypto';

export const ORIGIN = 'http://127.0.0.1:5182';
export const SUPABASE = 'https://supabase-performance.invalid';
export const SNAPSHOT_DATE = '2026-01-01T00:00:00+00:00';
const words = ('accounts actions alerts arena appearance armor attack bags bar buffs casting channels ' +
	'combat commands cooldowns custom damage display dungeons effects equipment events experience ' +
	'filters frames friends groups healing history icons items layout library links lists loot map ' +
	'memory messages mouse mounts notifications panel party pets players portraits preferences ' +
	'quests raid range recipes reputation resources spells stats targets text timers tooltips tracker ' +
	'trades units vendors warnings weapons window world').split(' ');

const digest = (value) => createHash('sha256').update(value).digest();

function addon(index) {
	const label = String(index).padStart(4, '0');
	const slug = `fixture-addon-${label}`;
	const author = `contributor-${digest(`author:${index}`).toString('hex').slice(0, 8)}`;
	const repo = `https://github.com/${author}/${slug}`;
	const commit = digest(`commit:${index}`).toString('hex').slice(0, 40);
	const terms = [...digest(`notes:${index}`)].map(byte => words[byte % words.length]);
	return {
		id: index, slug, name: `Fixture Addon ${label}`,
		description: `Adds a configurable ${terms[0]} panel to the default interface.\n\n` +
			`Available options include ${terms.slice(1, 17).join(', ')}. ` +
			`Settings are saved per character and can be reset from the options window. ` +
			`The display can also be adjusted for ${terms.slice(17).join(', ')}.`,
		similar_addons: '', entry_type: 'addon', category: index % 2 ? 'Combat' : 'UI & Appearance',
		author, versions: [{ url: repo, note: '' }], repo_url: repo, link_keys: [repo.slice(8)],
		aliases: [], images: index > 1 && index % 3 === 0 ? [`https://i.imgur.com/${commit.slice(0, 9)}.png`] : [],
		source: 'Fixture catalogue', group_id: null, is_main: false, created_at: '2025-12-01T00:00:00+00:00',
		updated_at: SNAPSHOT_DATE, code_update: { date: '2025-12-01', url: `${repo}/commit/${commit}` },
		link_code_updates: {}, unavailable_links: [], shared: false, pinned_link: null, separate_name: false
	};
}

export const addons = Array.from({ length: 1077 }, (_, i) => addon(i + 1));
export const published = addons[0];
export const mirror = {
	addon_id: published.id,
	url: 'https://gitlab.com/performance-fixture/mirror',
	source: published.repo_url
};
export const newAddon = {
	...addon(addons.length + 1), name: 'Fixture Live Addition', updated_at: '2026-01-02T00:00:00+00:00'
};

export const imports = Array.from({ length: 1200 }, (_, i) => {
	const label = String(i + 1).padStart(4, '0');
	const key = `github.com/fixture/import-${label}`;
	return {
		id: i + 1, name: `Fixture Import ${label}`, sort_name: `fixture import ${label}`,
		key, url: `https://${key}`, category: '', description: addons[i % addons.length].description,
		images: [], alts: [], entry_type: 'addon', source: 'Fixture queue', status: 'pending',
		repository_missing: false, review_bucket: 'incomplete',
		review_stats: { key, stars: i % 100, missing: false, archived: false, interface: 11200 }
	};
});
