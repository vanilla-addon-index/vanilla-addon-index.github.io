<script lang="ts">
	import {resolve} from '$app/paths';
	import {page} from '$app/state';
	import {editReviews} from '#lib/edit-reviews.svelte.ts';
	import {reports} from '#lib/reports.svelte.ts';
	import {imports} from '#lib/imports.svelte.ts';
	const tabs = [
		{path:'/admin/import',label:'Import'},
		{path:'/admin/reports',label:'Reports'},
		{path:'/admin/edits',label:'Edit reviews'},
		{path:'/admin/groups',label:'Grouped addons'},
		{path:'/admin/log',label:'Log'},
		{path:'/admin/trash',label:'Trash'},
		{path:'/admin/users',label:'Users'}
	] as const;
</script>

<nav class="section-navigation panel mt-2 grid grid-cols-2 px-1 sm:flex" aria-label="Admin">
	{#each tabs as tab (tab.path)}
		{@const active=page.url.pathname.startsWith(resolve(tab.path))}
		<a href={resolve(tab.path)} aria-current={active?'page':undefined}
			class={['flex min-w-0 items-center justify-center gap-1 px-2 py-0.5 text-center text-sm font-bold transition-colors duration-100 hover:bg-raised hover:text-accent sm:flex-1',active?'text-accent':'text-muted']}>
			<span>{tab.label}</span>
			{#if tab.path==='/admin/import' && imports.counts.pending}<span class="text-sm text-accent">{imports.counts.pending}</span>{/if}
			{#if tab.path==='/admin/edits' && editReviews.pending}<span class="text-sm text-accent">{editReviews.pending}</span>{/if}
			{#if tab.path==='/admin/reports' && reports.open}<span class="text-sm text-accent">{reports.open}</span>{/if}
		</a>
	{/each}
</nav>
