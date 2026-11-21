<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { matchesAddonSearch, prepareAddonQuery, prepareAddonSearch } from '#lib/addon-search.ts';
	import { isOlderAddon, MAX_UPDATE_AGE } from '#lib/addon-age.ts';
	import { latestAddonCodeUpdate, newestCodeUpdate } from '#lib/addon-update.ts';
	import { preferences, loadPreferences, savePreferences } from '#lib/preferences.svelte.ts';
	import { afterNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { store } from '#lib/addons.svelte.ts';
	import CollectionSwitch from '#lib/components/CollectionSwitch.svelte';
	import AddonCard from '#lib/components/AddonCard.svelte';
	import { CATEGORIES } from '#lib/config.ts';
	import { HOME_TITLE } from '#lib/seo.ts';
	import { creditFor } from '#lib/links.ts';
	import type { Addon, CodeUpdate } from '#lib/types.ts';
	import type { Snapshot } from '@sveltejs/kit';

	import { SORTS, readSort, compareCodeUpdateDates, type Sort } from '#lib/addon-sort.ts';

	let query = $state('');
	let category = $state('');
	let entryType = $state<'addon' | 'dll'>('addon');
	const collectionLabel = $derived(entryType === 'dll' ? 'DLL mods' : 'addons');
	function switchCollection(next: 'addon' | 'dll') { entryType = next; category = ''; }
	let sort = $state<Sort>('name');
	let adjustingAge = $state(false);
	let draftUpdateAge = $state(0);
	const allUpdateYears = MAX_UPDATE_AGE + 1;
	let appliedUpdateAge = $state(0);
	let agePreviewTimer: ReturnType<typeof setTimeout> | undefined;
	let ageApplyFrame: number | undefined;
	let lastAgeInputAt = 0;
	let ageSettlesAt = 0;
	function cancelAgePreview() {
		clearTimeout(agePreviewTimer);
		agePreviewTimer = undefined;
		if (ageApplyFrame !== undefined) cancelAnimationFrame(ageApplyFrame);
		ageApplyFrame = undefined;
	}
	function beginAgeAdjustment() {
		if (adjustingAge) return;
		cancelAgePreview();
		lastAgeInputAt = performance.now();
		ageSettlesAt = 0;
		adjustingAge = true;
	}
	// Sample the latest cutoff while dragging rather than rebuilding at every step.
	function previewUpdateAge() {
		if (agePreviewTimer !== undefined) return;
		function preview() {
			const remaining = ageSettlesAt - performance.now();
			if (remaining > 0) {
				agePreviewTimer = setTimeout(preview, remaining);
				return;
			}
			agePreviewTimer = undefined;
			appliedUpdateAge = draftUpdateAge;
		}
		agePreviewTimer = setTimeout(preview, 150);
	}
	function applyUpdateAge() {
		const wasAdjusting = adjustingAge;
		cancelAgePreview();
		adjustingAge = false;
		if (wasAdjusting) {
			// Paint the released handle and dismiss the tooltip before rebuilding rows.
			ageApplyFrame = requestAnimationFrame(() => {
				ageApplyFrame = undefined;
				agePreviewTimer = setTimeout(() => {
					agePreviewTimer = undefined;
					appliedUpdateAge = draftUpdateAge;
				}, 0);
			});
		} else {
			appliedUpdateAge = draftUpdateAge;
		}
		if (preferences.maxUpdateAge === draftUpdateAge) return;
		preferences.maxUpdateAge = draftUpdateAge;
		savePreferences();
	}
	let ageTooltip = $state<HTMLSpanElement>();
	let agePointer = $state({ x: 0, y: 0 });
	function positionAgeTooltip(x: number, y: number) {
		agePointer = { x: Math.max(70, Math.min(window.innerWidth - 70, x)), y: Math.min(window.innerHeight - 36, y + 16) };
	}
	$effect(() => {
		if (ageTooltip) {
			ageTooltip.style.left = `${agePointer.x}px`;
			ageTooltip.style.top = `${agePointer.y}px`;
		}
	});
	const updateCutoffYear = $derived(new Date().getFullYear() - draftUpdateAge + 1);
	onMount(() => {
		loadPreferences();
		draftUpdateAge = preferences.maxUpdateAge;
		appliedUpdateAge = preferences.maxUpdateAge;
		return cancelAgePreview;
	});
	const updates = $derived(new Map(store.addons.map((addon) => [addon.id, latestAddonCodeUpdate(addon)])));
	const visibleAddons = $derived.by(() => {
		const now = new Date();
		return store.addons.filter((a) => (a.entry_type ?? 'addon') === entryType && (!appliedUpdateAge || !isOlderAddon(updates.get(a.id)?.date, now, appliedUpdateAge)));
	});

	function readUrl(params: Pick<URLSearchParams, 'get'>) {
		entryType = params.get('type') === 'dll' ? 'dll' : 'addon';
		query = params.get('q') ?? '';
		category = entryType === 'dll' ? '' : (params.get('cat') ?? '');
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

	// Collection and update age decide which versions are eligible. Keep that grouping
	// and its sort order when search or category filters change.
	const catalogueBlocks = $derived.by(() => {
		const groups = new Map<number, Addon[]>();
		const list: { main: Addon; others: Addon[]; update?: CodeUpdate }[] = [];
		for (const a of visibleAddons) {
			if (a.group_id === null) {
				list.push({ main: a, others: [], update: updates.get(a.id) });
			} else if (groups.has(a.group_id)) {
				groups.get(a.group_id)!.push(a);
			} else {
				groups.set(a.group_id, [a]);
			}
		}
		for (const members of groups.values()) {
			const main = members.find((m) => m.is_main) ?? members[0];
			const others = members
				.filter((m) => m !== main)
				.sort((a, b) => compareCodeUpdateDates(updates.get(a.id)?.date, updates.get(b.id)?.date) || a.name.localeCompare(b.name));
			list.push({ main, others, update: newestCodeUpdate(members.map((member) => updates.get(member.id))) });
		}

		return list;
	});
	const nameBlocks = $derived(catalogueBlocks.toSorted((a, b) => a.main.name.localeCompare(b.main.name)));
	const codeBlocks = $derived(catalogueBlocks.toSorted((a, b) =>
		compareCodeUpdateDates(a.update?.date, b.update?.date) || a.main.name.localeCompare(b.main.name)
	));
	// Catalogue updates replace changed rows. Prepare a candidate only when it is searched.
	const searchIndex = new WeakMap<Addon, ReturnType<typeof prepareAddonSearch>>();
	const terms = $derived(prepareAddonQuery(query));
	const blocks = $derived.by(() => {
		const ordered = sort === 'code' ? codeBlocks : nameBlocks;
		const selectedCategory = category;
		const search = terms;
		if (!selectedCategory && !search.words.length) return ordered;
		// The same version must match both filters. Display its whole eligible group.
		const matches = (addon: Addon) => {
			if (selectedCategory && addon.category !== selectedCategory) return false;
			if (!search.words.length) return true;
			let prepared = searchIndex.get(addon);
			if (!prepared) {
				prepared = prepareAddonSearch(addon);
				searchIndex.set(addon, prepared);
			}
			return matchesAddonSearch(prepared, search);
		};
		return ordered.filter(({ main, others }) => matches(main) || others.some(matches));
	});

	// The heading an addon files under when the list is sorted by name.
	function letterOf(name: string) {
		const first = name.normalize('NFD').charAt(0).toUpperCase();
		return first >= 'A' && first <= 'Z' ? first : '#';
	}

	type CatalogueRow = { addon: Addon; minor?: boolean; credit?: string; updateDate?: string };
	type CatalogueSection = { letter: string; rows: CatalogueRow[]; descriptions: number; updateRows: number };
	const sections = $derived.by(() => {
		const result: CatalogueSection[] = [];
		let lastLetter = '';
		let section: CatalogueSection | undefined;
		for (const { main, others, update } of blocks) {
			const letter = sort === 'name' ? letterOf(main.name) : '';
			const heading = letter === lastLetter ? '' : letter;
			lastLetter = letter;
			// Keep each group together and start a section at each letter jump.
			if (!section || heading || section.rows.length + others.length >= 32) {
				section = { letter: heading, rows: [], descriptions: 0, updateRows: 0 };
				result.push(section);
			}
			section.rows.push({ addon: main, credit: others.length ? creditFor(main, true) : undefined, updateDate: update?.date });
			section.updateRows++;
			for (const addon of others) section.rows.push({ addon, minor: true, credit: creditFor(addon, true) });
		}
		for (const section of result) {
			for (const { addon } of section.rows) {
				if (addon.description.trim()) section.descriptions++;
			}
		}
		return result;
	});

	// The bar of letters above a list sorted by name: each jumps to its heading, and the one
	// being read is lit. A letter with nothing under it is there too, switched off, so the
	// others keep their places.
	const LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
	const letters = $derived(new Set(blocks.map((b) => letterOf(b.main.name))));
	let bar = $state<HTMLElement>();
	let controls = $state<HTMLElement>();
	let list = $state<HTMLElement>();
	let current = $state('');
	let buffered = new Set<HTMLElement>();

	function prepareViewport(top: number, bottom: number) {
		// Keep one viewport ready on each side. Explicitly prepare the destination on
		// large scroll jumps too, before the browser's next content-visibility check.
		const margin = Math.max(0, bottom - top);
		const nearby = new Set<HTMLElement>();
		for (const section of list?.querySelectorAll<HTMLElement>('.catalogue-section') ?? []) {
			const rect = section.getBoundingClientRect();
			if (rect.top > bottom + margin) break;
			if (rect.height && rect.bottom >= top - margin) nearby.add(section);
		}
		for (const section of nearby) {
			if (!buffered.has(section)) section.setAttribute('data-buffered', '');
		}
		for (const section of buffered) {
			if (!nearby.has(section)) section.removeAttribute('data-buffered');
		}
		buffered = nearby;
	}

	function track() {
		const inner = list && getComputedStyle(list).overflowY === 'auto' ? list.getBoundingClientRect() : undefined;
		prepareViewport(inner?.top ?? 0, inner?.bottom ?? window.innerHeight);
		if (sort !== 'name') {
			current = '';
			return;
		}
		// A little below the bar, so the heading a jump lands on counts as reached.
		const edge = Math.max(inner?.top ?? bar?.getBoundingClientRect().bottom ?? 0, 0) + 16;
		let reached = '';
		for (const heading of list?.querySelectorAll('h2') ?? []) {
			if (heading.getBoundingClientRect().top > edge) break;
			reached = heading.id.slice('letter-'.length);
		}
		current = reached;
	}
	$effect(() => {
		void sections;
		track();
	});
	$effect(() => {
		void query; void category; void sort; void entryType; void appliedUpdateAge;
		if (list) list.scrollTop = 0;
	});

	function focusedLink() {
		const link = document.activeElement;
		if (!(link instanceof HTMLAnchorElement) || !list?.contains(link)) return;
		const id = link.closest<HTMLElement>('[data-catalogue-id]')?.dataset.catalogueId;
		const href = link.getAttribute('href');
		if (id && href) return { id, href };
	}

	function restoreLink({ id, href }: NonNullable<ReturnType<typeof focusedLink>>) {
		list?.querySelector<HTMLAnchorElement>(`[data-catalogue-id="${CSS.escape(id)}"] a[href="${CSS.escape(href)}"]`)
			?.focus({ preventScroll: true });
	}

	$effect.pre(() => {
		void sections;
		const active = document.activeElement;
		const saved = focusedLink();
		if (saved) void tick().then(() => {
			// A live update can move a focused row to another section.
			if (!active?.isConnected && document.activeElement === document.body) restoreLink(saved);
		});
	});

	export const snapshot: Snapshot<{ scrollTop: number; focus?: ReturnType<typeof focusedLink> }> = {
		capture: () => ({ scrollTop: list?.scrollTop ?? 0, focus: focusedLink() }),
		restore: ({ scrollTop, focus }) => {
			// SvelteKit restores the window scroll. On desktop the list scrolls independently.
			void tick().then(() => {
				if (list) list.scrollTop = scrollTop;
				if (focus) restoreLink(focus);
				track();
			});
		}
	};

	// Desktop letters scroll the list itself. Smaller layouts keep the page jump,
	// accounting for sticky controls where present.
	function jump(letter: string) {
		const heading = document.getElementById(`letter-${letter}`);
		if (!heading || !controls) return;
		if (list && getComputedStyle(list).overflowY === 'auto') {
			list.scrollBy(0, heading.getBoundingClientRect().top - list.getBoundingClientRect().top - list.clientTop);
			track();
			return;
		}
		const resting =
			getComputedStyle(controls).position === 'sticky'
				? parseFloat(getComputedStyle(controls).top) + controls.offsetHeight
				: 0;
		window.scrollBy(0, heading.getBoundingClientRect().top - resting);
		track();
	}

	const counts = $derived(Object.groupBy(visibleAddons, (a) => a.category));

	// Keep the URL shareable without adding a history entry per keystroke.
	$effect(() => {
		const next = new URLSearchParams();
		if (entryType === 'dll') next.set('type', 'dll');
		if (query) next.set('q', query);
		if (category) next.set('cat', category);
		if (sort !== 'name') next.set('sort', sort);
		const search = next.size ? `?${next}` : '';
		if (search !== location.search) {
			goto(`${location.pathname}${search}`, { replace: true, shallow: true });
		}
	});
</script>

<svelte:window onscroll={track} onresize={track} />

<svelte:head>
	<title>{HOME_TITLE}</title>
</svelte:head>

{#snippet categoryButton(value: string, label: string, count: number)}
	<button
		class={[
			'flex w-full justify-between border-l-2 px-3 py-0.5 text-left transition-colors duration-100',
			entryType === 'dll' ? 'cursor-default border-transparent text-muted' : 'cursor-pointer hover:bg-raised',
			entryType !== 'dll' && category === value ? 'border-accent text-accent' : 'border-transparent',
			!count && category !== value && 'text-muted'
		]}
		disabled={entryType === 'dll'}
		aria-pressed={entryType !== 'dll' && category === value}
		onclick={() => (category = value)}
	>
		<span>{label}</span>
		<span class="text-sm leading-7 text-muted">{entryType === 'dll' ? 0 : count}</span>
	</button>
{/snippet}

<div class="grid items-start gap-4 md:h-[calc(100dvh-var(--header-h)-var(--footer-h)-1.25rem)] md:min-h-0 md:grid-cols-[13rem_minmax(0,1fr)]">
	<!-- The collection switch stays above the independently scrolling categories. -->
	<aside class="hidden max-h-full min-h-0 flex-col gap-2 md:flex">
		<div class="shrink-0"><CollectionSwitch value={entryType} onchange={switchCollection} /></div>
		<div class={['panel min-h-0 overflow-y-auto py-1', entryType === 'dll' && 'bg-bg/70']}>
			<div class={entryType === 'dll' ? 'opacity-40' : undefined}>
			<h2 class="label px-3 pt-2">Categories</h2>
			{@render categoryButton('', 'All addons', visibleAddons.length)}
			{#each CATEGORIES as c (c)}
				{@render categoryButton(c, c, counts[c]?.length ?? 0)}
			{/each}
			</div>
		</div>
	</aside>

	<section class="min-w-0 md:flex md:h-full md:min-h-0 md:flex-col">
		<!-- The search box and the letter bar stay where they are while the list scrolls. They
		     bring the gaps around them along, painted like the page, so rows vanish at the lower
		     edge of the gap under them and never show above or between them. -->
		<div bind:this={controls} class="backdrop -mt-5 pt-5 pb-2 sm:sticky sm:top-(--header-h) sm:z-10">
			<div class="mb-2 md:hidden"><CollectionSwitch value={entryType} onchange={switchCollection} /></div>
			<div class="flex flex-wrap gap-2">
				<div class="flex min-w-0 flex-1 basis-full items-stretch gap-2 sm:basis-0">
					<label class="relative flex w-28 shrink-0 items-center gap-1.5 border border-border bg-surface px-2.5 text-xs leading-tight text-muted sm:w-32">
						{#if adjustingAge}
							<span bind:this={ageTooltip} class="pointer-events-none fixed z-50 -translate-x-1/2 whitespace-nowrap border border-border bg-bg/80 px-2 py-1 text-sm text-fg/90 shadow-lg" aria-hidden="true">{draftUpdateAge ? `${updateCutoffYear} onward` : 'All years'}</span>
						{/if}
						<span class="text-muted/80" aria-hidden="true">−</span>
						<input class="age-slider m-0 h-5 min-w-0 w-full cursor-pointer" type="range" min="1" max={allUpdateYears} step="1"
							aria-label="Maximum update age" aria-valuetext={draftUpdateAge ? `Updated in ${updateCutoffYear} or later. Unknown dates stay visible.` : 'All years'}
							value={draftUpdateAge || allUpdateYears}
							onpointerdown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); positionAgeTooltip(event.clientX, event.clientY); beginAgeAdjustment(); }}
							onpointermove={(event) => { if (adjustingAge) positionAgeTooltip(event.clientX, event.clientY); }}
							onpointerup={() => { if (adjustingAge) applyUpdateAge(); }}
							onpointercancel={() => { if (adjustingAge) applyUpdateAge(); }}
							onlostpointercapture={() => { if (adjustingAge) applyUpdateAge(); }}
							onkeydown={(event) => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) { const rect = event.currentTarget.getBoundingClientRect(); positionAgeTooltip(rect.left + rect.width / 2, rect.bottom); beginAgeAdjustment(); } }}
							onkeyup={() => { if (adjustingAge) applyUpdateAge(); }}
							onblur={() => { if (adjustingAge) applyUpdateAge(); }}
							oninput={(event) => {
								const years = Number(event.currentTarget.value);
								const now = performance.now();
								// Let quick sweeps settle instead of rendering years the pointer already passed.
								const speed = Math.abs(years - (draftUpdateAge || allUpdateYears)) / Math.max(1, now - lastAgeInputAt);
								if (speed >= 0.08) ageSettlesAt = now + 100;
								lastAgeInputAt = now;
								draftUpdateAge = years === allUpdateYears ? 0 : years;
								if (adjustingAge) previewUpdateAge(); else applyUpdateAge();
							}} />
						<span class="text-muted/80" aria-hidden="true">∞</span>
					</label>
					<input
						class="input min-w-0 flex-1"
						type="search"
						placeholder="Search {visibleAddons.length || ''} {collectionLabel} by name, description, author or link"
						aria-label="Search {collectionLabel}"
						bind:value={query}
					/>
				</div>
				<select class="input min-w-0 w-auto flex-1 disabled:opacity-40 sm:flex-none md:hidden" disabled={entryType === 'dll'} aria-label="Category" bind:value={category}>
					<option value="">{entryType === 'dll' ? 'Categories unavailable' : 'All categories'}</option>
					{#each CATEGORIES as c (c)}
						<option value={c}>{c} ({entryType === 'dll' ? 0 : (counts[c]?.length ?? 0)})</option>
					{/each}
				</select>
				<select class="input min-w-0 w-28 flex-none sm:w-32" aria-label="Sort by" bind:value={sort}>
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
		<div class="panel addon-list md:min-h-0 md:flex-1 md:content-start md:overflow-y-auto md:overscroll-contain" bind:this={list} onscroll={track} role="region" aria-label={entryType === 'dll' ? 'DLL mod list' : 'Addon list'} tabindex="0">
			{#if !store.loaded}
				<p class="px-3 py-8 text-center text-muted">Loading addons…</p>
			{:else if blocks.length}
				{#each sections as { letter, rows, descriptions, updateRows } (rows[0].addon.id)}
					{#if letter}
						<h2
							id="letter-{letter}"
							class="label mb-0 border-b border-border/50 px-3 pt-2 pb-0.5 text-accent/70"
						>
							{letter}
						</h2>
					{/if}
					<div class="catalogue-section" style:--rows={rows.length} style:--descriptions={descriptions} style:--update-rows={updateRows}>
						{#each rows as { addon, minor, credit, updateDate } (addon.id)}
							<AddonCard {addon} {minor} {updateDate} owner={credit} catalogueId={addon.id} />
						{/each}
					</div>
				{/each}
			{:else}
				<p class="px-3 py-8 text-center text-muted">
					{visibleAddons.length ? `No ${collectionLabel} match your search.` : `No ${collectionLabel} to show yet.`}
				</p>
			{/if}
		</div>
	</section>
</div>

<style>
	.age-slider {
		appearance: none;
		background: transparent;
	}
	@media (pointer: coarse) {
		.age-slider {
			min-height: 44px;
			touch-action: pan-y;
		}
	}
	.age-slider::-webkit-slider-runnable-track {
		height: 2px;
		background: var(--color-border);
	}
	.age-slider::-moz-range-track {
		height: 2px;
		background: var(--color-border);
	}
	.age-slider::-webkit-slider-thumb {
		appearance: none;
		width: 11px;
		height: 11px;
		margin-top: -4.5px;
		border-radius: 50%;
		background: color-mix(in srgb, var(--color-accent) 65%, var(--color-muted));
	}
	.age-slider::-moz-range-thumb {
		width: 11px;
		height: 11px;
		border: 0;
		border-radius: 50%;
		background: color-mix(in srgb, var(--color-accent) 65%, var(--color-muted));
	}
	.age-slider:hover::-webkit-slider-thumb,
	.age-slider:focus-visible::-webkit-slider-thumb {
		background: var(--color-accent);
	}
	.age-slider:hover::-moz-range-thumb,
	.age-slider:focus-visible::-moz-range-thumb {
		background: var(--color-accent);
	}
</style>
