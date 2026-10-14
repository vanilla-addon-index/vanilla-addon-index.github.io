import type { CodeUpdate } from './types.ts';

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** GitHub history is scoped to the linked branch and, for collections, addon folder. */
export function githubCodeQuery(ref: string, path: string): string {
	return `code: object(expression: ${JSON.stringify(ref)}) { ... on Commit { history(first: 1${path ? `, path: ${JSON.stringify(path)}` : ''}) { nodes { committedDate } } } }`;
}

export function githubCodeUpdate(repo: {
	nameWithOwner: string;
	code?: { history?: { nodes?: { committedDate?: string }[] } };
}, ref: string, path: string): CodeUpdate | null {
	const date = repo.code?.history?.nodes?.[0]?.committedDate;
	return date && Number.isFinite(Date.parse(date))
		? { date, url: `https://github.com/${repo.nameWithOwner}/commits/${encodeURIComponent(ref)}${path ? `/${encodePath(path)}` : ''}` }
		: null;
}
