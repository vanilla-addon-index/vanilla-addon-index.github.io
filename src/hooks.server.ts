import type { Handle } from '@sveltejs/kit';

// Runs at build time only, while the pages are written out. The fonts are announced in each
// page's head, so the browser fetches them with the scripts instead of after the first text
// is drawn; without this a first visit shows the fallback font for a moment.
export const handle: Handle = ({ event, resolve }) =>
	resolve(event, {
		preload: ({ type, path }) => type === 'js' || type === 'css' || path.endsWith('.woff2')
	});
