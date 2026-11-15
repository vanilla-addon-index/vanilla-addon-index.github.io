import { isDeepStrictEqual } from 'node:util';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../src/lib/config.ts';
import { repositoryRoot } from '../src/lib/mirrors.ts';
import { readOctowow } from '../src/lib/octowow.ts';
import { request } from '../src/lib/request.ts';

async function readListings() {
	const listings = new Map();
	const pageSize = 500;
	for (let offset = 0; ; offset += pageSize) {
		const url = new URL('/rest/v1/addons', SUPABASE_URL);
		url.search = new URLSearchParams({
			select: 'id,slug,versions',
			order: 'id',
			limit: String(pageSize),
			offset: String(offset)
		}).toString();
		const page = await request(url.href, {
			init: { headers: { apikey: SUPABASE_ANON_KEY } },
			read: response => response.json()
		});
		if (!Array.isArray(page)) throw new Error('The published addon list could not be read.');
		for (const addon of page) {
			for (const version of addon.versions) {
				const root = repositoryRoot(version.url);
				if (!root) continue;
				const matches = listings.get(root) ?? [];
				matches.push({ id: addon.id, slug: addon.slug, url: version.url });
				listings.set(root, matches);
			}
		}
		if (page.length < pageSize) return listings;
	}
}

async function auditArchive(mirrors) {
	const repo = 'vanilla-addon-index/addon-archive';
	const head = await request(`https://api.github.com/repos/${repo}/git/ref/heads/main`, {
		read: response => response.json()
	});
	const revision = head?.object?.sha;
	if (typeof revision !== 'string' || !/^[a-f0-9]{40}$/.test(revision)) {
		throw new Error('Could not identify the archive revision.');
	}
	const root = `https://raw.githubusercontent.com/${repo}/${revision}/`;
	const read = path => request(root + path, { read: response => response.json() });
	const registry = await read('.github/state/registry.json');
	const components = new Map();
	for (const entry of registry.entries) {
		for (const component of entry.components) {
			const url = repositoryRoot(component.originalUrl);
			if (!url) continue;
			const matches = components.get(url) ?? [];
			matches.push({
				status: component.status,
				path: [entry.folder, component.folder].filter(Boolean).join('/')
			});
			components.set(url, matches);
		}
	}

	for (let start = 0; start < mirrors.length; start += 5) {
		await Promise.all(mirrors.slice(start, start + 5).map(async row => {
			const copies = components.get(row.mirror) ?? [];
			const sources = components.get(row.source) ?? [];
			row.archive = { revision, copies, sources, matchingManifests: null };
			if (row.sourceListings.length !== 1 || copies.length !== 1 || sources.length !== 1
				|| copies[0].status !== 'mirrored' || sources[0].status !== 'mirrored'
				|| copies[0].path === sources[0].path) return;
			const [copy, source] = await Promise.all([copies[0], sources[0]].map(component =>
				read(component.path.split('/').map(encodeURIComponent).join('/') + '/mirror.json')
			));
			if (repositoryRoot(copy?.upstream) !== row.mirror || repositoryRoot(source?.upstream) !== row.source) return;
			const fields = ['sourceFiles', 'symlinks', 'releases'];
			row.archive.matchingManifests = fields.every(field =>
				copy[field] != null && source[field] != null && isDeepStrictEqual(copy[field], source[field])
			);
		}));
	}
}

const [candidates, listings] = await Promise.all([readOctowow(), readListings()]);
const mirrors = candidates.filter(candidate => candidate.mirror_source).map(candidate => ({
	mirror: candidate.url,
	source: candidate.mirror_source,
	sourceListings: listings.get(candidate.mirror_source) ?? [],
	mirrorListings: listings.get(candidate.url) ?? []
}));
if (process.argv.includes('--archive')) await auditArchive(mirrors);
console.log(JSON.stringify(mirrors, null, 2));
