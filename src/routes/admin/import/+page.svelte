<script lang="ts">
	import { resolve } from '$app/paths';
	import { similarAddon, publishedForkParent, isWikiPage, type ReviewNote } from '#lib/import-review.ts';
	import { store } from '#lib/addons.svelte.ts';
	import { auth } from '#lib/auth.svelte.ts';
	import ImportEntry from '#lib/components/ImportEntry.svelte';
	import { CATEGORIES, SITE_NAME } from '#lib/config.ts';
	import { imports, loadQueue, loadRejected, restore, type QueueItem } from '#lib/imports.svelte.ts';
	import { linkAuthor, linkKey } from '#lib/links.ts';
	import type { Addon } from '#lib/types.ts';
	import { WIKI_NAME } from '#lib/wiki.ts';
	import { suggestCategory } from '#lib/category-scoring.ts';

	const FILTERS = {
		all: 'All',
		fine: 'Looks fine',
		duplicate: 'Possible versions',
		wiki: 'Wiki pages'
	} as const;
	type Verdict = Exclude<keyof typeof FILTERS, 'all'> | 'incomplete' | 'problem';
	// Review buckets are exclusive: missing details and repository issues need review
	// before an entry can be treated as fine or as a possible version.
	// "rejected" is not a filter on the queue but a second list: what was turned down.
	type View = keyof typeof FILTERS | 'incomplete' | 'rejected';

	// The interface number a 1.12 addon declares in its .toc file.
	const VANILLA_INTERFACE = 11200;
	const PAGE = 100;

	let view = $state<View>('all');
	let query = $state('');
	let shown = $state(PAGE);
	// Position of the entry the keyboard shortcuts act on.
	let current = $state(0);
	let notice = $state('');
	let error = $state('');

	$effect(() => {
		if (auth.isAdmin && !imports.loaded) loadQueue().catch((e) => (error = e.message));
	});
	$effect(() => {
		if (auth.isAdmin && view === 'rejected' && !imports.rejectedLoaded) {
			loadRejected().catch((e) => (error = e.message));
		}
	});

	// Names compare without case, spaces or punctuation: "Big Wigs" is "bigwigs".
	const plain = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

	const liveByName = $derived(new Map(store.addons.map((a) => [plain(a.name), a])));
	const liveByKey = $derived(
		new Map(store.addons.flatMap((a) => a.versions.map((v) => [linkKey(v.url), a] as const)))
	);
	const queuedNames = $derived.by(() => {
		const totals = new Map<string, number>();
		for (const item of imports.items) totals.set(plain(item.name), (totals.get(plain(item.name)) ?? 0) + 1);
		return totals;
	});

	interface Review {
		verdict: Verdict;
		// The one-line suggestion shown first.
		advice: string;
		notes: ReviewNote[];
		// A live addon this entry probably belongs to.
		match?: Addon;
		forkMatch?: Addon;
		// What approving it untouched would publish without: any of category, author,
		// description and link.
		missing: string[];
	}

	// The author is the one the link names, which is what approving publishes.
	function gaps(item: QueueItem) {
		const missing: string[] = [];
		if (!(CATEGORIES as readonly string[]).includes(item.category) || suggestCategory(item.name, item.description).confidence === 'Uncertain') missing.push('category');
		if (!linkAuthor(item.url)) missing.push('author');
		if (!item.description.trim()) missing.push('description');
		if (!item.url.trim()) missing.push('link');
		return missing;
	}

	function review(item: QueueItem): Review {
		const forkMatch = publishedForkParent(imports.stats[item.key]?.fork_of, store.addons);
		const judged = judge(item);
		const existing = liveByName.has(plain(item.name)) || forkMatch;
		const missing = gaps(item).filter(field => !existing || field === 'category');
		if (isWikiPage(item.url)) return { ...judged, forkMatch, missing, verdict: 'wiki' };
		return { ...judged, forkMatch, missing, verdict: missing.length || judged.verdict === 'problem' ? 'incomplete' : judged.verdict };
	}

	function judge(item: QueueItem): Omit<Review, 'missing'> {
		const notes: ReviewNote[] = [];
		const missing = gaps(item);
		const stats = imports.stats[item.key];
		const name = plain(item.name);
		const sameName = liveByName.get(name);
		const forkParent = publishedForkParent(stats?.fork_of, store.addons);
		const similar = sameName ? undefined : similarAddon(item.name, store.addons);
		const wikiMain = item.group_key ? liveByKey.get(item.group_key) : undefined;
		const confirmedMatch = wikiMain ?? sameName ?? forkParent;
		const match = confirmedMatch ?? similar;
		const movedTo = stats?.canonical && stats.canonical !== item.key ? stats.canonical : undefined;
		const renamedLive = movedTo ? liveByKey.get(movedTo) : undefined;
		const year = stats?.pushed_at ? new Date(stats.pushed_at).getFullYear() : undefined;
		const wrongClient = stats?.interface != null && stats.interface !== VANILLA_INTERFACE;

		// Facts always come first, in the same order. Warnings and relationships follow.
		notes.push({ label: 'Updated', value: year ? String(year) : 'Unknown' });
		if (stats && !stats.missing) notes.push({ label: 'Stars', value: String(stats.stars) });
		notes.push({ label: 'Client', value: stats?.interface === VANILLA_INTERFACE ? '1.12' : stats?.interface != null ? String(stats.interface) : 'Unknown', tone: wrongClient ? 'danger' : undefined });
		if (missing.length && !sameName && !forkParent) notes.push({ label: 'Missing', value: missing.join(', '), tone: 'warning' });
		if (sameName) notes.push({ label: 'Page', value: sameName.name });
		if (item.group_key && (!wikiMain || wikiMain !== sameName)) notes.push({ label: 'Wiki version', value: wikiMain?.name ?? `${item.group_key} (not live)` });
		if (forkParent || stats?.fork_of) notes.push({
			label: 'Fork of', value: forkParent?.name ?? stats!.fork_of!,
			href: forkParent ? resolve('/addon/[slug]', {slug: forkParent.slug}) : `https://${stats!.fork_of!}`
		});
		if (similar) notes.push({ label: 'Similar name', value: similar.name, tone: 'warning', href: resolve('/addon/[slug]', {slug: similar.slug}) });
		if ((queuedNames.get(name) ?? 0) > 1) notes.push({ label: 'Queue', value: 'Same name twice', tone: 'warning' });
		if (movedTo) notes.push({ label: 'Moved to', value: movedTo });
		if (item.parent) notes.push({ label: 'Extends', value: item.parent });
		if (item.alts.length) notes.push({ label: 'Wiki versions', value: String(item.alts.length) });
		if (item.problem) notes.push({ label: 'Publish failed', value: item.problem, tone: 'danger' });

		if (stats?.missing) return { verdict: 'problem', advice: 'Dead link', notes, match };
		if (renamedLive) return { verdict: 'duplicate', advice: `Already live · ${renamedLive.name}`, notes };
		if (stats?.archived) return { verdict: 'problem', advice: 'Archived', notes, match };
		if (wrongClient) return { verdict: 'problem', advice: 'Wrong client', notes, match };
		if (sameName) return { verdict: 'fine', advice: 'Add to existing page', notes, match: sameName };
		if (forkParent) return { verdict: 'fine', advice: 'Fork · existing page', notes, match: forkParent };
		if (confirmedMatch) return { verdict: 'duplicate', advice: 'Possible version', notes, match };
		if (similar) return { verdict: 'duplicate', advice: 'Similar name · check match', notes, match: similar };
		if (missing.length) return { verdict: 'incomplete', advice: 'Incomplete', notes };
		return { verdict: 'fine', advice: 'Ready', notes };
	}

	const reviewed = $derived(imports.items.map((item) => ({ item, ...review(item) })));
	const totals = $derived(Object.groupBy(reviewed, (r) => r.verdict));

	const matches = (item: QueueItem) => {
		const words = query.toLowerCase().split(/\s+/).filter(Boolean);
		const haystack = `${item.name} ${item.description} ${item.url} ${item.category}`.toLowerCase();
		return words.every((w) => haystack.includes(w));
	};
	const incomplete = $derived(totals.incomplete?.length ?? 0);
	const visible = $derived(
		reviewed.filter(
			({ item, verdict }) =>
				(view === 'all' || verdict === view) && matches(item)
		)
	);
	const visibleRejected = $derived(imports.rejected.filter(matches));
	const total = $derived(view === 'rejected' ? visibleRejected.length : visible.length);
	const page = $derived(visible.slice(0, shown));
	const pageRejected = $derived(visibleRejected.slice(0, shown));
	const onPage = $derived(view === 'rejected' ? pageRejected.length : page.length);

	function show(next: View) {
		view = next;
		shown = PAGE;
		current = 0;
	}

	// Entries leave the list the moment they are decided, so several can be handled in a row
	// without waiting.
	// A decision that worked says nothing: the entry leaving the list is the confirmation.
	// What an action does report stays until the next one.
	async function run(action: () => Promise<string>) {
		error = '';
		notice = '';
		try {
			notice = await action();
		} catch (e) {
			error = (e as Error).message;
		}
	}

	const restoreOne = (item: QueueItem) =>
		run(async () => {
			await restore([item.id]);
			return '';
		});

	// The shortcuts act on the highlighted entry through its own buttons and fields, so
	// they publish what its fields say at that moment.
	const within = (what: string) => document.querySelector<HTMLElement>(`[data-entry="${current}"] [data-act="${what}"]`);

	function move(by: number) {
		current = Math.max(0, Math.min(onPage - 1, current + by));
		document.querySelector(`[data-entry="${current}"]`)?.scrollIntoView({ block: 'nearest' });
	}

	function shortcut(event: KeyboardEvent) {
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, dialog')) return;
		const key = event.key.toLowerCase();
		if (key === 'j' || key === 'arrowdown') move(1);
		else if (key === 'k' || key === 'arrowup') move(-1);
		else if (view === 'rejected') {
			const item = pageRejected[current];
			if (!item || key !== 'u') return;
			restoreOne(item);
		} else {
			if (key === 'a') within('approve')?.click();
			else if (key === 'r') within('reject')?.click();
			else if (key === 'e') within('name')?.focus();
			else if (key === 'v') within('version')?.click();
			else return;
		}
		event.preventDefault();
	}

	// A decided entry leaves the list, so the highlight may point past the end.
	$effect(() => {
		if (current > Math.max(0, onPage - 1)) current = Math.max(0, onPage - 1);
	});
