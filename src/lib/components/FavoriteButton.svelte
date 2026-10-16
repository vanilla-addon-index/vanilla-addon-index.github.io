<script lang="ts">
	import { page } from '$app/state';
	import { auth } from '#lib/auth.svelte.ts';
	import { supabase } from '#lib/supabase.ts';
	import { loginHref } from '#lib/return.ts';
	let { addonId }: { addonId: number } = $props();
	let saved = $state(false), loading = $state(true), busy = $state(false), error = $state('');
	let loadFailed = $state(false), retry = $state(0);
	$effect(() => {
		const user = auth.session?.user.id, id = addonId;
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

{#if auth.ready}
	{#if auth.session}
		<button class="btn" aria-pressed={saved} disabled={loading || busy || loadFailed} onclick={toggle}>
			{loading ? 'Loading favorite…' : saved ? 'Remove from favorites' : 'Add to favorites'}
		</button>
		{#if error}<p class="mt-1 text-sm text-danger" role="alert">{error}</p>{/if}
		{#if loadFailed}<button class="btn mt-1" onclick={() => retry++}>Try again</button>{/if}
	{:else}
		<a class="btn" href={loginHref(page.url)}>Log in to favorite</a>
	{/if}
{/if}
