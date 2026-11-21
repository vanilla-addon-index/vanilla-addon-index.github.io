<script lang="ts">
	import { onDestroy } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { adminBadgeCounts, clearAdminBadges, refreshAdminBadges } from '#lib/admin-badges.svelte.ts';

	const counts = $derived(adminBadgeCounts());
	const pending = $derived(counts.imports + counts.reports + counts.edits);

	$effect(() => {
		void page.url.pathname;
		refreshAdminBadges();
	});

	onDestroy(clearAdminBadges);
</script>

<a href={resolve(counts.reports ? '/admin/reports' : counts.edits ? '/admin/edits' : '/admin/import')} class="btn">
	Admin
	{#if pending}
		<span class="text-accent" aria-label="{pending} items waiting">{pending}</span>
	{/if}
</a>
