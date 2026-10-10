<script lang="ts">
	import '../app.css';
	import favicon from '#lib/assets/favicon.svg';
	import logo from '#lib/assets/logo.png';
	import { onNavigate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { loadAddons, store } from '#lib/addons.svelte.ts';
	import { auth, initAuth } from '#lib/auth.svelte.ts';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import { REPO_URL, SITE_NAME } from '#lib/config.ts';
	import { configured } from '#lib/supabase.ts';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	initAuth();
	loadAddons();

	onNavigate((navigation) => {
		if (!document.startViewTransition) return;
		// Same page, different search or filter: the list updates in place, with no fade.
		if (navigation.from?.url.pathname === navigation.to?.url.pathname) return;
		return new Promise((done) => {
			const transition = document.startViewTransition(async () => {
				done();
				await navigation.complete;
			});
			// The browser skips the animation when the tab is hidden; that is not an error.
			transition.ready.catch(() => {});
			transition.finished.catch(() => {});
			transition.updateCallbackDone.catch(() => {});
		});
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<div class="flex min-h-screen flex-col">
	<header class="border-b border-border bg-surface">
		<div class="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
			<a href={resolve('/')} class="shrink-0">
				<img src={logo} alt={SITE_NAME} width="471" height="53" class="h-7 w-auto" />
			</a>
			<nav class="ml-auto flex items-center gap-2">
				{#if auth.banned}
					<!-- Shown but switched off; the notice below says why. -->
					<span class="btn btn-primary pointer-events-none opacity-40" aria-disabled="true">Submit addon</span>
				{:else}
					<a href={resolve('/submit')} class="btn btn-primary">Submit addon</a>
				{/if}
				{#if auth.isAdmin}
					<a href={resolve('/admin/import')} class="btn">Admin</a>
				{/if}
				{#if auth.username}
					<a href={resolve('/account')} class="btn">{auth.username}</a>
				{:else if !auth.ready}
					<!-- Holds the space until the login state is known, so nothing flashes or shifts. -->
					<span class="btn invisible" aria-hidden="true">Log in</span>
				{:else if auth.session}
					<a href={resolve('/account')} class="btn">Account</a>
				{:else}
					<a href={resolve('/login')} class="btn">Log in</a>
				{/if}
			</nav>
		</div>
	</header>

	<main class="mx-auto w-full max-w-6xl flex-1 px-4 pt-5 pb-16">
		{#if !configured}
			<p class="panel mb-4 px-3 py-2 text-muted">
				Preview mode: the database is not connected yet, so posting and login are disabled.
			</p>
		{:else if auth.banned}
			<p class="panel mb-4 border-danger/40 px-3 py-2 text-danger">
				Your account is suspended. You can browse, but not post or edit.
			</p>
		{:else if store.stale}
			<p class="panel mb-4 px-3 py-2 text-muted">
				The database is unreachable. Showing the last daily snapshot; posting is unavailable.
			</p>
		{/if}
		{@render children()}
	</main>

	<footer class="border-t border-border">
		<div class="mx-auto flex max-w-6xl flex-wrap gap-x-4 gap-y-1 px-4 py-3 text-sm text-muted">
			<span>Interface\AddOns, indexed. Free and open source.</span>
			<a href={REPO_URL} class="ml-auto hover:text-accent">Source on GitHub</a>
		</div>
	</footer>
</div>

<ConfirmDialog />
