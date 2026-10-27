<script lang="ts">
	import { onMount } from 'svelte';
	import { isOlderAddon } from '#lib/addon-age.ts';
	import { preferences, loadPreferences } from '#lib/preferences.svelte.ts';
	import { afterNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { store } from '#lib/addons.svelte.ts';
	import AddonCard from '#lib/components/AddonCard.svelte';
	import { CATEGORIES } from '#lib/config.ts';
	import { HOME_TITLE } from '#lib/seo.ts';
	import { creditFor } from '#lib/links.ts';
	import type { Addon } from '#lib/types.ts';

	import { SORTS, readSort, byCodeUpdate, type Sort } from '#lib/addon-sort.ts';

	let query = $state('');
	let category = $state('');
	let sort = $state<Sort>('name');
	onMount(() => {
		loadPreferences();
	});
	const visibleAddons = $derived(store.addons.filter((a) => !preferences.hideOlder || !isOlderAddon(a.code_update?.date)));

	function readUrl(params: Pick<URLSearchParams, 'get'>) {
		query = params.get('q') ?? '';
		category = params.get('cat') ?? '';
		sort = readSort(params.get('sort'));
	}
	readUrl((page.shallow?.url ?? page.url).searchParams);
	// Links back to this page (logo, tag chips) do not remount it.
	afterNavigate(({ type }) => {
		const url = new URL(location.href);
		// A refresh starts a fresh list; opening a shared search link still honours it.
		if (type === 'enter' && (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type === 'reload') {
			url.searchParams.delete('q');
			url.searchParams.delete('sort');
		}
		// Shallow URL updates live in page.shallow, while page.url can still be the
		// original address. The browser address also covers restored history entries.
		readUrl(url.searchParams);
	});

	// One block per addon, or per group of versions. A group shows when any of its versions
	// matches, and is placed in the list by its main version.
	const filteredBlocks = $derived.by(() => {
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
		for (const a of visibleAddons) {
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
				.sort(byCodeUpdate);
			list.push({ main, others });
		}

		return list;
	});
	const nameBlocks = $derived(filteredBlocks.toSorted((a, b) => a.main.name.localeCompare(b.main.name)));
	const codeBlocks = $derived(filteredBlocks.toSorted((a, b) => byCodeUpdate(a.main, b.main)));
	const blocks = $derived(sort === 'code' ? codeBlocks : nameBlocks);

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
	let controls = $state<HTMLElement>();
	let list = $state<HTMLElement>();
	let current = $state('');

	function track() {
		if (sort !== 'name') {
			current = '';
			return;
		}
		// A little below the bar, so the heading a jump lands on counts as reached.
		const edge = Math.max(list && getComputedStyle(list).overflowY === 'auto'
			? list.getBoundingClientRect().top : bar?.getBoundingClientRect().bottom ?? 0, 0) + 16;
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
	$effect(() => {
		void query; void category; void sort;
		if (list) list.scrollTop = 0;
	});

	// Desktop letters scroll the list itself. Smaller layouts keep the page jump,
	// accounting for sticky controls where present.
	function jump(letter: string) {
		const heading = document.getElementById(`letter-${letter}`);
		if (!heading || !controls) return;
		if (list && getComputedStyle(list).overflowY === 'auto') {
			list.scrollBy(0, heading.getBoundingClientRect().top - list.getBoundingClientRect().top - list.clientTop);
			return;
		}
		const resting =
			getComputedStyle(controls).position === 'sticky'
				? parseFloat(getComputedStyle(controls).top) + controls.offsetHeight
				: 0;
		window.scrollBy(0, heading.getBoundingClientRect().top - resting);
	}

	const counts = $derived(Object.groupBy(visibleAddons, (a) => a.category));

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
			'flex w-full cursor-pointer justify-between border-l-2 px-3 py-0.5 text-left transition-colors duration-100 hover:bg-raised',
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

<div class="grid items-start gap-4 md:h-[calc(100dvh-var(--header-h)-var(--footer-h)-1.25rem)] md:min-h-0 md:grid-cols-[13rem_minmax(0,1fr)]">
	<!-- Stays where it is beside the list; on a window too short for it, it scrolls by itself. -->
	<aside
		class="panel hidden max-h-full overflow-y-auto py-1 md:block"
	>
		<h2 class="label px-3 pt-2">Categories</h2>
		{@render categoryButton('', 'All addons', visibleAddons.length)}
		{#each CATEGORIES as c (c)}
			{@render categoryButton(c, c, counts[c]?.length ?? 0)}
		{/each}
	</aside>

	<section class="min-w-0 md:flex md:h-full md:min-h-0 md:flex-col">
		<!-- The search box and the letter bar stay where they are while the list scrolls. They
		     bring the gaps around them along, painted like the page, so rows vanish at the lower
		     edge of the gap under them and never show above or between them. -->
		<div bind:this={controls} class="backdrop -mt-5 pt-5 pb-2 sm:sticky sm:top-(--header-h) sm:z-10">
			<div class="flex flex-wrap gap-2">
				<input
					class="input flex-1 basis-full sm:min-w-48 sm:basis-0"
					type="search"
					placeholder="Search {store.addons.length || ''} addons by name, description, author or link"
					aria-label="Search addons"
					bind:value={query}
				/>
				<select class="input min-w-0 w-auto flex-1 sm:flex-none md:hidden" aria-label="Category" bind:value={category}>
					<option value="">All categories</option>
					{#each CATEGORIES as c (c)}
						<option value={c}>{c} ({counts[c]?.length ?? 0})</option>
					{/each}
				</select>
				<select class="input min-w-0 w-auto flex-1 sm:w-44 sm:flex-none" aria-label="Sort by" bind:value={sort}>
					{#each Object.entries(SORTS) as [value, label] (value)}
						<option {value}>{label}</option>
					{/each}
				</select>
			</div>

			{#if sort === 'name' && blocks.length}
					<nav bind:this={bar} class="letter-navigation panel mt-2 flex overflow-x-auto px-1" aria-label="Jump to a letter">
						{#each LETTERS as letter (letter)}
							<button
								class={[
									'min-h-11 min-w-11 shrink-0 py-0.5 text-center text-sm font-bold sm:min-h-0 sm:min-w-6 transition-colors duration-100 sm:flex-1',
									!letters.has(letter)
										? 'text-muted/30'
										: ['cursor-pointer hover:bg-raised hover:text-accent', letter === current ? 'text-accent' : 'text-muted']
								]}
								disabled={!letters.has(letter)}
								aria-current={letter === current ? 'true' : undefined}
								onclick={() => jump(letter)}
							>
								{letter}
							</button>
						{/each}
					</nav>
			{/if}
		</div>

		<!-- This scroll region is focusable so keyboard users can scroll it directly. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div class="panel addon-list md:min-h-0 md:flex-1 md:content-start md:overflow-y-auto md:overscroll-contain" bind:this={list} onscroll={track} role="region" aria-label="Addon list" tabindex="0">
			{#if !store.loaded}
				<p class="px-3 py-8 text-center text-muted">Loading addons…</p>
			{:else if blocks.length}
				{#each blocks as { main, others }, i (main.id)}
					{#if sort === 'name' && (i === 0 || letterOf(blocks[i - 1].main.name) !== letterOf(main.name))}
						<h2
							id="letter-{letterOf(main.name)}"
							class="label mb-0 border-b border-border/50 px-3 pt-2 pb-0.5 text-accent/70"
						>
							{letterOf(main.name)}
						</h2>
					{/if}
					<AddonCard
						addon={main}
						defer
						owner={others.length > 0 ? creditFor(main, true) : ''}
					/>
					{#each others as other (other.id)}
						<AddonCard addon={other} owner={creditFor(other, true)} minor defer />
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
