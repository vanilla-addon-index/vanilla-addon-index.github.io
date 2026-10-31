<script lang="ts">
	import ResponsiveSidebar from '#lib/components/ResponsiveSidebar.svelte';
	import {setContext, type Snippet} from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { auth } from '#lib/auth.svelte.ts';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
	let sidebar = $state<Snippet>();
	let toolbar = $state<Snippet>();
	setContext('admin-toolbar', { register(content: Snippet) {
		toolbar = content;
		return () => { if (toolbar === content) toolbar = undefined; };
	} });
	setContext('admin-sidebar', {register(content: Snippet) {
		sidebar = content;
		return () => {if (sidebar === content) sidebar = undefined;};
	}});

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
		<aside class="admin-sidebar"><ResponsiveSidebar label="Page details and filters">{@render sidebar?.()}</ResponsiveSidebar></aside>
		<div class="min-w-0 md:flex md:h-full md:min-h-0 md:flex-col">
			<div class="shrink-0 pb-2">{@render toolbar?.()}</div>
			<!-- Keyboard users can focus the entries while the toolbar stays outside the scroll area. -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<div class="min-w-0 md:min-h-0 md:flex-1 md:overflow-y-auto md:overscroll-contain" role="region" aria-label="Admin content" tabindex="0">
				{@render children()}
			</div>
		</div>
	</div>
{/if}
