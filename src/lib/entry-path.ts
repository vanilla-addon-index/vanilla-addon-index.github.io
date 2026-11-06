import type { Addon } from './types';

/** Canonical public address, shared by navigation, metadata and the sitemap. */
export const entryPath = (entry: Pick<Addon, 'slug' | 'entry_type'>): `/dll/${string}` | `/addon/${string}` =>
 entry.entry_type === 'dll' ? `/dll/${entry.slug}` : `/addon/${entry.slug}`;
