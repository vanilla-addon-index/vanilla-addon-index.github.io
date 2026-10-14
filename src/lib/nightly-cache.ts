// Bump this version when parsing or file-selection rules change: the same commit must
// then be checked again. Cache entries are private, keyed by the original complete URL.
export const CHECK_CACHE_VERSION = 1;
export const gitOid = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
export const validDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

export interface GithubTreeEntry { name: string; type: string; oid: string }
export interface GithubCheckCache {
	version: number;
	kind: 'github';
	scope: string;
	identity: string;
	canonical: string;
	head: string;
	history?: { date: string | null };
	tree?: { oid: string | null; entries: GithubTreeEntry[] };
	toc?: { signature: string; interface: number | null; files: { path: string; oid: string | null }[] };
	readme?: { file: string; oid: string; images: string[] };
}

export function githubScope(owner: string, name: string, ref: string, path: string): string {
	return JSON.stringify([owner.toLowerCase(), name.toLowerCase(), ref, path]);
}

/** Invalid, stale-parser or differently scoped cache data is always a miss. */
export function githubCache(value: any, scope: string): GithubCheckCache | undefined {
	if (!value || value.version !== CHECK_CACHE_VERSION || value.kind !== 'github' || value.scope !== scope ||
		typeof value.identity !== 'string' || typeof value.canonical !== 'string' || !gitOid(value.head)) return;
	const result: GithubCheckCache = {
		version: value.version, kind: 'github', scope, identity: value.identity, canonical: value.canonical, head: value.head
	};
	if (value.history && (value.history.date === null || validDate(value.history.date))) result.history = value.history;
	if (value.tree && (value.tree.oid === null || gitOid(value.tree.oid)) && Array.isArray(value.tree.entries) &&
		value.tree.entries.every((e: any) => typeof e?.name === 'string' && ['blob', 'tree'].includes(e.type) && gitOid(e.oid))) result.tree = value.tree;
	if (value.toc && typeof value.toc.signature === 'string' && (value.toc.interface === null || Number.isInteger(value.toc.interface)) &&
		Array.isArray(value.toc.files) && value.toc.files.every((f: any) => typeof f?.path === 'string' && (f.oid === null || gitOid(f.oid)))) result.toc = value.toc;
	if (value.readme && typeof value.readme.file === 'string' && gitOid(value.readme.oid) && Array.isArray(value.readme.images) &&
		value.readme.images.every((image: any) => typeof image === 'string' && image.startsWith('https://'))) result.readme = value.readme;
	return structuredClone(result);
}

/** A replaced repository or rename invalidates everything. A new commit invalidates
 * branch results, but file signatures can still reuse an unchanged .toc or README. */
export function advanceGithubCache(previous: GithubCheckCache | undefined, scope: string, identity: unknown, canonical: string, head: unknown): GithubCheckCache | undefined {
	if (typeof identity !== 'string' || !identity || typeof canonical !== 'string' || !canonical || !gitOid(head)) return;
	const matching = previous?.identity === identity && previous.canonical === canonical && previous.scope === scope;
	if (matching && previous.head === head) return structuredClone(previous);
	return { version: CHECK_CACHE_VERSION, kind: 'github', scope, identity, canonical, head,
		...(matching ? { toc: previous.toc, readme: previous.readme } : {}) };
}

/** Only selected .toc candidates and the README are needed in the persisted tree. */
export function githubFiles(entries: { name: string; type: string; oid?: string }[], path: string, limit: number) {
	const prefix = path ? `${path}/` : '';
	const top = entries.filter((e) => e.type === 'blob' && /\.toc$/i.test(e.name));
	const chosen = (top.length ? top : entries.filter((e) => e.type === 'tree' && !e.name.startsWith('.'))).slice(0, limit);
	const paths = chosen.map((e) => `${prefix}${e.type === 'blob' ? e.name : `${e.name}/${e.name}.toc`}`);
	const signature = chosen.every((e) => gitOid(e.oid)) ? JSON.stringify(chosen.map((e, i) => [paths[i], e.oid])) : null;
	const readme = entries.find((e) => e.type === 'blob' && /^readme(\.(md|markdown|mdown|txt|rst))?$/i.test(e.name));
	return { paths, signature, readme, entries: [...chosen, ...(readme ? [readme] : [])] };
}

export interface ForgeCheckCache {
	version: number;
	kind: 'forge';
	scope: string;
	identity: string;
	head: string;
	history?: { date: string };
	toc?: { signature: string | null; interface: number | null };
	readme?: { text: string; base: string } | null;
}

export interface ForgeCacheControl {
	previous?: unknown;
	save: (state: ForgeCheckCache) => void;
	hit: (kind: string) => void;
}

export function forgeCache(value: any, scope: string, identity: string): ForgeCheckCache | undefined {
	if (!value || value.version !== CHECK_CACHE_VERSION || value.kind !== 'forge' || value.scope !== scope ||
		value.identity !== identity || !gitOid(value.head)) return;
	const state: ForgeCheckCache = { version: value.version, kind: 'forge', scope, identity, head: value.head };
	if (validDate(value.history?.date)) state.history = value.history;
	if (value.toc && (typeof value.toc.signature === 'string' || value.toc.signature === null) &&
		(value.toc.interface === null || Number.isInteger(value.toc.interface))) state.toc = value.toc;
	if (value.readme === null || (typeof value.readme?.text === 'string' && typeof value.readme?.base === 'string')) state.readme = value.readme;
	return structuredClone(state);
}
