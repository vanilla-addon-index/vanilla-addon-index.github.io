import { readSnapshot } from '#lib/snapshot.server.ts';
import type { EntryGenerator } from './$types';

// Build time only: gives every addon in the daily snapshot a real page (HTTP 200)
// so links unfurl and get indexed. Newer addons are served by the 404.html fallback.
export const prerender = 'auto';

// An addon merged into another keeps its old address as an alias. Those get a page too,
// which tells search engines where the addon lives now (see src/hooks.server.ts);
// without one an old link would read as "not found" to them for good.
export const entries: EntryGenerator = () => {
	const addresses = readSnapshot().flatMap(({ slug, aliases }) => [slug, ...(aliases ?? [])]);
	return [...new Set(addresses)].map((slug) => ({ slug }));
};
