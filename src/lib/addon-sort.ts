import type { Addon } from './types';

export const SORTS = { name: 'Name', code: 'Last update' } as const;
export type Sort = keyof typeof SORTS;

export function readSort(value: string | null): Sort {
	return value === 'code' || value === 'new' || value === 'updated' ? 'code' : 'name';
}

/** Unknown dates sort last; parse timestamps so timezone offsets compare correctly. */
export function byCodeUpdate(a: Pick<Addon, 'name' | 'code_update'>, b: Pick<Addon, 'name' | 'code_update'>): number {
	const stamp = (addon: typeof a) => {
		const date = Date.parse(addon.code_update?.date ?? '');
		return Number.isFinite(date) ? date : -Infinity;
	};
	const first = stamp(a), second = stamp(b);
	return (first === second ? 0 : first > second ? -1 : 1) || a.name.localeCompare(b.name);
}
