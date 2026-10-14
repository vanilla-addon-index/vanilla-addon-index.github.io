// What GitLab and the Gitea sites (Codeberg, gitea.com) say about a repository: the same
// facts the nightly job gets from GitHub, asked for the way anyone may, without a login.
// Nothing here fetches by itself: whoever calls hands in the function that does, so the
// job decides about timeouts and manners, and a test can answer in a site's place.

import type { CodeUpdate } from './types.ts';

const GITEA_HOSTS = ['codeberg.org', 'gitea.com'];
// The interface number a 1.12 addon declares in its .toc file.
const VANILLA_INTERFACE = 11200;
// A repository can ship a .toc per client; this many are read at most.
const TOC_PATHS = 4;

export interface ForgePlace {
	kind: 'gitlab' | 'gitea';
	host: string;
	/** "owner/repo", or "group/subgroup/repo" on GitLab, spelled as the link spells it. */
	project: string;
	/** The branch, tag or commit the link names; empty for the one the repository shows first. */
	ref: string;
	/** What kind of thing "ref" is, which a Gitea address has to say. */
	refKind: 'branch' | 'tag' | 'commit';
	/** The folder in the repository the link points to; empty for its top. */
	path: string;
}

/** One answer from a site: its status and what it sent. Nothing when it gave no usable answer. */
export type Ask = (url: string, as: 'json' | 'text') => Promise<{ status: number; body?: unknown } | null>;

export interface ForgeFacts {
	/** The repository's current "owner/repo": another one than asked for after a rename. */
	project: string;
	stars: number;
	pushed_at: string | null;
	code_update: CodeUpdate | null;
	archived: boolean;
	/** "owner/repo" of the repository this one was forked from. */
	fork_of: string | null;
	interface: number | null;
	/** False means a partial check: preserve the previously known game version. */
	interface_checked: boolean;
	missing: boolean;
	/** The README's text and its own raw address, when it was asked for and there is one. */
	readme: { text: string; base: string } | null;
	readme_checked: boolean;
}

const decode = (text: string) => {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
};
const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/**
 * Where on GitLab, Codeberg or gitea.com a link points: the repository and, when the link
 * names them, the branch and the folder in it. Nothing for a link to any other site.
 */
