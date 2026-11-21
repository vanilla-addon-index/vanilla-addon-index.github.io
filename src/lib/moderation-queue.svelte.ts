import { supabase } from './supabase';

const PAGE_SIZE = 50;
type Queue = 'reports' | 'edits' | 'links';

export function createModerationQueue<Row extends { id: number }>(
	queue: Queue, searchText: (row: Row) => string, onPage?: (rows: Row[]) => void
) {
	let entries = $state.raw<Row[]>([]);
	let loaded = $state(false);
	let loading = $state(true);
	let hasMore = $state(false);
	let complete = $state(false);
	let error = $state('');
	let reportCounts = $state.raw<Record<string, number>>();
	let query = $state<string>();
	const term = $derived(query?.toLowerCase() ?? '');
	const rows = $derived(complete && term ? entries.filter(row => searchText(row).toLowerCase().includes(term)) : entries);
	let cursor = 0;
	let active: { controller: AbortController; resolved: Set<number> } | undefined;
	let searchId = 0;

	async function read(more: boolean) {
		const request = { controller: new AbortController(), resolved: new Set<number>() };
		active = request;
		loading = true;
		error = '';
		try {
			if (!supabase) throw new Error('Database is not configured.');
			const { data, error: failure } = await supabase.rpc('moderation_queue_page', {
				queue, search: query ?? '', after_id: more ? cursor : 0,
				include_report_counts: queue === 'reports' && reportCounts === undefined
			}).abortSignal(request.controller.signal);
			if (active !== request) return;
			if (failure) throw new Error(failure.message);
			const result = data as { rows: Row[]; report_counts: Record<string, number> | null };
			const visible = result.rows.slice(0, PAGE_SIZE);
			hasMore = result.rows.length > PAGE_SIZE;
			if (!more && !query) complete = !hasMore;
			cursor = visible.at(-1)?.id ?? cursor;
			const page = visible.filter(row => !request.resolved.has(row.id));
			if (result.report_counts) reportCounts = result.report_counts;
			entries = more ? [...entries, ...page] : page;
			onPage?.(page);
			loaded = true;
		} catch (e) {
			if (active === request) error = (e as Error).message;
		} finally {
			if (active === request) {
				active = undefined;
				loading = false;
			}
		}
	}

	function search(term: string) {
		const delay = query === undefined ? 0 : 250;
		query = term;
		// Most queues fit on the first page. Keep their search in the browser.
		if (complete) return;
		searchId++;
		cursor = 0;
		entries = [];
		loaded = false;
		loading = true;
		hasMore = false;
		error = '';
		const timer = setTimeout(() => void read(false), delay);
		return () => {
			clearTimeout(timer);
			active?.controller.abort();
			active = undefined;
		};
	}

	function remove(id: number, optimistic = false) {
		if (!optimistic) active?.resolved.add(id);
		const currentSearch = searchId;
		const row = entries.find(item => item.id === id);
		if (row) entries = entries.filter(item => item.id !== id);
		return () => {
			if (row && currentSearch === searchId && !entries.some(item => item.id === id)) {
				entries = [...entries, row].sort((a, b) => a.id - b.id);
			}
		};
	}

	return {
		get rows() { return rows; },
		get loaded() { return loaded; },
		get loading() { return loading; },
		get hasMore() { return hasMore; },
		get error() { return error; },
		get reportCounts() { return reportCounts; },
		search, remove,
		loadMore() {
			if (!loading && (!loaded || hasMore)) void read(loaded);
		},
		reportClosed(reason: string) {
			if (reportCounts) reportCounts = { ...reportCounts, [reason]: Math.max(0, (reportCounts[reason] ?? 0) - 1) };
		}
	};
}