</script>

<svelte:head>
	<title>Import · {SITE_NAME}</title>
</svelte:head>

<svelte:window onkeydown={auth.isAdmin ? shortcut : undefined} />

{#snippet entry(item: QueueItem, index: number, body: import('svelte').Snippet)}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div
		data-entry={index}
		class={[
			'border-b border-l-2 border-border px-3 py-2 last:border-b-0',
			index === current ? 'border-l-accent bg-raised' : 'border-l-transparent'
		]}
		onclick={() => (current = index)}
	>
		<div class="flex flex-wrap items-baseline gap-x-3">
			<span class="font-bold">{item.name}</span>
			<span class="text-sm text-muted">{item.category}</span>
		</div>
		<p class="break-words text-muted">{item.description || 'No description on the wiki.'}</p>
		<a
			href={item.url}
			target="_blank"
			rel="noopener nofollow"
			class="break-all text-accent/80 hover:text-accent hover:underline"
		>
			{item.url}
		</a>
		{@render body()}
	</div>
{/snippet}

{#if !auth.ready}
	<p class="py-12 text-center text-muted">Loading…</p>
{:else if !auth.isAdmin}
	<div class="panel mx-auto mt-8 max-w-sm p-5 text-center">
		<p class="text-muted">Only admins can review imports.</p>
	</div>
{:else}
	<div class="grid items-start gap-4 md:grid-cols-[13rem_minmax(0,1fr)]">
		<aside class="space-y-2">
			<div class="panel">
				<div class="border-b border-border px-3 py-3">
					<h1 class="text-2xl leading-tight font-bold">Import</h1>
					<p class="text-muted">From the {WIKI_NAME}</p>
				</div>
				<dl>
					{#each [['Waiting', imports.counts.pending], ['Published', imports.counts.approved], ['Submitted by users', imports.counts.submitted], ['Rejected', imports.counts.rejected]] as [label, value] (label)}
						<div class="flex justify-between border-b border-border px-3 py-1.5 last:border-b-0">
							<dt class="text-muted">{label}</dt>
							<dd>{value}</dd>
						</div>
					{/each}
				</dl>
			</div>

			{#snippet choice(value: View, label: string, count: number)}
				<button
					class={[
						'flex w-full cursor-pointer justify-between border-l-2 px-3 py-1 text-left transition-colors duration-100 hover:bg-raised',
						view === value ? 'border-accent text-accent' : 'border-transparent'
					]}
					aria-pressed={view === value}
					onclick={() => show(value)}
				>
					<span>{label}</span>
					<span class="text-sm leading-7 text-muted">{count}</span>
				</button>
			{/snippet}

			<div class="panel py-1">
				<h2 class="label px-3 pt-2">Waiting</h2>
				{#each Object.entries(FILTERS) as [value, label] (value)}
					{@render choice(
						value as View,
						label,
						value === 'all' ? reviewed.length : (totals[value as Verdict]?.length ?? 0)
					)}
				{/each}
				{@render choice('incomplete', 'Needs review', incomplete)}
				<h2 class="label mt-2 border-t border-border px-3 pt-3">Decided</h2>
				{@render choice('rejected', 'Rejected', imports.counts.rejected)}
			</div>

			<div class="panel px-3 py-2 text-sm text-muted">
				<h2 class="label">Keys</h2>
				<p>J / K or ↓ / ↑ to move</p>
				{#if view === 'rejected'}
					<p>U to put back in the queue</p>
				{:else}
					<p>A approve · E edit the name</p>
					<p>V approve as a version · R reject</p>
					<p>Ctrl+Enter approves from a field</p>
				{/if}
			</div>
		</aside>

		<section>
			<input
				class="input"
				type="search"
				placeholder={view === 'rejected' ? 'Search the rejected entries' : 'Search the queue'}
				aria-label="Search"
				bind:value={query}
				oninput={() => {
					shown = PAGE;
					current = 0;
				}}
			/>

			<div aria-live="polite">
				{#if error || notice}
					<p class={['mt-2 break-words', error ? 'text-danger' : 'text-accent']}>{error || notice}</p>
				{/if}
			</div>

			<div class="panel mt-2">
				{#if view === 'rejected'}
					{#if !imports.rejectedLoaded}
						<p class="px-3 py-8 text-center text-muted">Loading the rejected entries…</p>
					{:else if !pageRejected.length}
						<p class="px-3 py-8 text-center text-muted">
							{imports.rejected.length ? 'No rejected entry matches.' : 'Nothing has been rejected.'}
						</p>
					{:else}
						{#each pageRejected as item, index (item.id)}
							{#snippet body()}
								<div class="mt-1.5">
									<button class="btn py-1" onclick={() => restoreOne(item)}>Put back in the queue</button>
								</div>
							{/snippet}
							{@render entry(item, index, body)}
						{/each}
					{/if}
				{:else if !imports.loaded}
					<p class="px-3 py-8 text-center text-muted">Loading the queue…</p>
				{:else if !page.length}
					<p class="px-3 py-8 text-center text-muted">
						{imports.items.length
							? 'Nothing in the queue matches.'
							: 'The queue is empty. New addons on the wiki are added every night.'}
					</p>
				{:else}
					{#each page as { item, verdict, advice, notes, match, forkMatch }, index (item.id)}
						<ImportEntry
							{item}
							{index}
							{verdict}
							{advice}
							{notes}
							{match}
							{forkMatch}
							{run}
							selected={index === current}
							onselect={() => (current = index)}
						/>
					{/each}
				{/if}
			</div>

			{#if total > shown}
				<button class="btn mt-2 w-full" onclick={() => (shown += PAGE)}>
					Show {Math.min(PAGE, total - shown)} more of {total}
				</button>
			{/if}
		</section>
	</div>
{/if}
