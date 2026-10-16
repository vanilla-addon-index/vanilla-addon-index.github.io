import { linkKey } from './links.ts';
import type { Addon } from './types.ts';

export interface ReviewNote {
	label: string;
	value: string;
	tone?: 'warning' | 'danger';
}

/** A fork is a grouping suggestion only when its parent identifies one live page. */
export function publishedForkParent(parent: string | null | undefined, addons: Addon[]): Addon | undefined {
 if (!parent) return undefined;
 const key = linkKey(parent);
 const matches = addons.filter(a => a.versions.some(v => linkKey(v.url) === key));
 return matches.length === 1 ? matches[0] : undefined;
}
