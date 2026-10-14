import { rateLimitFailure, request, RequestFailure, type RequestMetrics } from './request.ts';

export interface GithubAnswer {
	data: Record<string, any>;
	errors: { type?: string; message?: string; path?: (string | number)[] }[];
}

/** A failed parent, child, or global result makes the requested field incomplete. */
export function fieldFailed(errors: GithubAnswer['errors'], path: (string | number)[]): boolean {
	return errors.some((error) => !error.path?.length ||
		error.path.slice(0, Math.min(error.path.length, path.length)).every((part, i) => part === path[i]));
}

export async function askGithub(query: string, token: string, observe?: (metrics: RequestMetrics) => void): Promise<GithubAnswer> {
	return request('https://api.github.com/graphql', {
		observe,
		init: { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'vanilla-addon-index' }, body: JSON.stringify({ query }) },
		read: async (response) => {
			const { data, errors = [] } = await response.json();
			const limited = errors.find((e: GithubAnswer['errors'][number]) => e.type === 'RATE_LIMITED' || /rate limit|secondary limit/i.test(e.message ?? ''));
			if (limited) throw rateLimitFailure(response, 'GitHub GraphQL rate limit reached.');
			if (!data) throw new RequestFailure('GitHub returned no data.', errors.some((e: GithubAnswer['errors'][number]) =>
				['INTERNAL', 'SERVICE_UNAVAILABLE', 'TIMEOUT'].includes(e.type ?? '') || /temporar|timeout|timed out|something went wrong/i.test(e.message ?? '')));
			return { data, errors };
		}
	});
}
