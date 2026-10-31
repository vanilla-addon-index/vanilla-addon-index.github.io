<script lang="ts">
	import '../app.css';
	import logo from '#lib/assets/logo.png';
	import { goto, onNavigate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { loadAddons, readCache, store } from '#lib/addons.svelte.ts';
	import { auth, initAuth } from '#lib/auth.svelte.ts';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import WikiSubmissionDialog from '#lib/components/WikiSubmissionDialog.svelte';
	import { SITE_NAME } from '#lib/config.ts';
	import { countEditReviews, editReviews } from '#lib/edit-reviews.svelte.ts';
	import { countReports, reports } from '#lib/reports.svelte.ts';
	import { countImports, imports } from '#lib/imports.svelte.ts';
	import { loginHref, takeReturn } from '#lib/return.ts';
	import { configured } from '#lib/supabase.ts';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
	const pendingAdminItems = $derived(imports.counts.pending + reports.open + editReviews.pending);

	// Shown inside a frame on someone else's page, the site could be laid under that page's
	// own buttons, and a logged-in admin tricked into clicking through to something here.
	// A browser can be told to refuse framing, but only by a header, and GitHub Pages sends
	// none of ours. So the site refuses itself: in a frame it starts nothing and shows one
	// link, which opens it properly.
	const framed = window.top !== window.self;

	if (!framed) {
		initAuth();
		readCache();
	}

	// The list comes from the daily snapshot for visitors and from the database for anyone
	// logged in, so it is loaded once that is known, and again on logging in or out.
	// An admin gets it exactly as it is, so it is loaded again once an account turns out
	// to be one.
	const userId = $derived(auth.session?.user.id);
	$effect(() => {
		void userId;
		void auth.isAdmin;
		if (auth.known) loadAddons();
	});

	// GitHub and Discord send everyone back to the front page after a login. Whoever
	// arrives there newly logged in is taken on to the page they logged in from. The login
	// page does the same itself, for a login that never leaves the site.
	$effect(() => {
		if (!userId || page.url.pathname === resolve('/login')) return;
		const next = takeReturn();
		if (next) goto(next, { replaceState: true });
	});

	// Refresh the badge on navigation as well as login: new work can arrive while open.
	$effect(() => {
		void page.url.pathname;
		if (auth.isAdmin) {
			countReports();
			countEditReviews();
			// The Import page refreshes its own queue, including this count.
			if (!page.url.pathname.startsWith(resolve('/admin/import'))) void countImports().catch(() => {});
		} else {
			imports.counts.pending = 0;
			reports.open = 0;
			editReviews.pending = 0;
		}
	});

	// The header stays at the top of the window and the footer at the bottom; what sticks
	// between them needs their heights.
	let headerHeight = $state(0);
	let footerHeight = $state(0);
	$effect(() => {
		document.documentElement.style.setProperty('--header-h', `${headerHeight}px`);
		document.documentElement.style.setProperty('--footer-h', `${footerHeight}px`);
	});

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

{#if framed}
	<p class="p-6 text-center">
		<a href={page.url.href} target="_top" class="text-accent underline">Open {SITE_NAME}</a>
	</p>
{:else}
<div class="flex min-h-screen flex-col">
	<!-- Painted like the page under its tint, so nothing scrolling behind it shows through. -->
	<header bind:offsetHeight={headerHeight} class="backdrop sm:sticky sm:top-0 sm:z-20">
		<div class="border-b border-border bg-surface">
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
						<a href={resolve(reports.open ? '/admin/reports' : editReviews.pending ? '/admin/edits' : '/admin/import')} class="btn">
							Admin
							{#if pendingAdminItems}
								<span class="text-accent" aria-label="{pendingAdminItems} items waiting">{pendingAdminItems}</span>
							{/if}
						</a>
					{/if}
					{#if auth.username}
						<a href={resolve('/account')} class="btn">{auth.username}</a>
					{:else if !auth.ready}
						<!-- Holds the space until the login state is known, so nothing flashes or shifts. -->
						<span class="btn invisible" aria-hidden="true">Log in</span>
					{:else if auth.session}
						<a href={resolve('/account')} class="btn">Account</a>
					{:else}
						<a href={loginHref(page.url)} class="btn">Log in</a>
					{/if}
				</nav>
			</div>
		</div>
	</header>

	<main class="mx-auto w-full max-w-6xl flex-1 px-4 pt-5 pb-16 sm:pb-0">
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

	<!-- It brings the gap above it along, as the header's side does: the page ends, and a
	     long one vanishes, a little above the footer's line and never against it. -->
	<footer bind:offsetHeight={footerHeight} class="backdrop sm:sticky sm:bottom-0 sm:z-20 sm:pt-5">
		<div class="border-t border-border">
			<div class="mx-auto flex max-w-6xl flex-wrap gap-x-4 gap-y-1 px-4 py-3 text-sm text-muted">
				<span>
					Sources:
					<a href="https://turtle-wow.fandom.com/wiki/Addons" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 whitespace-nowrap text-[#a3d631] hover:underline"><span aria-hidden="true">🐢</span> Turtle WoW Wiki</a>
					<a href="https://octowow.st/git/explore/repos" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 whitespace-nowrap text-[#c99aeb] hover:underline"><span aria-hidden="true">🐙</span> OctoWoW Repos</a>
					· Refreshed daily
				</span>
				<a href={resolve('/about')} class="ml-auto hover:text-accent">About and privacy</a>
			</div>
		</div>
	</footer>
</div>

<ConfirmDialog />
<WikiSubmissionDialog />
{/if}
