<script lang="ts">
	import { untrack } from 'svelte';
	import { entryHref } from '#lib/entry-href.ts';
	import AdminToolbar from '#lib/components/AdminToolbar.svelte';
	import AdminSidebarContent from '#lib/components/AdminSidebarContent.svelte';
	import AdminNavigation from '#lib/components/AdminNavigation.svelte';
	import { store } from '#lib/addons.svelte.ts';
	import UserLink from '#lib/components/UserLink.svelte';
	import { SITE_NAME } from '#lib/config.ts';
	import { createModerationQueue } from '#lib/moderation-queue.svelte.ts';
	import { REASONS, decideReport, type Report } from '#lib/reports.svelte.ts';

	const addonOf = (report: Report) => store.addons.find((a) => a.id === report.addon_id);
	const queue = createModerationQueue<Report>('reports', report =>
		[addonOf(report)?.name, report.reported_by_name, REASONS[report.reason], report.note].join(' '));
	let error = $state('');
	let query = $state('');
	const waiting = $derived(queue.reportCounts && Object.values(queue.reportCounts).reduce((sum, count) => sum + count, 0));
	$effect(() => {
		const term = query.trim();
		return untrack(() => queue.search(term));
	});

	const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });

	// A closed report leaves the list at once, and comes back if the database refuses.
	async function close(report: Report, outcome: 'handled' | 'dismissed') {
		error = '';
		const undo = queue.remove(report.id, true);
		try {
			await decideReport(report.id, outcome);
			queue.remove(report.id);
			queue.reportClosed(report.reason);
		} catch (e) {
			undo();
			error = (e as Error).message;
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
	<div class="panel p-3"><h1 class="text-2xl font-bold">Reports</h1><p class="text-muted">Review reports from members.</p></div>
	<dl class="panel space-y-2 p-3 text-sm">
		<div class="flex justify-between gap-2"><dt>Waiting</dt><dd>{waiting ?? '…'}</dd></div>
		{#each Object.entries(REASONS) as [reason,label]}
			<div class="flex justify-between gap-2"><dt class="text-muted">{label}</dt><dd>{queue.reportCounts ? queue.reportCounts[reason] ?? 0 : '…'}</dd></div>
		{/each}
	</dl>
	<p class="panel p-3 text-sm text-muted">Open the addon to investigate. Mark a report handled after resolving it, or dismiss it if no action is needed.</p>
</AdminSidebarContent>
{#if error || queue.error}<p class="mb-2 break-words text-danger" aria-live="polite">{error || queue.error}</p>{/if}

<div class="panel">
	{#if !queue.loaded && queue.loading}
		<p class="px-3 py-8 text-center text-muted">Loading the reports…</p>
	{:else if queue.loaded && !queue.rows.length && !queue.hasMore && !query.trim()}
		<p class="px-3 py-8 text-center text-muted">
			No reports are waiting. Anyone logged in can send one from an addon's page.
		</p>
	{:else if queue.loaded && !queue.rows.length && !queue.hasMore}
		<p class="px-3 py-8 text-center text-muted">No reports match your search.</p>
	{:else}
		{#each queue.rows as report (report.id)}
			{@const addon = addonOf(report)}
			<div class="border-b border-border px-3 py-2 last:border-b-0">
				<div class="flex flex-wrap items-baseline gap-x-3">
					{#if addon}
						<a href={entryHref(addon)} class="font-bold hover:text-accent hover:underline">
							{addon.name}
						</a>
						<span class="text-sm text-muted">{addon.category}</span>
					{:else}
						<span class="font-bold">Addon {report.addon_id}</span>
					{/if}
					<span class="ml-auto text-sm text-muted">
						<UserLink name={report.reported_by_name} fallback="an unknown account" /> · {date(report.created_at)}
					</span>
				</div>
				<p class={report.reason === 'harmful' ? 'text-danger' : 'text-accent'}>{REASONS[report.reason]}</p>
				{#if report.note}<p class="break-words whitespace-pre-line">{report.note}</p>{/if}
				{#if addon?.repo_url}
					<a
						href={addon.repo_url}
						target="_blank"
						rel="noopener nofollow"
						class="block break-all text-accent/80 hover:text-accent hover:underline"
					>
						{addon.repo_url}
					</a>
				{/if}
				<div class="mt-1.5 flex flex-wrap gap-2">
					{#if addon}
						<a href={entryHref(addon)} class="btn py-1">Open the addon</a>
					{/if}
					<button class="btn btn-primary py-1" onclick={() => close(report, 'handled')}>Handled</button>
					<button class="btn py-1" onclick={() => close(report, 'dismissed')}>Dismiss</button>
				</div>
			</div>
		{/each}
	{/if}
</div>
{#if queue.hasMore || (!queue.loaded && queue.error)}
	<button class="btn mt-2 w-full" disabled={queue.loading} onclick={queue.loadMore}>
		{queue.loaded ? 'Show more reports' : 'Retry loading reports'}
	</button>
{/if}
<p class="mt-2 text-sm text-muted">
	Fix or delete the addon from its own page, then mark the report as handled. Dismiss a report when nothing is wrong.
	Deleting an addon removes its reports.
</p>
