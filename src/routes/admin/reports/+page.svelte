<script lang="ts">
	import { resolve } from '$app/paths';
	import { store } from '#lib/addons.svelte.ts';
	import UserLink from '#lib/components/UserLink.svelte';
	import { SITE_NAME } from '#lib/config.ts';
	import { REASONS, decideReport, loadReports, type Report } from '#lib/reports.svelte.ts';

	let entries = $state<Report[]>([]);
	let loaded = $state(false);
	let error = $state('');

	loadReports()
		.then((rows) => {
			entries = rows;
			loaded = true;
		})
		.catch((e) => (error = e.message));

	const addonOf = (report: Report) => store.addons.find((a) => a.id === report.addon_id);
	const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });

	// A closed report leaves the list at once, and comes back if the database refuses.
	async function close(report: Report, outcome: 'handled' | 'dismissed') {
		error = '';
		const before = entries;
		entries = entries.filter((e) => e.id !== report.id);
		try {
			await decideReport(report.id, outcome);
		} catch (e) {
			entries = before;
			error = (e as Error).message;
		}
	}
</script>

<svelte:head>
	<title>Reports · {SITE_NAME}</title>
</svelte:head>

{#if error}<p class="mb-2 break-words text-danger" aria-live="polite">{error}</p>{/if}

<div class="panel">
	{#if !loaded}
		<p class="px-3 py-8 text-center text-muted">Loading the reports…</p>
	{:else if !entries.length}
		<p class="px-3 py-8 text-center text-muted">
			No reports are waiting. Anyone logged in can send one from an addon's page.
		</p>
	{:else}
		{#each entries as report (report.id)}
			{@const addon = addonOf(report)}
			<div class="border-b border-border px-3 py-2 last:border-b-0">
				<div class="flex flex-wrap items-baseline gap-x-3">
					{#if addon}
						<a href={resolve('/addon/[slug]', { slug: addon.slug })} class="font-bold hover:text-accent hover:underline">
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
				{#if addon}
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
						<a href={resolve('/addon/[slug]', { slug: addon.slug })} class="btn py-1">Open the addon</a>
					{/if}
					<button class="btn btn-primary py-1" onclick={() => close(report, 'handled')}>Handled</button>
					<button class="btn py-1" onclick={() => close(report, 'dismissed')}>Dismiss</button>
				</div>
			</div>
		{/each}
	{/if}
</div>
<p class="mt-2 text-sm text-muted">
	Fix or delete the addon from its own page, then mark the report as handled. Dismiss a report when nothing is wrong.
	Deleting an addon removes its reports.
</p>
