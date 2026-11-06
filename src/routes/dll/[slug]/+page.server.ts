import { readSnapshot } from '#lib/snapshot.server.ts';
import type { EntryGenerator } from './$types';

export const prerender = 'auto';
export const entries: EntryGenerator = () => {
 const addresses = readSnapshot().filter(entry => entry.entry_type === 'dll')
  .flatMap(({slug, aliases}) => [slug, ...(aliases ?? [])]);
 return [...new Set(addresses)].map(slug => ({slug}));
};
