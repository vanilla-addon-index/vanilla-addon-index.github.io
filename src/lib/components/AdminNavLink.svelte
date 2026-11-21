<script lang="ts">
	import { onDestroy } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { countEditReviews, editReviews } from '#lib/edit-reviews.svelte.ts';
	import { countImports, imports } from '#lib/imports.svelte.ts';
	import { countReports, reports } from '#lib/reports.svelte.ts';

	const pending = $derived(imports.counts.pending + reports.open + editReviews.pending);

	// Refresh on navigation as well as login. The import page loads its own count.
	$effect(() => {
		const path = page.url.pathname;
		void countReports();
		void countEditReviews();
		if (!path.startsWith(resolve('/admin/import'))) void countImports().catch(() => {});
	});

	onDestroy(() => {
		imports.counts.pending = 0;
		reports.open = 0;
		editReviews.pending = 0;
	});
</script>

<a href={resolve(reports.open ? '/admin/reports' : editReviews.pending ? '/admin/edits' : '/admin/import')} class="btn">
	Admin
	{#if pending}
		<span class="text-accent" aria-label="{pending} items waiting">{pending}</span>
	{/if}
</a>
