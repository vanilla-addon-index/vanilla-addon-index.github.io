<script lang="ts">
	import ResponsiveSidebar from '#lib/components/ResponsiveSidebar.svelte';
	import { onMount } from 'svelte';
	import { preferences, loadPreferences, savePreferences } from '#lib/preferences.svelte.ts';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { ownedBy } from '#lib/addons.svelte.ts';
	import { auth } from '#lib/auth.svelte.ts';
	import AddonCard from '#lib/components/AddonCard.svelte';
	import FavoritesList from '#lib/components/FavoritesList.svelte';
	import { PROVIDER_NAMES, SITE_NAME } from '#lib/config.ts';
	import { loginHref } from '#lib/return.ts';
	import { supabase } from '#lib/supabase.ts';
	import type { Addon } from '#lib/types.ts';
	onMount(loadPreferences);
	let query = $state('');
	let list = $state<HTMLDivElement>();
	const matches = (addon: Addon) => [addon.name, addon.description, addon.category, ...addon.versions.map(version => version.url)].join(' ').toLowerCase().includes(query.trim().toLowerCase());
	function jump(id: string) {
		const target = list?.querySelector<HTMLElement>(`#${id}`);
		if (!list || !target) return;
		if (getComputedStyle(list).overflowY === 'auto') {
			list.scrollTo({ top: target.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop });
		} else target.scrollIntoView({ block: 'start' });
	}

	// An admin who approves imports becomes their keeper, but did not post them: they are
	// listed apart, so "Your addons" stays what the account itself submitted.
	const owned = $derived(ownedBy(auth.session?.user.id));
	const mine = $derived(owned.posted);
	const imported = $derived(owned.imported);
	const postedMatches = $derived(mine.filter(matches));
	const importedMatches = $derived(imported.filter(matches));
	const user = $derived(auth.session?.user);
	const logins = $derived(
		(user?.app_metadata.providers as string[] | undefined)?.map((p) => PROVIDER_NAMES[p] ?? p).join(', ')
	);
	const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });

	async function signOut() {
		await goto(resolve('/'));
		await supabase?.auth.signOut();
	}

	let leaving = $state<HTMLDialogElement>();
	let busy = $state(false);
	// Deleting an account cannot be undone, so a click is not enough: its name has to be
	// typed out first.
	const phrase = $derived(auth.username || 'delete');
	let typed = $state('');

	function askToLeave() {
		typed = '';
		error = '';
		leaving?.showModal();
	}
	let error = $state('');

	async function deleteAccount() {
		if (!supabase) return;
		busy = true;
		error = '';
		const { error: refused } = await supabase.rpc('delete_account');
		if (refused) {
			error = refused.message;
			busy = false;
			return;
		}
		leaving?.close();
		await goto(resolve('/'));
		// The account is gone, so there is nothing to tell the login service: only this
		// browser's copy of the session is left to clear.
		await supabase.auth.signOut({ scope: 'local' });
	}
</script>

<svelte:head>
	<title>Account · {SITE_NAME}</title>
</svelte:head>

