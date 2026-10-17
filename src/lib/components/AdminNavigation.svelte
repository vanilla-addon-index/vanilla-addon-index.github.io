<script lang="ts">
	import {resolve} from '$app/paths';
	import {page} from '$app/state';
	import {editReviews} from '#lib/edit-reviews.svelte.ts';
	import {reports} from '#lib/reports.svelte.ts';
	const tabs = [
		{path:'/admin/import',label:'Import'},
		{path:'/admin/reports',label:'Reports'},
		{path:'/admin/edits',label:'Edit reviews'},
		{path:'/admin/groups',label:'Shared addons'},
		{path:'/admin/log',label:'Log'},
		{path:'/admin/trash',label:'Trash'},
		{path:'/admin/users',label:'Users'}
	] as const;
</script>

<nav class="panel py-1" aria-label="Admin">
	<h2 class="label px-3 pt-2">Admin</h2>
	{#each tabs as tab (tab.path)}
		{@const active=page.url.pathname.startsWith(resolve(tab.path))}
		<a href={resolve(tab.path)} aria-current={active?'page':undefined}
			class={['flex items-center justify-between gap-2 border-l-2 px-3 py-1 hover:bg-raised',active?'border-accent text-accent':'border-transparent']}>
			<span>{tab.label}</span>
			{#if tab.path==='/admin/edits' && editReviews.pending}<span class="text-sm text-accent">{editReviews.pending}</span>{/if}
			{#if tab.path==='/admin/reports' && reports.open}<span class="text-sm text-accent">{reports.open}</span>{/if}
		</a>
	{/each}
</nav>
