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

export function groupChecks<T>(rows: T[], key: (row: T) => string): T[][] {
	const groups = new Map<string, T[]>();
	for (const row of rows) {
		const id = key(row);
		const group = groups.get(id);
		if (group) group.push(row);
		else groups.set(id, [row]);
	}
	return [...groups.values()];
}

export const githubRepositoryKey = (row: { owner: string; name: string }): string =>
	JSON.stringify([row.owner.toLowerCase(), row.name.toLowerCase()]);

/** Share network fields without merging stored URLs or error boundaries. Expand every
 * shared alias back to its original row, including NOT_FOUND and partial field errors. */
export async function sharedGithubChecks<T extends { owner: string; name: string }>(
	rows: T[], key: (row: T) => string, fields: (group: T[]) => string,
	send: (query: string) => Promise<GithubAnswer | null>, shared: (saved: number) => void = () => {}
): Promise<(GithubAnswer & { gone: Set<string> }) | null> {
	const groups = groupChecks(rows.map((row, index) => ({ row, index })), (entry) => key(entry.row));
	const query = `{${groups.map((group, index) => {
		const { owner, name } = group[0].row;
		return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields(group.map((entry) => entry.row))} }`;
	}).join(' ')}}`;
	shared(rows.length - groups.length);
	const answer = await send(query);
	if (!answer) return null;
	const data: GithubAnswer['data'] = {};
	const errors: GithubAnswer['errors'] = [];
	groups.forEach((group, index) => {
		for (const { index: original } of group) data[`r${original}`] = answer.data[`r${index}`];
	});
	for (const error of answer.errors) {
		if (!error.path?.length) { errors.push(error); continue; }
		const index = /^r(\d+)$/.exec(String(error.path[0]))?.[1];
		const group = index === undefined ? undefined : groups[Number(index)];
		if (!group) { errors.push({ ...error, path: undefined }); continue; }
		for (const { index: original } of group) errors.push({ ...error, path: [`r${original}`, ...error.path.slice(1)] });
	}
	return { data, errors, gone: new Set(errors.filter((e) => e.type === 'NOT_FOUND' && e.path?.length === 1).map((e) => String(e.path![0]))) };
}
