import { forgePlace, forgeReadme, type Ask } from './forges.ts';
import { imagesIn, isGithubRepo, readmeImages } from './github.ts';
import { hostAllowed } from './hosts.ts';
import { linkError } from './link-validation.ts';
import { githubPlace } from './links.ts';
import { supabase } from './supabase.ts';

export function readmeRepository(url: string) {
	if (linkError(url) || !hostAllowed(url.trim(), 'link')) return '';
	if (isGithubRepo(url)) {
		const place = githubPlace(url);
		return place ? `github.com/${place.owner}/${place.name}`.toLowerCase() : '';
	}
	const place = forgePlace(url);
	return place ? JSON.stringify([place.host, place.project, place.refKind, place.ref, place.path]) : '';
}

export async function repositoryImages(url: string, signal: AbortSignal): Promise<string[]> {
	if (!readmeRepository(url)) return [];
	if (isGithubRepo(url)) return readmeImages(url, signal);
	const place = forgePlace(url)!;

	if (place.host === 'octowow.st') {
		// OctoWoW's Git API does not allow requests from the site's browser origin.
		const result = await supabase?.functions.invoke<{ images: string[] }>('octowow-readme', {
			body: { url }, signal
		});
		if (!result?.data || result.error) throw new Error('Could not read the OctoWoW README.');
		return result.data.images;
	}

	const ask: Ask = async (endpoint, as) => {
		const response = await fetch(endpoint, { signal });
		return { status: response.status, body: response.ok ? await (as === 'json' ? response.json() : response.text()) : undefined };
	};
	const readme = await forgeReadme(place, ask);
	if (readme === undefined) throw new Error('Could not read the repository README.');
	return readme ? imagesIn(readme.text, readme.base) : [];
}
