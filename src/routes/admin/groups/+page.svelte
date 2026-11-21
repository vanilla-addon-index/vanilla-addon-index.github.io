<script lang="ts">
	import { entryHref } from '#lib/entry-href.ts';
	import AdminToolbar from '#lib/components/AdminToolbar.svelte';
	import AdminSidebarContent from '#lib/components/AdminSidebarContent.svelte';
	import AdminNavigation from '#lib/components/AdminNavigation.svelte';
	import { store, plainName } from '#lib/addons.svelte.ts';
	import { SITE_NAME } from '#lib/config.ts';

	let query = $state('');
	const term = $derived(plainName(query));
	const grouped = $derived(store.addons.filter(addon => addon.shared));
	const countWidth = $derived(String(grouped.reduce((max, addon) => Math.max(max, addon.versions.length), 0)).length);
	const pages = $derived(grouped
		.filter(addon => plainName(addon.name).includes(term))
		.toSorted((a, b) => a.name.localeCompare(b.name)));
</script>
<svelte:head><title>Grouped addons · {SITE_NAME}</title></svelte:head>
<AdminSidebarContent>
	<div class="panel p-3"><h1 class="text-2xl font-bold">Grouped addons</h1><p class="text-muted">Manage pages with grouped addon links.</p></div>
	<dl class="panel p-3"><div class="flex justify-between gap-2"><dt class="text-muted">Matching pages</dt><dd>{pages.length}</dd></div></dl>
	<p class="panel p-3 text-sm text-muted">Matching names add links to one page automatically. Open a page to pin its leading link, remove a bad link through Edit, or separate an unrelated addon.</p>
</AdminSidebarContent>
<AdminToolbar>
	<input class="input w-full" type="search" aria-label="Search grouped addons" placeholder="Search grouped addons…" bind:value={query} />
	<AdminNavigation />
</AdminToolbar>
<div class="panel">
	{#each pages as addon (addon.id)}
		{@const count = addon.versions.length}
		<a class="flex items-center justify-between gap-3 border-b border-border px-3 py-2 last:border-b-0 hover:text-accent" href={entryHref(addon)}>
			<span class="min-w-0 [overflow-wrap:anywhere]">{addon.name}</span>
			<span class="flex shrink-0 items-center gap-x-admin-badge">
				{#if addon.pinned_link}<span class="admin-badge border-border text-muted">Pinned</span>{/if}
				{#if addon.entry_type === 'dll'}
					<span class="admin-badge w-17 border-border text-muted">DLL mod</span>
				{/if}
				<span class="inline-grid whitespace-nowrap text-muted tabular-nums">
					<span class="invisible col-start-1 row-start-1 flex gap-x-1" aria-hidden="true"><span>{'0'.repeat(countWidth)}</span><span>links</span></span>
					<span class="col-start-1 row-start-1 flex justify-between gap-x-1">
						<span>{count}</span>{' '}<span>{count === 1 ? 'link' : 'links'}</span>
					</span>
				</span>
			</span>
		</a>
	{:else}
		<p class="p-4 text-muted">No grouped addons found.</p>
	{/each}
</div>
