import { readFileSync } from 'node:fs';
import type { EntryGenerator } from './$types';

// Build time only: gives every addon in the daily snapshot a real page (HTTP 200)
// so links unfurl and get indexed. Newer addons are served by the 404.html fallback.
export const prerender = 'auto';

export const entries: EntryGenerator = () => {
	const addons: { slug: string }[] = JSON.parse(readFileSync('static/addons.json', 'utf8'));
	return addons.map(({ slug }) => ({ slug }));
};
