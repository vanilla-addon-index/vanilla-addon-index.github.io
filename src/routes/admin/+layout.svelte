<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { auth } from '#lib/auth.svelte.ts';
	import AdminNavigation from '#lib/components/AdminNavigation.svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	const importing = $derived(page.url.pathname.startsWith(resolve('/admin/import')));
</script>

{#if !auth.ready}
	<p class="py-12 text-center text-muted">Loading…</p>
{:else if !auth.isAdmin}
	<div class="panel mx-auto mt-8 max-w-sm p-5 text-center">
		<p class="text-muted">This part of the site is for admins.</p>
	</div>
{:else if importing}
	{@render children()}
{:else}
	<div class="admin-workspace">
		<aside class="admin-sidebar"><AdminNavigation /></aside>
		<!-- Keyboard users can focus the content to scroll it without moving navigation. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div class="min-w-0 md:h-full md:min-h-0 md:overflow-y-auto md:overscroll-contain" role="region" aria-label="Admin content" tabindex="0">
			{@render children()}
		</div>
	</div>
{/if}
