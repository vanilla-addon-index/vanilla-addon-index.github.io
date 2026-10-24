<script lang="ts">
	import { page } from '$app/state';
	import { auth } from '#lib/auth.svelte.ts';
	import { supabase } from '#lib/supabase.ts';
	import { loginHref } from '#lib/return.ts';
	import { cachedFavorite, cacheFavorite, cachedProfileId } from '#lib/favorite-cache.ts';
	let { addonId }: { addonId: number } = $props();
	let saved = $state(false), loading = $state(true), busy = $state(false), error = $state('');
	let loadFailed = $state(false), retry = $state(0);
	const userId = $derived(auth.session?.user.id);
	const restoringUser = cachedProfileId();
	const displayUser = $derived(auth.known ? userId : restoringUser);
	const cached = $derived(cachedFavorite(displayUser, addonId));
	let resolvedKey = $state('');
	const currentKey = $derived(`${displayUser}:${addonId}`);
	const pending = $derived(!auth.known || loading || resolvedKey !== currentKey);
	const displayedSaved = $derived(pending ? cached === true : saved);
	$effect(() => {
		const user = userId, id = addonId;
		void retry;
		let active = true;
		saved = false; loading = true; error = ''; busy = false; loadFailed = false;
		if (user && supabase) {
			supabase.from('addon_favorites').select('addon_id').eq('user_id', user).eq('addon_id', id)
				.then(({ data, error: refused }) => {
					if (!active) return;
					saved = refused ? (cachedFavorite(user, id) ?? false) : !!data?.length;
					if (!refused) cacheFavorite(user, id, saved);
					resolvedKey = `${user}:${id}`;
					error = refused?.message ?? ''; loadFailed = !!refused; loading = false;
				});
		}
		return () => { active = false; };
	});
	async function toggle() {
		if (!supabase || !auth.session || busy || loading) return;
		const user = auth.session.user.id, id = addonId, removing = saved;
		busy = true; error = '';
		try {
			const result = removing
				? await supabase.from('addon_favorites').delete().eq('user_id', user).eq('addon_id', id)
				: await supabase.from('addon_favorites').insert({ user_id: user, addon_id: id });
			if (result.error) throw result.error;
			if (auth.session?.user.id === user && addonId === id) {
				saved = !removing;
				cacheFavorite(user, id, saved);
			}
		} catch (e) {
			if (auth.session?.user.id === user && addonId === id) error = (e as Error).message;
		} finally {
			if (auth.session?.user.id === user && addonId === id) busy = false;
		}
	}
</script>

<!-- A block container keeps the sidebar spacing independent of the inline button's
     text baseline, authentication state, and any error or retry controls. -->
<div>
	{#if !auth.known || auth.session}
		<!-- Reuse the button and its cached contents while revalidating. With no
		     known state, reserve space without painting an empty button shell. -->
		<button class="btn flex w-full disabled:opacity-100" class:invisible={pending && cached === undefined} aria-label={pending && cached === undefined ? 'Loading favorite…' : displayedSaved ? 'Remove from favorites' : 'Add to favorites'} aria-pressed={displayedSaved} aria-busy={pending} disabled={pending || busy || loadFailed} onclick={toggle}>
			<span aria-hidden="true">{displayedSaved ? '★' : '☆'}</span>
			<span>{displayedSaved ? 'Favorited' : 'Add to favorites'}</span>
		</button>
		{#if error}<p class="mt-1 text-sm text-danger" role="alert">{error}</p>{/if}
		{#if loadFailed}<button class="btn mt-1" onclick={() => retry++}>Try again</button>{/if}
	{:else}
		<a class="btn flex w-full" href={loginHref(page.url)}>Log in to favorite</a>
	{/if}
</div>
