<script lang="ts">
	import { store } from '#lib/addons.svelte.ts';
	import { auth } from '#lib/auth.svelte.ts';
	import ImportEntry from '#lib/components/ImportEntry.svelte';
	import { SITE_NAME } from '#lib/config.ts';
	import { imports, loadQueue, loadRejected, restore, type QueueItem } from '#lib/imports.svelte.ts';
	import { linkKey } from '#lib/links.ts';
	import type { Addon } from '#lib/types.ts';
	import { WIKI_NAME } from '#lib/wiki.ts';

	const FILTERS = {
		all: 'All',
		fine: 'Looks fine',
		duplicate: 'Possible duplicates',
		problem: 'Obsolete or dead'
	} as const;
	type Verdict = Exclude<keyof typeof FILTERS, 'all'>;
	// "rejected" is not a filter on the queue but a second list: what was turned down.
	type View = keyof typeof FILTERS | 'rejected';

	const STALE_YEARS = 5;
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
		notes: string[];
		// A live addon this entry probably belongs to.
		match?: Addon;
	}

	function review(item: QueueItem): Review {
		const notes: string[] = [];
		const stats = imports.stats[item.key];
		const name = plain(item.name);

		const sameName = liveByName.get(name);
		const forkParent = stats?.fork_of ? liveByKey.get(stats.fork_of) : undefined;
		const similar =
			sameName || name.length < 4
				? undefined
				: store.addons.find((a) => {
						const other = plain(a.name);
						return other.length >= 4 && (other.includes(name) || name.includes(other));
					});
		// The wiki lists it as another version of an addon that is already live.
		const wikiMain = item.group_key ? liveByKey.get(item.group_key) : undefined;
		const match = wikiMain ?? sameName ?? forkParent;

		// GitHub answers for a repository's old address with its current one.
		const movedTo = stats?.canonical && stats.canonical !== item.key ? stats.canonical : undefined;
		const renamedLive = movedTo ? liveByKey.get(movedTo) : undefined;

		if (item.group_key) {
			notes.push(
				wikiMain
					? `The wiki lists it as another version of "${wikiMain.name}". It has no name or description of its own there.`
					: `The wiki lists it as another version of ${item.group_key}, which is not live yet. They are grouped once both are.`
			);
		}
		if (sameName && sameName !== wikiMain) notes.push(`A live addon is already named "${sameName.name}".`);
		if (forkParent) notes.push(`Fork of ${stats!.fork_of}, which is live as "${forkParent.name}".`);
		else if (stats?.fork_of) notes.push(`Fork of ${stats.fork_of}.`);
		if (similar) notes.push(`Similar name to the live addon "${similar.name}".`);
		if ((queuedNames.get(name) ?? 0) > 1) notes.push('Another entry in this queue has the same name.');
		if (movedTo) notes.push(`The repository has moved to ${movedTo}.`);
		if (item.parent) notes.push(`Extension of ${item.parent}.`);
		if (item.alts.length) {
			notes.push(
				`${item.alts.length} other version${item.alts.length === 1 ? '' : 's'} on the wiki, queued separately and grouped with this one when published.`
			);
		}
		if (!item.key.startsWith('github.com/')) notes.push(`Hosted on ${item.key.split('/')[0]}, so there is no update date.`);

		const year = stats?.pushed_at ? new Date(stats.pushed_at).getFullYear() : undefined;
		const stale = year !== undefined && year <= new Date().getFullYear() - STALE_YEARS;
		if (stats && !stats.missing) {
			notes.push(`${stats.stars} star${stats.stars === 1 ? '' : 's'}${year ? `, last updated ${year}` : ''}.`);
		}
		const wrongClient = stats?.interface != null && stats.interface !== VANILLA_INTERFACE;
		if (stats?.interface === VANILLA_INTERFACE) notes.push('Its .toc file targets 1.12.');
		if (wrongClient) notes.push(`Its .toc file says interface ${stats!.interface}; 1.12 addons say ${VANILLA_INTERFACE}.`);
		if (item.problem) notes.push(`Could not be published: ${item.problem}`);

		if (stats?.missing) return { verdict: 'problem', advice: 'Dead link: the repository is gone.', notes, match };
		if (renamedLive) {
			return {
				verdict: 'duplicate',
				advice: `Already live as "${renamedLive.name}" under its new address. Reject this one.`,
				notes
			};
		}
		if (item.obsolete) return { verdict: 'problem', advice: 'Marked obsolete on the wiki.', notes, match };
		if (stats?.archived) return { verdict: 'problem', advice: 'Archived by its author.', notes, match };
		if (wrongClient) return { verdict: 'problem', advice: 'Probably not a 1.12 addon.', notes, match };
		if (match) return { verdict: 'duplicate', advice: `Probably a version of "${match.name}".`, notes, match };
		if (similar) return { verdict: 'duplicate', advice: 'Check against the similar addon first.', notes };
		if (stale) return { verdict: 'problem', advice: `Not updated since ${year}.`, notes };
		return { verdict: 'fine', advice: 'Looks fine.', notes };
	}

	const reviewed = $derived(imports.items.map((item) => ({ item, ...review(item) })));
	const totals = $derived(Object.groupBy(reviewed, (r) => r.verdict));

	const matches = (item: QueueItem) => {
		const words = query.toLowerCase().split(/\s+/).filter(Boolean);
		const haystack = `${item.name} ${item.description} ${item.url} ${item.category}`.toLowerCase();
		return words.every((w) => haystack.includes(w));
	};
	const visible = $derived(
		reviewed.filter(({ item, verdict }) => (view === 'all' || verdict === view) && matches(item))
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
					{#each [['Waiting', imports.counts.pending], ['Published', imports.counts.approved], ['Rejected', imports.counts.rejected]] as [label, value] (label)}
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
					{#each page as { item, verdict, advice, notes, match }, index (item.id)}
						<ImportEntry
							{item}
							{index}
							{verdict}
							{advice}
							{notes}
							{match}
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
