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

/**
 * The picture behind an address of GitHub's image proxy. A README shown on github.com
 * loads its pictures through that proxy, and the proxy's address spells the real one out
 * in hexadecimal. Old proxy addresses stop working while the picture is still there, so
 * the real address is the one worth keeping. Any other address comes back as it is.
 */
export function uncamo(url: string): string {
	const hex = /^https:\/\/camo\.githubusercontent\.com\/[0-9a-f]+\/((?:[0-9a-f]{2})+)(?:[?#].*)?$/i.exec(url)?.[1];
	if (!hex) return url;
	try {
		const bytes = Uint8Array.from(hex.match(/../g)!, (pair) => parseInt(pair, 16));
		const real = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		return /^https?:\/\/\S+$/.test(real) ? real.replace(/^http:/, 'https:') : url;
	} catch {
		return url;
	}
}

/** Store GitHub attachments by their stable public address, not an expiring JWT URL. */
export function screenshotUrl(value: string): string {
 const url = toRaw(uncamo(value.trim()));
 const attachment = /^https:\/\/private-user-images\.githubusercontent\.com\/\d+\/\d+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[a-z0-9]+(?:[?#].*)?$/i.exec(url);
 return attachment ? `https://github.com/user-attachments/assets/${attachment[1].toLowerCase()}` : url;
}

/**
 * Image links in the text of a README, in document order. "base" is the README's own raw
 * address, so that a picture kept next to it in the repository resolves to where it is.
 */
export function imagesIn(readme: string, base: string): string[] {
	const images = new Set<string>();
	for (const [, markdown, html] of readme.matchAll(IMAGE)) {
		try {
			const url = screenshotUrl(new URL(markdown ?? html, base).href);
			if (url.startsWith('https://') && !/\s/.test(url) && !NOT_A_SCREENSHOT.test(url)) images.add(url);
		} catch {
			// Not a usable URL.
		}
	}
	return [...images].slice(0, MAX_IMAGES);
}

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
	// download_url is the README's raw address, so relative paths resolve next to it.
	return imagesIn(new TextDecoder().decode(bytes), download_url);
}
