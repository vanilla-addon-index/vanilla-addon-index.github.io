<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { entryHref } from '#lib/entry-href.ts';
	import AdminToolbar from '#lib/components/AdminToolbar.svelte';
	import AdminSidebarContent from '#lib/components/AdminSidebarContent.svelte';
	import AdminNavigation from '#lib/components/AdminNavigation.svelte';
	import ReviewQueueRow from '#lib/components/ReviewQueueRow.svelte';
	import { store } from '#lib/addons.svelte.ts';
	import UserLink from '#lib/components/UserLink.svelte';
	import { SITE_NAME } from '#lib/config.ts';
	import { createModerationQueue } from '#lib/moderation-queue.svelte.ts';
	import { REASONS, decideReport, type Reason, type Report } from '#lib/reports.svelte.ts';

	const labels = {
		broken: 'Broken link',
		'wrong-client': 'Wrong client',
		duplicate: 'Duplicate listing',
		harmful: 'Harmful download',
		other: 'Other issue'
	} satisfies Record<Reason, string>;

	const addonOf = (report: Report) => store.addons.find(addon => addon.id === report.addon_id);
	const queue = createModerationQueue<Report>('reports', report =>
		[addonOf(report)?.name, report.reported_by_name, labels[report.reason], REASONS[report.reason], report.note].join(' '));

	let query = $state('');
	let selectedId = $state<number>();
	let saving = $state(false);
	let error = $state('');
	let list = $state<HTMLDivElement>();
	const selected = $derived(queue.rows.find(report => report.id === selectedId) ?? queue.rows[0]);
	const waiting = $derived(queue.reportCounts && Object.values(queue.reportCounts).reduce((sum, count) => sum + count, 0));

	$effect(() => {
		const term = query.trim();
		return untrack(() => queue.search(term));
	});

	const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });

	// Advance to the next report. If the decision fails, restore the row and its selection.
	async function close(report: Report, outcome: 'handled' | 'dismissed') {
		if (saving) return;
		error = '';
		saving = true;
		const index = queue.rows.findIndex(row => row.id === report.id);
		const next = queue.rows[index + 1]?.id ?? queue.rows[index - 1]?.id;
		selectedId = next;
		const undo = queue.remove(report.id, true);
		try {
			await decideReport(report.id, outcome);
			queue.remove(report.id);
			queue.reportClosed(report.reason);
		} catch (e) {
			undo();
			if (selectedId === next) selectedId = report.id;
			error = (e as Error).message;
		} finally {
			saving = false;
		}
		await tick();
		if (document.activeElement === document.body && selected) {
			list?.querySelector<HTMLElement>('#report-' + selected.id + ' [data-act="review"]')?.focus();
		}
	}
</script>

<svelte:head>
	<title>Reports · {SITE_NAME}</title>
</svelte:head>

<AdminToolbar>
	<input class="input w-full" type="search" aria-label="Search reports" placeholder="Search reports" bind:value={query} />
	<AdminNavigation />
</AdminToolbar>

<AdminSidebarContent>
	<div class="panel">
		<header class="border-b border-border px-3 py-2">
			<h1 class="text-2xl leading-tight font-bold">Reports</h1>
			<p class="text-sm text-muted">Review reports from members.</p>
		</header>
		<dl class="space-y-1 px-3 py-2 text-sm">
			<div class="mb-1.5 flex justify-between gap-2 border-b border-border pb-1.5 font-semibold">
				<dt>Waiting</dt><dd class="tabular-nums">{waiting ?? '…'}</dd>
			</div>
			{#each Object.entries(labels) as [reason, label] (reason)}
				<div class="flex justify-between gap-2">
					<dt class="text-muted">{label}</dt><dd class="tabular-nums">{queue.reportCounts ? queue.reportCounts[reason] ?? 0 : '…'}</dd>
				</div>
			{/each}
		</dl>
	</div>
	<details class="panel px-3 py-2 text-sm">
		<summary class="cursor-pointer font-semibold hover:text-accent">Handling reports</summary>
		<p class="mt-2 text-muted">Open the addon to investigate. Mark the report handled after resolving it, or dismiss it if no action is needed. Deleting the addon removes its reports.</p>
	</details>
</AdminSidebarContent>

{#if error || queue.error}<p class="mb-2 break-words text-danger" role="alert">{error || queue.error}</p>{/if}

<div class="panel" bind:this={list}>
	{#if !queue.loaded && queue.loading}
		<p class="px-4 py-5 text-center text-muted" role="status">Loading the reports…</p>
	{:else if queue.loaded && !queue.rows.length && !queue.hasMore}
		<div class="px-4 py-5 text-center">
			{#if query.trim()}
				<h2 class="font-semibold">No reports match your search.</h2>
			{:else}
				<h2 class="font-semibold">No reports are waiting.</h2>
				<p class="mt-1 text-sm text-muted">Members can send reports from an addon's page.</p>
			{/if}
		</div>
	{:else}
		{#each queue.rows as report (report.id)}
			{@const addon = addonOf(report)}
			<ReviewQueueRow
				rowId={'report-' + report.id}
				title={addon?.name ?? 'Addon ' + report.addon_id}
				subtitle={(report.reported_by_name ?? 'Unknown account') + ' · ' + date(report.created_at)}
				selected={selected?.id === report.id}
				onselect={() => (selectedId = report.id)}
			>
				{#snippet badges()}
					<span class={['rounded border px-1.5 py-0.5 text-xs', report.reason === 'harmful' ? 'border-danger/35 text-danger' : 'border-border text-muted']}>
						{labels[report.reason]}
					</span>
				{/snippet}

				<p class={['font-semibold', report.reason === 'harmful' && 'text-danger']}>{REASONS[report.reason]}</p>
				{#if report.note}<p class="mt-1 whitespace-pre-line [overflow-wrap:anywhere]">{report.note}</p>{:else}<p class="mt-1 text-sm text-muted">No note provided.</p>{/if}
				<p class="mt-1 text-sm text-muted">
					Reported by <UserLink name={report.reported_by_name} fallback="an unknown account" />
					{#if addon} · {addon.category}{/if}
				</p>

				<div class="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2">
					{#if addon}
						<a href={entryHref(addon)} class="btn py-1">Open the addon</a>
					{/if}
					<button class="btn btn-primary py-1" disabled={saving} onclick={() => close(report, 'handled')}>Handled</button>
					<button class="btn py-1" disabled={saving} onclick={() => close(report, 'dismissed')}>Dismiss</button>
				</div>
				{#if addon?.repo_url}
					<p class="mt-2 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 border-t border-border pt-2 text-sm">
						<span class="font-semibold text-muted">Repository</span>
						<a href={addon.repo_url} target="_blank" rel="noopener nofollow" class="text-accent [overflow-wrap:anywhere] hover:underline">{addon.repo_url}</a>
					</p>
				{/if}
			</ReviewQueueRow>
		{/each}
	{/if}
</div>
{#if queue.hasMore || (!queue.loaded && queue.error)}
	<button class="btn mt-2 w-full" disabled={queue.loading} onclick={queue.loadMore}>
		{queue.loaded ? 'Show more reports' : 'Retry loading reports'}
	</button>
{/if}
