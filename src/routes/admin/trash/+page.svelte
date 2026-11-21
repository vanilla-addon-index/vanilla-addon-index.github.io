<script lang="ts">
	import { tick } from 'svelte';
	import AdminToolbar from '#lib/components/AdminToolbar.svelte';
	import AdminSidebarContent from '#lib/components/AdminSidebarContent.svelte';
	import AdminNavigation from '#lib/components/AdminNavigation.svelte';
	import ReviewQueueRow from '#lib/components/ReviewQueueRow.svelte';
	import { entryHref } from '#lib/entry-href.ts';
	import { TRASH_DAYS, loadTrash, purgeTrash, restoreAddon, type TrashEntry } from '#lib/admin.ts';
	import { store, loadAddons } from '#lib/addons.svelte.ts';
	import { auth } from '#lib/auth.svelte.ts';
	import UserLink from '#lib/components/UserLink.svelte';
	import { SITE_NAME } from '#lib/config.ts';
	import { ask } from '#lib/confirm.svelte.ts';

	const REASONS: Record<TrashEntry['reason'], string> = {
		delete: 'Deleted',
		merge: 'Merged into another addon',
		ban: 'Trashed when its poster was banned'
	};
	const REASON_BADGES: Record<TrashEntry['reason'], string> = {
		delete: 'Deleted', merge: 'Merged', ban: 'Account banned'
	};
	const DAY = 24 * 60 * 60 * 1000;

	let entries = $state<TrashEntry[]>([]);
	let selectedId = $state<number>();
	const selected = $derived(entries.find(entry => entry.id === selectedId) ?? entries[0]);
	let list = $state<HTMLDivElement>();
	let loaded = $state(false);
	let loading = $state(false);
	let working = $state(false);
	let total = $state(0);
	let matching = $state(0);
	let more = $state(false);
	let query = $state('');
	let notice = $state('');
	let restored = $state('');
	let error = $state('');
	let asked = 0;

	async function load(older = false, term = query.trim(), mine = ++asked) {
		if (mine !== asked) return;
		loading = true;
		error = '';
		try {
			const page = await loadTrash(term, older ? entries.at(-1) : undefined);
			if (mine !== asked) return;
			entries = older ? [...entries, ...page.items] : page.items;
			total = page.total;
			matching = page.matching;
			more = page.more;
			loaded = true;
		} catch (e) {
			if (mine === asked) error = (e as Error).message;
		} finally {
			if (mine === asked) loading = false;
		}
	}
	$effect(() => {
		const term = query.trim();
		const mine = ++asked;
		loaded = false;
		loading = true;
		entries = [];
		const timer = setTimeout(() => load(false, term, mine), 250);
		return () => clearTimeout(timer);
	});

	const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
	const daysLeft = (iso: string) =>
		// Clamped: this computer's clock can be slightly behind the database's.
		Math.max(0, TRASH_DAYS - Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / DAY)));

	async function removeEntry(entry: TrashEntry, request: number) {
		const index = entries.findIndex(row => row.id === entry.id);
		if (request !== asked || index < 0) {
			await load();
		} else {
			if (selected?.id === entry.id) selectedId = entries[index + 1]?.id ?? entries[index - 1]?.id;
			entries = entries.filter(row => row.id !== entry.id);
			total = Math.max(0, total - 1);
			matching = Math.max(0, matching - 1);
		}
		await tick();
		if (selected && document.activeElement === document.body) {
			list?.querySelector<HTMLElement>(`#trash-${selected.id} [data-act="review"]`)?.focus();
		}
	}

	async function restore(entry: TrashEntry) {
		if (working) return;
		working = true;
		error = notice = restored = '';
		const request = asked;
		try {
			const slug = await restoreAddon(entry.id);
			await Promise.all([loadAddons(), removeEntry(entry, request)]);
			restored = slug;
			notice = `Restored "${entry.name}".`;
		} catch (e) {
			error = (e as Error).message;
		} finally {
			working = false;
		}
	}

	async function purge(entry: TrashEntry) {
		if (working) return;
		working = true;
		try {
			const confirmed = await ask({
				title: `Remove "${entry.name}" for good?`,
				body: 'This cannot be undone.',
				action: 'Delete forever',
				danger: true
			});
			if (!confirmed) return;
			error = notice = restored = '';
			const request = asked;
			const gone = await purgeTrash([entry.id]);
			if (gone) await removeEntry(entry, request);
			else await load();
			notice = `Removed ${gone} for good.`;
		} catch (e) {
			error = (e as Error).message;
		} finally {
			working = false;
		}
	}
</script>

<svelte:head>
	<title>Trash · {SITE_NAME}</title>
</svelte:head>

