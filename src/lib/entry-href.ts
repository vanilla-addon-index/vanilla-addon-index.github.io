import { resolve } from '$app/paths';
import type { Addon } from './types';

export const entryHref = (entry: Pick<Addon, 'slug' | 'entry_type'>) =>
 resolve(entry.entry_type === 'dll' ? '/dll/[slug]' : '/addon/[slug]', {slug: entry.slug});
