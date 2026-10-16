<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { auth } from '#lib/auth.svelte.ts';
	import { editReviews } from '#lib/edit-reviews.svelte.ts';
	import { reports } from '#lib/reports.svelte.ts';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	const TABS = [
		{ path: '/admin/import', label: 'Import' },
		{ path: '/admin/reports', label: 'Reports' },
		{ path: '/admin/edits', label: 'Edit reviews' },
		{ path: '/admin/groups', label: 'Shared addons' },
		{ path: '/admin/log', label: 'Log' },
		{ path: '/admin/trash', label: 'Trash' },
		{ path: '/admin/users', label: 'Users' }
	] as const;
</script>

{#if !auth.ready}
	<p class="py-12 text-center text-muted">Loading…</p>
{:else if !auth.isAdmin}
	<div class="panel mx-auto mt-8 max-w-sm p-5 text-center">
		<p class="text-muted">This part of the site is for admins.</p>
	</div>
{:else}
	<nav class="mb-4 flex flex-wrap items-center gap-2" aria-label="Admin">
		{#each TABS as tab (tab.path)}
			{@const active = page.url.pathname.startsWith(resolve(tab.path))}
			<a
				href={resolve(tab.path)}
				class={['btn', active && 'border-accent/60 text-accent']}
				aria-current={active ? 'page' : undefined}
			>
				{tab.label}
				<!-- How many reports wait, so they are noticed from any tab. -->
				{#if tab.path === '/admin/edits' && editReviews.pending}<span class="text-accent">{editReviews.pending}</span>{/if}
				{#if tab.path === '/admin/reports' && reports.open}<span class="text-accent">{reports.open}</span>{/if}
			</a>
		{/each}
	</nav>
	{@render children()}
{/if}
