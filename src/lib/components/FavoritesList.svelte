<script lang="ts">
	import { resolve } from '$app/paths';
	import { auth } from '#lib/auth.svelte.ts';
	import { store } from '#lib/addons.svelte.ts';
	import { supabase } from '#lib/supabase.ts';
	import { byCodeUpdate } from '#lib/addon-sort.ts';
	let { query = '' }: { query?: string } = $props();
	let ids = $state<number[]>([]), loading = $state(true), error = $state('');
	let retry = $state(0);
	const favorites = $derived(store.addons.filter((a) => ids.includes(a.id)).sort(byCodeUpdate));
	const matching = $derived(favorites.filter(addon => [addon.name, addon.description, addon.category, ...addon.versions.map(version => version.url)].join(' ').toLowerCase().includes(query.trim().toLowerCase())));
	const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
	$effect(() => {
		const user = auth.session?.user.id;
		void retry;
		let active = true;
		ids = []; loading = true; error = '';
		if (user && supabase) {
			supabase.from('addon_favorites').select('addon_id').eq('user_id', user).then(({ data, error: refused }) => {
				if (!active) return;
				ids = data?.map((row) => row.addon_id) ?? []; error = refused?.message ?? ''; loading = false;
			});
		}
		return () => { active = false; };
	});
</script>

<section class="mb-5" aria-labelledby="favorites-title">
	<h2 id="favorites-title" class="label">Your favorites</h2>
	<div class="panel">
		{#if error}
			<p class="px-3 py-3 text-danger" role="alert">Could not load favorites: {error}</p>
			<button class="btn m-3 mt-0" onclick={() => retry++}>Try again</button>
		{:else if loading || !store.loaded}
			<p class="px-3 py-6 text-center text-muted">Loading favorites…</p>
		{:else}
			<ul>
				{#each matching as addon (addon.id)}
					<li class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border px-3 py-2 last:border-b-0">
						<a class="font-bold hover:text-accent" href={resolve('/addon/[slug]', {slug: addon.slug})}>{addon.name}</a>
						<span class="text-sm text-muted">Last code update:
							{#if addon.code_update}
								<time class="text-fg" datetime={addon.code_update.date}>{date(addon.code_update.date)}</time>
							{:else}Unknown{/if}
						</span>
					</li>
				{:else}
					<li class="px-3 py-6 text-center text-muted">{favorites.length ? 'No favorites match your search.' : 'No favorites yet. Open an addon and choose “Add to favorites.”'}</li>
				{/each}
			</ul>
		{/if}
	</div>
</section>
