import type { Addon } from './types';
import { updateTimestamp } from './addon-update.ts';

export const SORTS = { name: 'Name', code: 'Last update' } as const;
export type Sort = keyof typeof SORTS;

export function readSort(value: string | null): Sort {
	return value === 'code' || value === 'new' || value === 'updated' ? 'code' : 'name';
}

/** Unknown dates sort last; parse timestamps so timezone offsets compare correctly. */
export function byCodeUpdate(a: Pick<Addon, 'name' | 'code_update'>, b: Pick<Addon, 'name' | 'code_update'>): number {
	return compareCodeUpdateDates(a.code_update?.date, b.code_update?.date) || a.name.localeCompare(b.name);
}

export function compareCodeUpdateDates(a?: string, b?: string): number {
	const first = updateTimestamp(a), second = updateTimestamp(b);
	return first === second ? 0 : first > second ? -1 : 1;
}
