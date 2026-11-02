import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';
import { SUPABASE_URL } from './src/lib/config.ts';

export default defineConfig(({ mode }) => {
	// The local copy of the backend under `npm run dev:local`, the hosted one otherwise.
	const database = new URL(loadEnv(mode, process.cwd(), 'VITE_').VITE_SUPABASE_URL ?? SUPABASE_URL)
		.origin as `https://${string}.${string}`;

	return {
		plugins: [
			tailwindcss(),
			sveltekit({
				compilerOptions: {
					// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
					runes: ({ filename }) =>
						filename.split(/[/\\]/).includes('node_modules') ? undefined : true
				},

				// GitHub Pages serves 404.html for unknown paths, which boots the SPA for deep links.
				adapter: adapter({ fallback: '404.html' }),

				// What a page may load and talk to; the browser refuses the rest. The site inserts
				// no HTML of its own making, so this is a second lock: should a script ever get
				// into a page, it still does not run, and the login kept in the browser stays
				// out of its reach. Written into each page as a <meta> tag, with the hash of the
				// one inline script the page starts with, since GitHub Pages sends no headers of
				// ours. Everything the site does must be listed here: something left out fails
				// without a word, and tests/e2e/test.ts is what notices.
				csp: {
					mode: 'hash',
					directives: {
						'default-src': ['self'],
						'script-src': ['self', 'https://static.cloudflareinsights.com/beacon.min.js'],
						'style-src': ['self'],
						// No style="…" in the pages, with one exception that is the framework's own: the
						// hidden line that tells a screen reader which page was opened. This is the hash
						// of its style; without it that line would show on screen. If a SvelteKit update
						// changes the style, the browser tests fail and name the new hash.
						'style-src-attr': ['unsafe-hashes', 'sha256-S8qMpvofolR8Mpjy4kQvEm7m1q8clzU4dfDH0AmvZjo='],
						'font-src': ['self'],
						// Screenshots are loaded from wherever the poster keeps them.
						'img-src': ['self', 'https:', 'data:'],
						// The database and login service, README lookups, and Cloudflare analytics.
						'connect-src': [
							'self',
							database,
							'https://api.github.com',
							'https://turtle-wow.fandom.com',
							'https://cloudflareinsights.com/cdn-cgi/rum'
						],
						'object-src': ['none'],
						'base-uri': ['self'],
						'form-action': ['self']
					}
				}
			})
		]
	};
});
