<script lang="ts">
	import { afterNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { store } from '#lib/addons.svelte.ts';
	import AddonCard from '#lib/components/AddonCard.svelte';
	import { CATEGORIES } from '#lib/config.ts';
	import { HOME_TITLE } from '#lib/seo.ts';
	import { creditFor } from '#lib/links.ts';
	import type { Addon } from '#lib/types.ts';

	const SORTS = { name: 'Name', new: 'Newest', updated: 'Recently updated' } as const;
	type Sort = keyof typeof SORTS;

	let query = $state('');
	let category = $state('');
	let sort = $state<Sort>('name');

	function readUrl(params: Pick<URLSearchParams, 'get'>) {
		const wanted = params.get('sort') ?? '';
		query = params.get('q') ?? '';
		category = params.get('cat') ?? '';
		sort = wanted in SORTS ? (wanted as Sort) : 'name';
	}
	readUrl(page.url.searchParams);
	// Links back to this page (logo, tag chips) do not remount it.
	afterNavigate(({ to }) => to && readUrl(to.url.searchParams));

	// One block per addon, or per group of versions. A group shows when any of its versions
	// matches, and is placed in the list by its main version.
	const blocks = $derived.by(() => {
		const words = query.toLowerCase().split(/\s+/).filter(Boolean);
		const matches = (a: Addon) => {
			if (category && a.category !== category) return false;
			// The links are searched too, so a repository owner's name finds their addons.
			const links = a.versions.map((v) => v.url).join(' ');
			const haystack = `${a.name} ${a.summary} ${a.description} ${a.author} ${links}`.toLowerCase();
			return words.every((w) => haystack.includes(w));
		};

		const groups = new Map<number, Addon[]>();
		const list: { main: Addon; others: Addon[] }[] = [];
		for (const a of store.addons) {
			if (a.group_id === null) {
				if (matches(a)) list.push({ main: a, others: [] });
			} else if (groups.has(a.group_id)) {
				groups.get(a.group_id)!.push(a);
			} else {
				groups.set(a.group_id, [a]);
			}
		}
		for (const members of groups.values()) {
			if (!members.some(matches)) continue;
			const main = members.find((m) => m.is_main) ?? members[0];
			const others = members
				.filter((m) => m !== main)
				.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
			list.push({ main, others });
		}

		if (sort === 'new') return list.sort((a, b) => b.main.created_at.localeCompare(a.main.created_at));
		if (sort === 'updated') return list.sort((a, b) => b.main.updated_at.localeCompare(a.main.updated_at));
		return list.sort((a, b) => a.main.name.localeCompare(b.main.name));
	});
	const shownCount = $derived(blocks.reduce((n, block) => n + 1 + block.others.length, 0));

	const counts = $derived(Object.groupBy(store.addons, (a) => a.category));

	// Names used by more than one addon; their rows also say who hosts each.
	const sharedNames = $derived.by(() => {
		const seen = new Set<string>();
		const shared = new Set<string>();
		for (const { name } of store.addons) (seen.has(name.toLowerCase()) ? shared : seen).add(name.toLowerCase());
		return shared;
	});

	// Keep the URL shareable without adding a history entry per keystroke.
	$effect(() => {
		const next = new URLSearchParams();
		if (query) next.set('q', query);
		if (category) next.set('cat', category);
		if (sort !== 'name') next.set('sort', sort);
		const search = next.size ? `?${next}` : '';
		if (search !== location.search) {
			goto(`${location.pathname}${search}`, { replace: true, shallow: true });
		}
	});
</script>

<svelte:head>
	<title>{HOME_TITLE}</title>
</svelte:head>

{#snippet categoryButton(value: string, label: string, count: number)}
	<button
		class={[
			'flex w-full cursor-pointer justify-between border-l-2 px-3 py-1 text-left transition-colors duration-100 hover:bg-raised',
			category === value ? 'border-accent text-accent' : 'border-transparent',
			!count && category !== value && 'text-muted'
		]}
		aria-pressed={category === value}
		onclick={() => (category = value)}
	>
		<span>{label}</span>
		<span class="text-sm leading-7 text-muted">{count}</span>
	</button>
{/snippet}

<div class="grid items-start gap-4 md:grid-cols-[13rem_minmax(0,1fr)]">
	<aside class="panel hidden py-1 md:block">
		<h2 class="label px-3 pt-2">Categories</h2>
		{@render categoryButton('', 'All addons', store.addons.length)}
		{#each CATEGORIES as c (c)}
			{@render categoryButton(c, c, counts[c]?.length ?? 0)}
		{/each}
	</aside>

	<section>
		<div class="flex flex-wrap gap-2">
			<input
				class="input flex-1 basis-full sm:min-w-48 sm:basis-0"
				type="search"
				placeholder="Search {store.addons.length || ''} addons by name, description, author or link"
				aria-label="Search addons"
				bind:value={query}
			/>
			<select class="input w-auto flex-1 sm:flex-none md:hidden" aria-label="Category" bind:value={category}>
				<option value="">All categories</option>
				{#each CATEGORIES as c (c)}
					<option value={c}>{c} ({counts[c]?.length ?? 0})</option>
				{/each}
			</select>
			<select class="input w-auto flex-1 sm:w-44 sm:flex-none" aria-label="Sort by" bind:value={sort}>
				{#each Object.entries(SORTS) as [value, label] (value)}
					<option {value}>{label}</option>
				{/each}
			</select>
		</div>

		<div class="panel mt-2">
			{#if !store.loaded}
				<p class="px-3 py-8 text-center text-muted">Loading addons…</p>
			{:else if blocks.length}
				{#each blocks as { main, others } (main.id)}
					<AddonCard
						addon={main}
						owner={creditFor(main, others.length > 0 || sharedNames.has(main.name.toLowerCase()))}
					/>
					{#each others as other (other.id)}
						<AddonCard addon={other} owner={creditFor(other, true)} minor />
					{/each}
				{/each}
			{:else}
				<p class="px-3 py-8 text-center text-muted">
					{store.addons.length ? 'No addons match your search.' : 'No addons have been posted yet.'}
				</p>
			{/if}
		</div>
		{#if store.loaded && blocks.length}
			<p class="mt-2 text-sm text-muted">
				{shownCount} of {store.addons.length} addons
			</p>
		{/if}
	</section>
</div>
