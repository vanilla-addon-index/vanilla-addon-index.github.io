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

/** Suggest whole-name extensions, including short names such as Aux, without
 * treating letters inside an unrelated word (Auxiliary) as a name match. */
export function similarAddon(name: string, addons: Addon[]): Addon | undefined {
 const words = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z0-9]+/g) ?? [];
 const wanted = words(name);
 const candidates = addons.flatMap(addon => {
  const other = words(addon.name);
  const [short, long] = wanted.length <= other.length ? [wanted, other] : [other, wanted];
  const length = short.join('').length;
  if (length < 3 || wanted.join('') === other.join('')) return [];
  const contains = long.some((_, start) => short.every((word, i) => long[start + i] === word));
  return contains ? [{addon, length}] : [];
 }).sort((a,b) => b.length - a.length);
 return candidates.length && candidates[0].length !== candidates[1]?.length ? candidates[0].addon : undefined;
}
