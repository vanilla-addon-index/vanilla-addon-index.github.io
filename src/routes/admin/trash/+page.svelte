<script lang="ts">
	import AdminToolbar from '#lib/components/AdminToolbar.svelte';
	import AdminSidebarContent from '#lib/components/AdminSidebarContent.svelte';
	import AdminNavigation from '#lib/components/AdminNavigation.svelte';
	import { resolve } from '$app/paths';
	import { TRASH_DAYS, loadTrash, purgeTrash, remembered, restoreAddon, type TrashEntry } from '#lib/admin.ts';
	import { loadAddons } from '#lib/addons.svelte.ts';
	import { auth } from '#lib/auth.svelte.ts';
	import UserLink from '#lib/components/UserLink.svelte';
	import { SITE_NAME } from '#lib/config.ts';
	import { ask } from '#lib/confirm.svelte.ts';

	const REASONS: Record<TrashEntry['reason'], string> = {
		delete: 'Deleted',
		merge: 'Merged into another addon',
		ban: 'Trashed when its poster was banned'
	};
	const DAY = 24 * 60 * 60 * 1000;

	let entries = $state<TrashEntry[]>(remembered.trash ?? []);
	let loaded = $state(Boolean(remembered.trash));
	// Remembered only once it has really been loaded, so an empty list is never shown early.
	$effect(() => {
		if (loaded) remembered.trash = entries;
	});
	let query = $state('');
	let notice = $state('');
	// Address of the addon the last restore brought back, for the link in the notice.
	let restored = $state('');
	let error = $state('');

	loadTrash()
		.then((rows) => {
			entries = rows;
			loaded = true;
		})
		.catch((e) => (error = e.message));

	const visible = $derived(
		entries.filter((e) => `${e.name} ${e.deleted_by_name ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
	);

	const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
	const daysLeft = (iso: string) =>
		// Clamped: this computer's clock can be slightly behind the database's.
		Math.max(0, TRASH_DAYS - Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / DAY)));

	async function restore(entry: TrashEntry) {
		error = notice = restored = '';
		try {
			const slug = await restoreAddon(entry.id);
			entries = entries.filter((e) => e.id !== entry.id);
			await loadAddons();
			restored = slug;
			notice = `Restored "${entry.name}".`;
		} catch (e) {
			error = (e as Error).message;
		}
	}

	async function purge(ids: number[], question: string) {
		const confirmed = await ask({
			title: question,
			body: 'This cannot be undone.',
			action: 'Delete forever',
			danger: true
		});
		if (!confirmed) return;
		error = notice = restored = '';
		try {
			const gone = await purgeTrash(ids);
			entries = entries.filter((e) => !ids.includes(e.id));
			notice = `Removed ${gone} for good.`;
		} catch (e) {
			error = (e as Error).message;
		}
	}
</script>

<svelte:head>
	<title>Trash · {SITE_NAME}</title>
</svelte:head>

<AdminToolbar>
<AdminSidebarContent>
	<div class="panel p-3"><h1 class="text-2xl font-bold">Trash</h1><p class="text-muted">Recover removed addons.</p></div>
	<dl class="panel space-y-2 p-3 text-sm">
		<div class="flex justify-between gap-2"><dt class="text-muted">Stored entries</dt><dd>{loaded ? entries.length : '…'}</dd></div>
		<div class="flex justify-between gap-2"><dt class="text-muted">Matching entries</dt><dd>{loaded ? visible.length : '…'}</dd></div>
		<div class="flex justify-between gap-2"><dt class="text-muted">Retention</dt><dd>{TRASH_DAYS} days</dd></div>
	</dl>
	<p class="panel p-3 text-sm text-muted">Restore an addon to recover its saved details. Permanent deletion cannot be undone.</p>
	{#if auth.isOwner && entries.length}
		<button class="btn btn-danger w-full" onclick={() => purge(entries.map(entry => entry.id), `Remove all ${entries.length} trashed addons for good?`)}>Empty the trash</button>
	{/if}
</AdminSidebarContent>
<div class="flex flex-wrap gap-2">
	<input
		class="input flex-1 basis-full sm:min-w-48 sm:basis-0"
		type="search"
		placeholder="Search the trash"
		aria-label="Search the trash"
		bind:value={query}
	/>
</div>

<AdminNavigation />
</AdminToolbar>

<div aria-live="polite">
{#if error || notice || restored}
<p class={['mb-2 truncate', error ? 'text-danger' : 'text-accent']}>
	{error || notice}
	{#if restored}
		<a href={resolve('/addon/[slug]', { slug: restored })} class="underline">Open it</a>
	{/if}
</p>
{/if}
</div>

<div class="panel">
	{#if !loaded}
		<p class="px-3 py-8 text-center text-muted">Loading the trash…</p>
	{:else if !visible.length}
		<p class="px-3 py-8 text-center text-muted">
			{entries.length
				? 'Nothing in the trash matches.'
				: `The trash is empty. Deleted addons stay here for ${TRASH_DAYS} days.`}
		</p>
	{:else}
		{#each visible as entry (entry.id)}
			<div class="border-b border-border px-3 py-2 last:border-b-0">
				<div class="flex flex-wrap items-baseline gap-x-3">
					<span class="font-bold">{entry.name}</span>
					<span class="text-sm text-muted">{entry.addon.category}</span>
					<span class="ml-auto text-sm text-muted">{daysLeft(entry.deleted_at)} days left</span>
				</div>
				<!-- What happened to it, set apart from the addon's own content below. -->
				<p class="label mt-1 mb-1 text-danger/90">
					{REASONS[entry.reason]} by <UserLink name={entry.deleted_by_name} fallback="an unknown account" /> · {date(entry.deleted_at)}
				</p>
				<p class="line-clamp-2 break-words">{entry.addon.description || 'No description.'}</p>
				<p class="text-sm text-muted">
					{entry.addon.images.length} screenshot{entry.addon.images.length === 1 ? '' : 's'}
				</p>
				{#each entry.addon.versions as version (version.url)}
					<a
						href={version.url}
						target="_blank"
						rel="noopener nofollow"
						class="block break-all text-accent/80 hover:text-accent hover:underline"
					>
						{version.url}
					</a>
				{/each}
				<div class="mt-1.5 flex flex-wrap gap-2">
					<button class="btn btn-primary py-1" onclick={() => restore(entry)}>Restore</button>
					{#if auth.isOwner}
						<button
							class="btn btn-danger py-1"
							onclick={() => purge([entry.id], `Remove "${entry.name}" for good?`)}
						>
							Delete forever
						</button>
					{/if}
				</div>
			</div>
		{/each}
	{/if}
</div>