export function forgePlace(url: string): ForgePlace | null {
	const parts = /^(?:https?:\/\/)?(?:www\.)?([^/?#]+)\/([^?#]*)/i.exec(url.trim());
	if (!parts) return null;
	const host = parts[1].toLowerCase();
	const segments = parts[2].split('/').filter(Boolean).map(decode);
	const bare = (name: string) => name.replace(/\.git$/i, '');

	if (host === 'gitlab.com') {
		// Everything after "/-/" is a page of the project. Old links have no "/-/" and go
		// straight on with "/tree/branch".
		let end = segments.indexOf('-');
		let rest = end < 0 ? [] : segments.slice(end + 1);
		if (end < 0) {
			const old = segments.findIndex((s, i) => i >= 2 && (s === 'tree' || s === 'blob'));
			if (old >= 0) [end, rest] = [old, segments.slice(old)];
		}
		const project = end < 0 ? segments : segments.slice(0, end);
		if (project.length < 2) return null;
		project[project.length - 1] = bare(project[project.length - 1]);
		const inTree = rest[0] === 'tree' || rest[0] === 'blob';
		return {
			kind: 'gitlab',
			host,
			project: project.join('/'),
			ref: inTree ? (rest[1] ?? '') : '',
			refKind: 'branch',
			path: inTree ? rest.slice(2).join('/') : ''
		};
	}

	if (GITEA_HOSTS.includes(host)) {
		if (segments.length < 2) return null;
		// owner/repo/src/branch/main/Folder; a tag or a commit reads the same way.
		const kind = segments[2] === 'src' ? segments[3] : '';
		const inTree = kind === 'branch' || kind === 'tag' || kind === 'commit';
		return {
			kind: 'gitea',
			host,
			project: `${segments[0]}/${bare(segments[1])}`,
			ref: inTree ? (segments[4] ?? '') : '',
			refKind: inTree ? kind : 'branch',
			path: inTree ? segments.slice(5).join('/') : ''
		};
	}
	return null;
}

interface Entry {
	name: string;
	folder: boolean;
}

// How each kind of site is asked. Every address is one anyone may open without a login.
const SITES = {
	gitlab: {
		repo: (p: ForgePlace) => `https://${p.host}/api/v4/projects/${encodeURIComponent(p.project)}`,
		read: (r: Record<string, any>) => ({
			id: String(r.id),
			project: String(r.path_with_namespace ?? ''),
			stars: Number(r.star_count ?? 0),
			active: (r.last_activity_at as string | undefined) ?? null,
			archived: r.archived === true,
			branch: (r.default_branch as string | undefined) ?? '',
			parent: (r.forked_from_project?.path_with_namespace as string | undefined) ?? null
		}),
		commits: (api: string, ref: string, path: string) => `${api}/repository/commits?per_page=1&ref_name=${encodeURIComponent(ref)}${path ? `&path=${encodeURIComponent(path)}` : ''}`,
		history: (p: ForgePlace, project: string, ref: string) =>
			`https://${p.host}/${encodePath(project)}/-/commits/${encodeURIComponent(ref)}${p.path ? `/${encodePath(p.path)}` : ''}`,
		commitDate: (c: Record<string, any>) => c?.committed_date as string | undefined,
		list: (api: string, ref: string, path: string) =>
			`${api}/repository/tree?per_page=100&ref=${encodeURIComponent(ref)}${path ? `&path=${encodeURIComponent(path)}` : ''}`,
		entry: (e: Record<string, any>): Entry => ({ name: String(e.name), folder: e.type === 'tree' }),
		file: (api: string, ref: string, path: string) =>
			`${api}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`,
		raw: (p: ForgePlace, project: string, ref: string, path: string) =>
			`https://${p.host}/${encodePath(project)}/-/raw/${encodePath(ref)}/${encodePath(path)}`
	},
	gitea: {
		repo: (p: ForgePlace) => `https://${p.host}/api/v1/repos/${encodePath(p.project)}`,
		read: (r: Record<string, any>) => ({
			id: '',
			project: String(r.full_name ?? ''),
			stars: Number(r.stars_count ?? 0),
			active: (r.updated_at as string | undefined) ?? null,
			archived: r.archived === true,
			branch: (r.default_branch as string | undefined) ?? '',
			parent: (r.parent?.full_name as string | undefined) ?? null
		}),
		commits: (api: string, ref: string, path: string) =>
			`${api}/commits?limit=1&stat=false&verification=false&files=false&sha=${encodeURIComponent(ref)}${path ? `&path=${encodeURIComponent(path)}` : ''}`,
		history: (p: ForgePlace, project: string, ref: string) =>
			`https://${p.host}/${encodePath(project)}/commits/${p.refKind}/${encodeURIComponent(ref)}${p.path ? `/${encodePath(p.path)}` : ''}`,
		commitDate: (c: Record<string, any>) => (c?.commit?.committer?.date ?? c?.created) as string | undefined,
		list: (api: string, ref: string, path: string) => `${api}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
		entry: (e: Record<string, any>): Entry => ({ name: String(e.name), folder: e.type === 'dir' }),
		file: (api: string, ref: string, path: string) => `${api}/raw/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
		raw: (p: ForgePlace, project: string, ref: string, path: string) =>
			`https://${p.host}/${encodePath(project)}/raw/${p.refKind}/${encodePath(ref)}/${encodePath(path)}`
	}
};

/**
 * Asks a site about one repository. Nothing when the site gave no usable answer about the
 * repository itself, so that what is known from last time can stay as it is; a repository
 * the site says does not exist comes back as missing. A file or a list that could not be
 * read costs only that detail.
 */
export async function askForge(place: ForgePlace, ask: Ask, wantReadme = false): Promise<ForgeFacts | null> {
	const site = SITES[place.kind];
	const answer = await ask(site.repo(place), 'json');
	if (!answer) return null;
	if (answer.status === 404) {
		return { project: place.project, stars: 0, pushed_at: null, code_update: null, archived: false, fork_of: null, interface: null, interface_checked: true, missing: true, readme: null, readme_checked: false };
	}
	if (answer.status !== 200 || !answer.body || typeof answer.body !== 'object') return null;

	const repo = site.read(answer.body as Record<string, any>);
	if (!repo.project) return null;
	// GitLab's other addresses go by the project's number, Gitea's by its current name.
	const api = place.kind === 'gitlab' ? `https://${place.host}/api/v4/projects/${repo.id}` : `https://${place.host}/api/v1/repos/${encodePath(repo.project)}`;
	const facts: ForgeFacts = {
		project: repo.project,
		stars: repo.stars,
		pushed_at: repo.active,
		code_update: null,
		archived: repo.archived,
		fork_of: repo.parent,
		interface: null,
		interface_checked: false,
		missing: false,
		readme: null,
		readme_checked: false
	};
	// A repository with nothing in it has no branch to read.
	const ref = place.ref || repo.branch;
	if (!ref) {
		facts.interface_checked = true;
		facts.readme_checked = wantReadme;
		return facts;
	}

	// The public date only uses commits; general activity remains an admin hint.
	const commits = await ask(site.commits(api, ref, place.path), 'json');
	const last = commits?.status === 200 && Array.isArray(commits.body) ? site.commitDate(commits.body[0]) : undefined;
	if (last && Number.isFinite(Date.parse(last))) {
		facts.pushed_at = last;
		facts.code_update = { date: last, url: site.history(place, repo.project, ref) };
	}

	const listing = await ask(site.list(api, ref, place.path), 'json');
	if (listing?.status !== 200 || !Array.isArray(listing.body)) return facts;
	const entries = listing.body.map(site.entry);
	const within = place.path ? `${place.path}/` : '';
	const text = async (path: string): Promise<string | null> => {
		const file = await ask(site.file(api, ref, path), 'text');
		return file?.status === 404 ? '' : file?.status === 200 && typeof file.body === 'string' ? file.body : null;
	};

	// An addon's .toc is at the top of what the link points to, or one folder down in a
	// folder of the same name.
	const atTop = entries.filter((e) => !e.folder && /\.toc$/i.test(e.name)).map((e) => `${within}${e.name}`);
	const nested = entries.filter((e) => e.folder && !e.name.startsWith('.')).map((e) => `${within}${e.name}/${e.name}.toc`);
	const found: number[] = [];
	facts.interface_checked = true;
	for (const path of (atTop.length ? atTop : nested).slice(0, TOC_PATHS)) {
		const content = await text(path);
		if (content === null) facts.interface_checked = false;
		const number = /^##\s*Interface:\s*(\d+)/im.exec(content ?? '')?.[1];
		if (number) found.push(Number(number));
	}
	// A repository can ship .toc files for several clients; the 1.12 one is what matters.
	if (facts.interface_checked && found.length) facts.interface = found.includes(VANILLA_INTERFACE) ? VANILLA_INTERFACE : found[0];

	if (wantReadme) {
		const name = entries.find((e) => !e.folder && /^readme(\.(md|markdown|mdown|txt|rst))?$/i.test(e.name))?.name;
		const content = name ? await text(`${within}${name}`) : '';
		facts.readme_checked = content !== null;
		if (name && content !== null) facts.readme = { text: content, base: site.raw(place, repo.project, ref, `${within}${name}`) };
	}
	return facts;
}
