// Public OctoWoW repositories become review candidates, never published addons.
import { linkKey } from './links.ts';
import { request, type RequestMetrics } from './request.ts';
import type { Candidate } from './wiki.ts';

export const OCTOWOW = 'https://octowow.st/git';
export const OCTOWOW_NAME = 'OctoWoW';

export async function readOctowow(observe?: (metrics: RequestMetrics) => void): Promise<Candidate[]> {
	const candidates = new Map<string, Candidate>();
	const pages = new Set<string>();
	for (let page = 1; page <= 200; page++) {
		const data = await request<{ ok: boolean; data: Record<string, unknown>[] }>(
			`${OCTOWOW}/api/v1/repos/search?limit=50&page=${page}&sort=alpha&order=asc`,
			{
				// Match repository checks: OctoWoW accepts Node's default User-Agent.
				// Custom agents and PowerShell requests can receive browser verification.
				observe, init: { headers: { Accept: 'application/json' } },
				read: response => response.json()
			}
		);
		if (data?.ok !== true || !Array.isArray(data.data)) throw new Error('OctoWoW did not return a repository listing.');
		if (!data.data.length) return [...candidates.values()];
		const signature = JSON.stringify(data.data.map(repo => repo.full_name));
		if (pages.has(signature)) throw new Error('OctoWoW repeated a listing page. Nothing was queued.');
		pages.add(signature);
		for (const repo of data.data) {
			if (repo.private === true || repo.empty === true) continue;
			if (typeof repo.full_name !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repo.full_name) || typeof repo.name !== 'string' || !repo.name.trim()) {
				throw new Error('OctoWoW returned an invalid repository. Nothing was queued.');
			}
			const url = `${OCTOWOW}/${repo.full_name.split('/').map(encodeURIComponent).join('/')}`;
			const key = linkKey(url);
			candidates.set(key, { key, url, name: repo.name, description: typeof repo.description === 'string' ? repo.description : '',
				images: [], alts: [], category: '', obsolete: repo.archived === true, parent: null, group_key: null });
		}
	}
	throw new Error('OctoWoW exceeded the listing page limit. Nothing was queued.');
}