{#snippet fact(label: string, value: string)}
	<div class="flex justify-between gap-4 border-b border-border px-3 py-1.5 last:border-b-0">
		<dt class="text-muted">{label}</dt>
		<dd class="truncate">{value}</dd>
	</div>
{/snippet}

{#if !auth.ready}
	<p class="py-12 text-center text-muted">Loading…</p>
{:else if !user}
	<div class="panel mx-auto mt-8 max-w-sm p-5 text-center">
		<p class="text-muted">You are not logged in.</p>
		<a href={loginHref(page.url)} class="btn btn-primary mt-4">Log in</a>
	</div>
{:else}
	<div class="page-workspace">
		<aside class="page-sidebar">
			<ResponsiveSidebar label="Account details and options">
			<div class="panel">
				<div class="border-b border-border px-3 py-3">
					<h1 class="truncate text-2xl leading-tight font-bold">{auth.username}</h1>
					<p class={auth.isAdmin ? 'text-accent' : 'text-muted'}>
						{auth.isOwner ? 'Owner' : auth.isAdmin ? 'Admin' : 'Member'}
					</p>
				</div>
				<dl>
					{@render fact('Addons posted', String(mine.length))}
					{#if imported.length}{@render fact('Imports approved', String(imported.length))}{/if}
					{#if logins}{@render fact('Linked account', logins)}{/if}
					{@render fact('Joined', date(user.created_at))}
				</dl>
			</div>
			<section class="panel px-3 py-2" aria-labelledby="account-options">
				<h2 id="account-options" class="label">Options</h2>
				<label class="flex cursor-pointer items-start gap-2 text-sm">
					<input
						type="checkbox"
						class="mt-1 accent-accent"
						bind:checked={preferences.hideOlder}
						onchange={savePreferences}
					/>
					<span>Hide addons last updated 8+ years ago</span>
				</label>
			</section>
			<button class="btn w-full" onclick={signOut}>Log out</button>
			<!-- The owner looks after the admins; the site must not be left without one. -->
			{#if !auth.isOwner}
				<button class="btn btn-danger w-full" onclick={askToLeave}>Delete account</button>
			{/if}
		</ResponsiveSidebar>
		</aside>

		<section class="min-w-0 md:flex md:h-full md:min-h-0 md:flex-col">
			<div class="shrink-0 pb-2">
				<input class="input w-full" type="search" aria-label="Search your addons" placeholder="Search your favorites and addons" bind:value={query} />
				<nav class="section-navigation panel mt-2 flex px-1" aria-label="Account sections">
					{#each [{ id: 'favorites-title', label: 'Favorites' }, { id: 'account-posted', label: 'Your addons' }, ...(imported.length ? [{ id: 'account-imports', label: 'Approved imports' }] : [])] as tab}
						<button
							class="min-w-0 flex-1 cursor-pointer py-0.5 text-center text-sm font-bold text-muted hover:bg-raised hover:text-accent"
							onclick={() => jump(tab.id)}
						>{tab.label}</button>
					{/each}
				</nav>
			</div>
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<div class="min-w-0 md:min-h-0 md:flex-1 md:overflow-y-auto md:overscroll-contain" bind:this={list} role="region" aria-label="Account addons" tabindex="0">
			<FavoritesList {query} />
			<h2 id="account-posted" class="label">Your addons</h2>
			<div class="panel addon-list">
				{#each postedMatches as addon (addon.id)}
					<AddonCard {addon} />
				{:else}
					<p class="px-3 py-8 text-center text-muted">{mine.length ? 'No posted addons match your search.' : 'You have not posted anything yet.'}</p>
				{/each}
			</div>

			{#if imported.length}
				<section class="mt-5" aria-labelledby="account-imports">
					<h2 id="account-imports" class="label">Imports you approved · {imported.length}</h2>
					<div class="panel addon-list">
						{#each importedMatches as addon (addon.id)}
							<AddonCard {addon} />
						{:else}
							<p class="px-3 py-8 text-center text-muted">No approved imports match your search.</p>
						{/each}
					</div>
				</section>
			{/if}
			</div>
		</section>
	</div>

	<!-- Cancel is first, so it has the focus: pressing Enter by reflex deletes nothing. -->
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
	<dialog
		bind:this={leaving}
		class="dialog w-[min(28rem,92vw)] p-4"
		aria-labelledby="leave-title"
		onclick={(event) => event.target === leaving && leaving?.close()}
	>
		<h2 id="leave-title" class="text-xl leading-tight font-bold">Delete your account?</h2>
		<p class="mt-2 text-muted">
			Your login, email address and username are removed for good. This cannot be undone.
		</p>
		{#if mine.length}
			<p class="mt-2 text-muted">
				The {mine.length === 1 ? 'addon' : `${mine.length} addons`} you posted
				{mine.length === 1 ? 'stays' : 'stay'} in the list, belonging to nobody. To take one down, delete
				it from its own page first.
			</p>
		{/if}
		<!-- The name to type stands out from the sentence around it, and is selected by a click. -->
		<label class="mt-4 mb-1.5 block text-muted" for="leave-confirm">
			To confirm, type
			<span class="mx-0.5 border border-accent/50 bg-raised px-1.5 py-0.5 font-bold text-accent select-all">{phrase}</span>
			below
		</label>
		<input
			id="leave-confirm"
			class="input"
			autocomplete="off"
			autocapitalize="off"
			spellcheck="false"
			bind:value={typed}
		/>
		{#if error}<p class="mt-3 text-danger">{error}</p>{/if}
		<div class="mt-4 flex justify-end gap-2">
			<button class="btn" onclick={() => leaving?.close()}>Cancel</button>
			<button class="btn btn-danger" disabled={busy || typed.trim() !== phrase} onclick={deleteAccount}>
				Delete account
			</button>
		</div>
	</dialog>
{/if}
