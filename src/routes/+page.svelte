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
			const haystack = `${a.name} ${a.description} ${a.author} ${links}`.toLowerCase();
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

	// The heading an addon files under when the list is sorted by name.
	function letterOf(name: string) {
		const first = name.normalize('NFD').charAt(0).toUpperCase();
		return first >= 'A' && first <= 'Z' ? first : '#';
	}

	// The bar of letters above a list sorted by name: each jumps to its heading, and the one
	// being read is lit. A letter with nothing under it is there too, switched off, so the
	// others keep their places.
	const LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
	const letters = $derived(new Set(blocks.map((b) => letterOf(b.main.name))));
	let bar = $state<HTMLElement>();
	let list = $state<HTMLElement>();
	let current = $state('');

	function track() {
		// A little below the bar, so the heading a jump lands on counts as reached.
		const edge = (bar?.getBoundingClientRect().bottom ?? 0) + 16;
		let reached = '';
		for (const heading of list?.querySelectorAll('h2') ?? []) {
			if (heading.getBoundingClientRect().top > edge) break;
			reached = heading.id.slice('letter-'.length);
		}
		current = reached;
	}
	$effect(() => {
		void blocks;
		track();
	});

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

<svelte:window onscroll={track} />

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
	<!-- Stays in view beside the list; on a window too short for it, it scrolls by itself. -->
	<aside class="panel hidden max-h-screen overflow-y-auto py-1 md:sticky md:top-0 md:block">
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

		{#if sort === 'name' && blocks.length}
			<!-- The bar brings the gap under it along when it sticks: rows vanish at the gap's
			     lower edge, behind a strip painted like the page, and never touch the bar. -->
			<div class="backdrop mt-2 -mb-2 pb-2 sm:sticky sm:top-0 sm:z-10">
				<nav bind:this={bar} class="panel grid grid-cols-9 px-1 sm:flex" aria-label="Jump to a letter">
					{#each LETTERS as letter (letter)}
						<button
							class={[
								'min-w-6 py-0.5 text-center text-sm font-bold transition-colors duration-100 sm:flex-1',
								!letters.has(letter)
									? 'text-muted/30'
									: ['cursor-pointer hover:bg-raised hover:text-accent', letter === current ? 'text-accent' : 'text-muted']
							]}
							disabled={!letters.has(letter)}
							aria-current={letter === current ? 'true' : undefined}
							onclick={() => document.getElementById(`letter-${letter}`)?.scrollIntoView()}
						>
							{letter}
						</button>
					{/each}
				</nav>
			</div>
		{/if}

		<div class="panel addon-list mt-2" bind:this={list}>
			{#if !store.loaded}
				<p class="px-3 py-8 text-center text-muted">Loading addons…</p>
			{:else if blocks.length}
				{#each blocks as { main, others }, i (main.id)}
					{#if sort === 'name' && (i === 0 || letterOf(blocks[i - 1].main.name) !== letterOf(main.name))}
						<h2
							id="letter-{letterOf(main.name)}"
							class="label mb-0 scroll-mt-10 border-b border-border/50 px-3 pt-2 pb-0.5 text-accent/70"
						>
							{letterOf(main.name)}
						</h2>
					{/if}
					<AddonCard
						addon={main}
						owner={others.length > 0 || sharedNames.has(main.name.toLowerCase()) ? creditFor(main, true) : ''}
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
	</section>
</div>
