import type { Ask } from './forges.ts';
import { request, type RequestMetrics } from './request.ts';

export interface RepositoryHttpCache {
	version: 1;
	endpoint: string;
	checkedAt: number;
	etag?: string;
	lastModified?: string;
	body: Record<string, unknown>;
}
const safeHeader = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\r\n]/.test(value);
const lastModified = (value: unknown): value is string => safeHeader(value) && Number.isFinite(Date.parse(value));

function repositoryHost(endpoint: string): string | null {
	try {
		const url = new URL(endpoint);
		if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password) return null;
		if (url.hostname === 'gitlab.com' && /^\/api\/v4\/projects\/[^/]+$/.test(url.pathname)) return url.hostname;
		if (url.hostname === 'octowow.st' && /^\/git\/api\/v1\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) return url.hostname;
		if (['codeberg.org', 'gitea.com'].includes(url.hostname) && /^\/api\/v1\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) return url.hostname;
	} catch { /* An invalid cached endpoint is a miss, never a fetch target. */ }
	return null;
}

/** Store only the public fields consumed by askForge, not large unrelated API data. */
function selectMetadata(body: any, host: string): Record<string, unknown> | null {
	if (!body || typeof body !== 'object' || Array.isArray(body) || !['string', 'number'].includes(typeof body.id)) return null;
	const stars = host === 'gitlab.com' ? body.star_count : body.stars_count;
	const updated = host === 'gitlab.com' ? body.last_activity_at : body.updated_at;
	if (!Number.isSafeInteger(stars) || stars < 0 || typeof body.archived !== 'boolean' ||
		!(typeof body.default_branch === 'string' || body.default_branch === null) ||
		!(updated === null || (typeof updated === 'string' && Number.isFinite(Date.parse(updated))))) return null;
	if (host === 'gitlab.com') {
		if (typeof body.path_with_namespace !== 'string' || !body.path_with_namespace) return null;
		if (body.forked_from_project && typeof body.forked_from_project.path_with_namespace !== 'string') return null;
		return { id: body.id, path_with_namespace: body.path_with_namespace, star_count: body.star_count,
			last_activity_at: body.last_activity_at, archived: body.archived, default_branch: body.default_branch,
			forked_from_project: body.forked_from_project ? { path_with_namespace: body.forked_from_project.path_with_namespace } : null };
	}
	if (typeof body.full_name !== 'string' || !body.full_name) return null;
	if (body.parent && typeof body.parent.full_name !== 'string') return null;
	return { id: body.id, full_name: body.full_name, stars_count: body.stars_count, updated_at: body.updated_at,
		archived: body.archived, default_branch: body.default_branch, parent: body.parent ? { full_name: body.parent.full_name } : null };
}

function metadata(body: unknown, host: string): Record<string, unknown> | null {
	const selected = selectMetadata(body, host);
	return selected && new TextEncoder().encode(JSON.stringify(selected)).length <= 8192 ? selected : null;
}

class MissingCachedResponse extends Error {}

/** Run-local sharing covers in-flight work and completed bounded failures. Only
 * repository GET validators persist; GraphQL and immutable branch caches stay separate. */
export function createForgeRequests({
	previous = [] as unknown[],
	observe = (_url: string): ((metrics: RequestMetrics) => void) | undefined => undefined,
	hit = (_kind: string) => {},
	now = () => Date.now()
} = {}) {
	const stored = new Map<string, RepositoryHttpCache>();
	const pending = new Map<string, ReturnType<Ask>>();
	for (const value of previous as any[]) {
		const host = value && repositoryHost(value.endpoint);
		if (!host || value.version !== 1 || !Number.isFinite(value.checkedAt) ||
			(!safeHeader(value.etag) && !lastModified(value.lastModified))) continue;
		const body = metadata(value.body, host);
		if (!body) continue;
		const old = stored.get(value.endpoint);
		if (!old || old.checkedAt < value.checkedAt) stored.set(value.endpoint, {
			version: 1, endpoint: value.endpoint, checkedAt: value.checkedAt, body,
			...(safeHeader(value.etag) ? { etag: value.etag } : {}),
			...(lastModified(value.lastModified) ? { lastModified: value.lastModified } : {})
		});
	}
	async function fetchAnswer(url: string, as: 'json' | 'text', conditional = true): ReturnType<Ask> {
		const host = as === 'json' ? repositoryHost(url) : null;
		const before = host && conditional ? stored.get(url) : undefined;
		try {
			return await request(url, {
				observe: observe(url), timeoutMs: 15_000, accept: [404, 304],
				init: { headers: {
					// OctoWoW challenges this custom agent even for public API requests.
					// Keep the runtime's default agent for all its metadata and file requests.
					...(new URL(url).hostname === 'octowow.st' ? {} : { 'User-Agent': 'vanilla-addon-index' }),
					Accept: as === 'json' ? 'application/json' : 'text/plain',
					...(before?.etag ? { 'If-None-Match': before.etag } : before?.lastModified ? { 'If-Modified-Since': before.lastModified } : {})
				} },
				read: async (response) => {
					if (response.status === 404) {
						await response.body?.cancel();
						if (host) stored.delete(url);
						return { status: 404 };
					}
					if (response.status === 304) {
						await response.body?.cancel();
						if (!before) throw new MissingCachedResponse('304 without a usable stored response.');
						const etag = response.headers.get('etag');
						const modified = response.headers.get('last-modified');
						stored.set(url, { ...before, checkedAt: now(),
							...(safeHeader(etag) ? { etag } : {}), ...(lastModified(modified) ? { lastModified: modified } : {}) });
						hit('rest_not_modified');
						return { status: 200, body: structuredClone(before.body) };
					}
					const type = response.headers.get('content-type') ?? '';
					if (as === 'json' ? !/json/i.test(type) : /html/i.test(type)) {
						await response.body?.cancel();
						throw new Error('The host sent an unexpected response type.');
					}
					const body = as === 'json' ? await response.json() : await response.text();
					if (host) {
						const selected = metadata(body, host);
						const etag = response.headers.get('etag');
						const modified = response.headers.get('last-modified');
						stored.delete(url);
						if (selected && (safeHeader(etag) || lastModified(modified))) stored.set(url, {
							version: 1, endpoint: url, checkedAt: now(), body: selected,
							...(safeHeader(etag) ? { etag } : {}), ...(lastModified(modified) ? { lastModified: modified } : {})
						});
						return { status: 200, body: selected ?? body };
					}
					return { status: 200, body };
				}
			});
		} catch (error) {
			if (error instanceof MissingCachedResponse && conditional) return fetchAnswer(url, as, false);
			return null;
		}
	}
	const ask: Ask = async (url, as) => {
		const key = JSON.stringify([url, as]);
		let answer = pending.get(key);
		if (answer) hit('rest_shared_request');
		else { answer = fetchAnswer(url, as); pending.set(key, answer); }
		return structuredClone(await answer);
	};
	return { ask, metadata: (endpoint: string) => structuredClone(stored.get(endpoint)) };
}
