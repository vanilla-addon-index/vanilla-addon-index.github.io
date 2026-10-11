import type { Handle } from '@sveltejs/kit/hooks';
import { SITE_NAME, SITE_URL } from '#lib/config.ts';
import { HOME_DESCRIPTION, HOME_TITLE, addonDescription, addonTitle } from '#lib/seo.ts';
import { readSnapshot } from '#lib/snapshot.server.ts';
import type { Addon } from '#lib/types.ts';

// Runs at build time only, while the pages are written out. The site draws itself in the
// browser, so without this every page would reach search engines and link previews empty.

const addons = readSnapshot();
const bySlug = new Map(addons.map((addon) => [addon.slug, addon]));

// Pages that are of no use in search results.
const PRIVATE = /^\/(admin|login|account|submit)(\/|$)/;

const esc = (text: string) =>
	text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

type Meta = { title: string; description: string; path: string; image?: string };

// The title and description for search results, and the og: tags that chat apps read to
// show a preview of a pasted link.
function head({ title, description, path, image }: Meta) {
	const url = SITE_URL + path;
	return [
		`<title>${esc(title)}</title>`,
		`<meta name="description" content="${esc(description)}">`,
		`<link rel="canonical" href="${esc(url)}">`,
		`<meta property="og:site_name" content="${esc(SITE_NAME)}">`,
		`<meta property="og:type" content="website">`,
		`<meta property="og:title" content="${esc(title)}">`,
		`<meta property="og:description" content="${esc(description)}">`,
		`<meta property="og:url" content="${esc(url)}">`,
		image ? `<meta property="og:image" content="${esc(image)}">` : '',
		`<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`
	].join('');
}

// The content itself, for readers that do not run scripts. Everyone else gets the real page.
const noscript = (html: string) => `<noscript><main class="mx-auto max-w-6xl px-4 py-5">${html}</main></noscript>`;

function addonPage(addon: Addon) {
	const links = addon.versions
		.map((v) => `<li><a href="${esc(v.url)}" rel="nofollow">${esc(v.url)}</a>${v.note ? ` ${esc(v.note)}` : ''}</li>`)
		.join('');
	return {
		head: head({
			title: addonTitle(addon),
			description: addonDescription(addon),
			path: `/addon/${addon.slug}`,
			image: addon.images[0]
		}),
		body: noscript(
			`<h1>${esc(addon.name)}</h1>` +
				`<p>${esc(addon.category)} addon for World of Warcraft 1.12.1${addon.author ? ` by ${esc(addon.author)}` : ''}</p>` +
				(addon.description ? `<p style="white-space: pre-line">${esc(addon.description)}</p>` : '') +
				`<ul>${links}</ul>` +
				`<p><a href="/">All addons</a></p>`
		)
	};
}

function homePage() {
	const list = addons
		.map((a) => `<li><a href="/addon/${esc(a.slug)}">${esc(a.name)}</a></li>`)
		.join('');
	return {
		head: head({ title: HOME_TITLE, description: HOME_DESCRIPTION, path: '/' }),
		body: noscript(`<h1>${esc(SITE_NAME)}</h1><p>${esc(HOME_DESCRIPTION)}</p><ul>${list}</ul>`)
	};
}

function describe(path: string, slug: string | undefined) {
	const addon = slug === undefined ? undefined : bySlug.get(slug);
	if (addon) return addonPage(addon);
	if (path === '/') return homePage();
	// Everything else, the fallback page for unknown addresses included.
	return {
		head: `<title>${esc(SITE_NAME)}</title>${PRIVATE.test(path) ? '<meta name="robots" content="noindex">' : ''}`,
		body: ''
	};
}

export const handle: Handle = ({ event, resolve }) => {
	const page = describe(event.url.pathname, event.params.slug);
	return resolve(event, {
		// Fonts are fetched with the scripts instead of after the first text is drawn; without
		// this a first visit shows the fallback font for a moment.
		preload: ({ type, path }) => type === 'js' || type === 'css' || path.endsWith('.woff2'),
		transformPageChunk: ({ html }) =>
			html.replace('</head>', () => `${page.head}</head>`).replace(/<body[^>]*>/, (body) => body + page.body)
	});
};
