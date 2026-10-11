import { readSnapshot } from '#lib/snapshot.server.ts';
import type { EntryGenerator } from './$types';

// Build time only: gives every addon in the daily snapshot a real page (HTTP 200)
// so links unfurl and get indexed. Newer addons are served by the 404.html fallback.
export const prerender = 'auto';

export const entries: EntryGenerator = () => {
	return readSnapshot().map(({ slug }) => ({ slug }));
};