<AdminSidebarContent>
	<div class="panel">
		<header class="border-b border-border px-3 py-2">
			<h1 class="text-2xl leading-tight font-bold">Trash</h1>
			<p class="text-sm text-muted">Recover removed addons.</p>
		</header>
		<dl class="space-y-1 px-3 py-2 text-sm">
			<div class="flex justify-between gap-2">
				<dt class="text-muted">Stored entries</dt><dd class="tabular-nums">{loaded ? total : '…'}</dd>
			</div>
			{#if query.trim()}
				<div class="flex justify-between gap-2">
					<dt class="text-muted">Matching entries</dt><dd class="tabular-nums">{loaded ? matching : '…'}</dd>
				</div>
			{/if}
			<div class="flex justify-between gap-2">
				<dt class="text-muted">Retention</dt><dd>{TRASH_DAYS} days</dd>
			</div>
		</dl>
	</div>
</AdminSidebarContent>

<AdminToolbar>
	<div class="flex flex-wrap gap-2">
		<input
			class="input flex-1 basis-full sm:min-w-48 sm:basis-0"
			type="search"
			placeholder="Search the trash"
			aria-label="Search the trash"
			bind:value={query}
		/>
		<button class="btn" disabled={loading || working} onclick={() => load()}>Refresh trash</button>
	</div>
	<AdminNavigation />
</AdminToolbar>

<div aria-live="polite">
	{#if error || notice || restored}
		<p class={['mb-2 break-words', error ? 'text-danger' : 'text-accent']}>
			{error || notice}
			{#if restored}
				<a href={entryHref(store.addons.find(a => a.slug === restored) ?? {slug: restored})} class="underline">Open it</a>
			{/if}
		</p>
	{/if}
</div>

<div class="panel" bind:this={list}>
	{#if !loaded}
		<p class="px-4 py-5 text-center text-muted">{loading ? 'Loading the trash…' : 'Unable to load the trash. Try refreshing.'}</p>
	{:else if !entries.length}
		<div class="px-4 py-5 text-center">
			{#if query.trim() && total}
				<h2 class="font-semibold">Nothing in the trash matches.</h2>
				<p class="mt-1 text-sm text-muted">Try a different addon name.</p>
			{:else}
				<h2 class="font-semibold">The trash is empty.</h2>
				<p class="mt-1 text-sm text-muted">Deleted addons stay here for {TRASH_DAYS} days.</p>
			{/if}
		</div>
	{:else}
		{#each entries as entry (entry.id)}
			{@const remaining = daysLeft(entry.deleted_at)}
			{@const screenshots = entry.addon.images.length}
			{@const links = entry.addon.versions.length}
			<ReviewQueueRow
				rowId={'trash-' + entry.id}
				title={entry.name}
				subtitle={(entry.deleted_by_name ?? 'Unknown account') + ' · ' + date(entry.deleted_at)}
				selected={selected?.id === entry.id}
				onselect={() => (selectedId = entry.id)}
			>
				{#snippet badges()}
					<span class="admin-badge border-danger/35 text-danger/90">{REASON_BADGES[entry.reason]}</span>
					<span class="admin-badge border-border text-muted tabular-nums">{remaining === 0 ? 'Expires today' : remaining === 1 ? '1 day left' : remaining + ' days left'}</span>
				{/snippet}
				{#if selected?.id === entry.id}
					<p class="text-sm text-muted">
						{REASONS[entry.reason]} by <UserLink name={entry.deleted_by_name} fallback="an unknown account" class={entry.deleted_by_name ? 'text-accent' : ''} />
					</p>
					<div class="mt-2 flex flex-wrap items-center gap-2" role="group" aria-label="Entry actions">
						<button class="btn btn-primary py-1" disabled={working || loading} onclick={() => restore(entry)}>Restore</button>
						{#if auth.isOwner}
							<button class="btn btn-danger py-1" disabled={working || loading} onclick={() => purge(entry)}>Delete forever</button>
						{/if}
					</div>
					<section class="mt-2 space-y-1.5 border-t border-border pt-2" aria-label="Entry details">
						<h3 class="text-sm font-semibold">Details</h3>
						<p class="whitespace-pre-line [overflow-wrap:anywhere]">{entry.addon.description || 'No description.'}</p>
						<p class="text-sm text-muted">
							{entry.addon.category} · {screenshots} {screenshots === 1 ? 'screenshot' : 'screenshots'}
						</p>
					</section>
					{#if links}
						<details class="mt-2 border-t border-border pt-2 text-sm">
							<summary class="cursor-pointer font-semibold hover:text-accent">Download links ({links})</summary>
							<ul class="mt-1.5 space-y-1">
								{#each entry.addon.versions as version (version.url)}
									<li><a href={version.url} target="_blank" rel="noopener nofollow" class="[overflow-wrap:anywhere] text-accent hover:underline">{version.url}</a></li>
								{/each}
							</ul>
						</details>
					{/if}
				{/if}
			</ReviewQueueRow>
		{/each}
	{/if}
</div>

{#if loaded}
	<p class="mt-2 text-sm text-muted" role="status">Showing {entries.length} of {matching} matching entries.</p>
	{#if more}<button class="btn mt-2 w-full" disabled={loading || working} onclick={() => load(true)}>{loading ? 'Loading…' : 'Load more entries'}</button>{/if}
{/if}
