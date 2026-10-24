<script lang="ts">
	import { page } from '$app/state';
	import { auth } from '#lib/auth.svelte.ts';
	import { supabase } from '#lib/supabase.ts';
	import { loginHref } from '#lib/return.ts';
	let { addonId }: { addonId: number } = $props();
	let saved = $state(false), loading = $state(true), busy = $state(false), error = $state('');
	let loadFailed = $state(false), retry = $state(0);
	const userId = $derived(auth.session?.user.id);
	$effect(() => {
		const user = userId, id = addonId;
		void retry;
		let active = true;
		saved = false; loading = true; error = ''; busy = false; loadFailed = false;
		if (user && supabase) {
			supabase.from('addon_favorites').select('addon_id').eq('user_id', user).eq('addon_id', id)
				.then(({ data, error: refused }) => {
					if (!active) return;
					saved = !!data?.length; error = refused?.message ?? ''; loadFailed = !!refused; loading = false;
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
			if (auth.session?.user.id === user && addonId === id) saved = !removing;
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
	{#if !auth.ready || (auth.session && loading)}
		<!-- Keep the shell at its final opacity: the shared disabled style otherwise
		     dims it until the favorite request completes, causing a visible blink. -->
		<button class="btn flex w-full disabled:opacity-100" disabled aria-label="Loading favorite…" aria-busy="true">
			<span class="invisible" aria-hidden="true">☆</span>
			<span class="invisible" aria-hidden="true">Add to favorites</span>
		</button>
	{:else}
		{#if auth.session}
			<button class="btn flex w-full" aria-label={saved ? 'Remove from favorites' : 'Add to favorites'} aria-pressed={saved} disabled={busy || loadFailed} onclick={toggle}>
				<span aria-hidden="true">{saved ? '★' : '☆'}</span>
				<span>{saved ? 'Favorited' : 'Add to favorites'}</span>
			</button>
			{#if error}<p class="mt-1 text-sm text-danger" role="alert">{error}</p>{/if}
			{#if loadFailed}<button class="btn mt-1" onclick={() => retry++}>Try again</button>{/if}
		{:else}
			<a class="btn flex w-full" href={loginHref(page.url)}>Log in to favorite</a>
		{/if}
	{/if}

</div>
