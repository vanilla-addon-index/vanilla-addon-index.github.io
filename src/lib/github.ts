import { MAX_IMAGES } from './config.ts';

const REPO = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i;
// Markdown ![alt](url) and HTML <img src="url">.
const IMAGE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)|<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
// Build badges, donation buttons and the like are not screenshots.
const NOT_A_SCREENSHOT =
	/shields\.io|badgen\.net|badge|travis-ci|appveyor|codecov|ko-fi|paypal|buymeacoffee|patreon|liberapay|\.svg(?:[?#]|$)/i;

export const isGithubRepo = (url: string) => REPO.test(url.trim());

// Links to a file's page on github.com serve HTML; the raw host serves the image itself.
const toRaw = (url: string) =>
	url.replace(
		/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:blob|raw)\/(.+)$/i,
		'https://raw.githubusercontent.com/$1/$2/$3'
	);

/** Image links found in the README of a GitHub repository, in document order. */
export async function readmeImages(repoUrl: string): Promise<string[]> {
	const match = REPO.exec(repoUrl.trim());
	if (!match) return [];

	const res = await fetch(`https://api.github.com/repos/${match[1]}/${match[2]}/readme`, {
		headers: { Accept: 'application/vnd.github+json' }
	});
	if (res.status === 404) return [];
	if (!res.ok) throw new Error(`GitHub answered ${res.status}`);

	const { content, download_url } = (await res.json()) as { content: string; download_url: string };
	const bytes = Uint8Array.from(atob(content.replace(/\s/g, '')), (c) => c.charCodeAt(0));
	const readme = new TextDecoder().decode(bytes);

	const images = new Set<string>();
	for (const [, markdown, html] of readme.matchAll(IMAGE)) {
		try {
			// download_url is the README's raw address, so relative paths resolve next to it.
			const url = toRaw(new URL(markdown ?? html, download_url).href);
			if (url.startsWith('https://') && !/\s/.test(url) && !NOT_A_SCREENSHOT.test(url)) images.add(url);
		} catch {
			// Not a usable URL.
		}
	}
	return [...images].slice(0, MAX_IMAGES);
}
