<script lang="ts">
	import { resolve } from '$app/paths';
	import {
		ACTION_TEXT,
		LOG_PAGE,
		loadLog,
		loadTrashIds,
		remembered,
		requeueImport,
		restoreAddon,
		revertEdit,
		unapproveImport,
		unbanByName,
		undoGrouping,
		type LogEntry
	} from '#lib/admin.ts';
	import { deleteAddon, loadAddons, store } from '#lib/addons.svelte.ts';
	import UserLink from '#lib/components/UserLink.svelte';
	import { SITE_NAME } from '#lib/config.ts';
	import { ask } from '#lib/confirm.svelte.ts';
	import type { Addon } from '#lib/types.ts';

	const GROUPS = {
		all: 'Everything',
		addon: 'Addons',
		group: 'Groups',
		import: 'Imports',
		report: 'Reports',
		user: 'Accounts',
		trash: 'Trash'
	} as const;
	type Group = keyof typeof GROUPS;

	let entries = $state<LogEntry[]>(remembered.log ?? []);
	let loaded = $state(Boolean(remembered.log));
	// False once a page comes back short: there is nothing older.
	let more = $state(true);
	let group = $state<Group>('all');
	let query = $state('');
	let notice = $state('');
	let error = $state('');
	// What is still in the trash, so "Restore" is only offered for what can be restored.
	let inTrash = $state(new Set<number>());

	async function load(older = false) {
		try {
			const [next, trash] = await Promise.all([loadLog(older ? entries.at(-1)?.id : undefined), loadTrashIds()]);
			entries = older ? [...entries, ...next] : next;
			inTrash = trash;
			remembered.log = entries;
			more = next.length === LOG_PAGE;
			loaded = true;
		} catch (e) {
			error = (e as Error).message;
		}
	}
	load();

	const visible = $derived.by(() => {
		const words = query.toLowerCase().split(/\s+/).filter(Boolean);
		return entries.filter((e) => {
			if (group !== 'all' && !e.action.startsWith(`${group}.`)) return false;
			const haystack = `${e.actor_name ?? ''} ${e.subject ?? ''} ${e.action}`.toLowerCase();
			return words.every((w) => haystack.includes(w));
		});
	});

	const when = (iso: string) =>
		new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	const live = (id: number | null) => store.addons.find((a) => a.id === id);
	const shown = (value: unknown) =>
		typeof value === 'string' ? value || '(empty)' : JSON.stringify(value, null, 1);

	// A ban can be lifted, and a rejected import put back, only from the newest line about
	// that account or link: an older one has been overtaken by what came after.
	const newest = $derived.by(() => {
		const seen = new Set<string>();
		const ids = new Set<number>();
		for (const e of entries) {
			const about = e.action.startsWith('user.')
				? `user ${e.subject}`
				: e.action.startsWith('import.') && e.details?.url
					? `import ${e.details.url}`
					: '';
			if (about && !seen.has(about)) {
				seen.add(about);
				ids.add(e.id);
			}
		}
		return ids;
	});

	// Group changes that a later line already undid.
	const undone = $derived(new Set(entries.map((e) => (e.action === 'group.undo' ? e.details?.undid : undefined))));

	interface Undo {
		label: string;
		danger?: boolean;
		// The prompt before it happens.
		title: string;
		body: string;
		run: () => Promise<unknown>;
		// What the page says once it is done.
		done: string;
	}

	// How each kind of line is undone, for as long as undoing it still makes sense.
	function undos(entry: LogEntry, addon: Addon | undefined): Undo[] {
		const name = entry.subject ?? 'this addon';
		const remove: Undo | null = addon
			? {
					label: 'Delete',
					danger: true,
					title: `Delete "${addon.name}"?`,
					body: 'It goes to the trash, where it can be restored for 90 days.',
					run: () => deleteAddon(addon.id),
					done: `"${addon.name}" is in the trash.`
				}
			: null;

		switch (entry.action) {
			case 'addon.update':
			case 'addon.revert':
				return addon && entry.details?.before
					? [
							{
								label: 'Revert',
								title: `Put "${name}" back to how it was before this edit?`,
								body: 'The whole entry goes back to that point, so any edits made after this one are undone as well. Reverting is logged and can itself be reverted.',
								run: () => revertEdit(entry.id),
								done: `"${name}" is back to how it was before that edit.`
							}
						]
					: [];
			case 'addon.create':
			case 'addon.restore':
				return remove ? [remove] : [];
			case 'import.approve':
				return addon && remove
					? [
							{
								label: 'Back to the queue',
								danger: true,
								title: `Send "${addon.name}" back to the import queue?`,
								body: 'The addon goes to the trash and its entry waits for review again.',
								run: () => unapproveImport(addon.id),
								done: `"${addon.name}" is back in the import queue.`
							},
							remove
						]
					: [];
			case 'addon.delete': {
				const trashId = entry.details?.trash_id;
				return trashId !== undefined && inTrash.has(trashId)
					? [
							{
								label: 'Restore',
								title: `Restore "${name}"?`,
								body: 'It comes back as it was, to whoever posted it, and returns to its group.',
								run: () => restoreAddon(trashId),
								done: `Restored "${name}".`
							}
						]
					: [];
			}
			case 'group.add':
			case 'group.remove':
			case 'group.main':
			case 'group.undo':
				return entry.details?.groups_before?.length && !undone.has(entry.id)
					? [
							{
								label: 'Undo',
								title: 'Undo this group change?',
								body: 'The addons involved go back to how they were grouped before it. Nothing is deleted.',
								run: () => undoGrouping(entry.id),
								done: 'The group change is undone.'
							}
						]
					: [];
			case 'user.ban':
				return entry.subject && newest.has(entry.id)
					? [
							{
								label: 'Lift the ban',
								title: `Lift the ban on ${entry.subject}?`,
								body: 'They will be able to post and edit again.',
								run: () => unbanByName(entry.subject!),
								done: `${entry.subject} can post again.`
							}
						]
					: [];
			case 'import.reject': {
				const url = entry.details?.url;
				return url && newest.has(entry.id)
					? [
							{
								label: 'Put back in the queue',
								title: `Put "${name}" back in the import queue?`,
								body: 'It waits for review again.',
								run: () => requeueImport(url),
								done: `"${name}" is back in the import queue.`
							}
						]
					: [];
			}
			default:
				return [];
		}
	}

	async function undo(action: Undo) {
		const confirmed = await ask({ title: action.title, body: action.body, action: action.label, danger: action.danger });
		if (!confirmed) return;
		error = notice = '';
		try {
			const result = await action.run();
			await Promise.all([loadAddons(), load()]);
			// The two lookups by name or link answer false when there was nothing left to undo.
			notice = result === false ? 'That had already been undone.' : action.done;
		} catch (e) {
			error = (e as Error).message;
		}
	}
</script>

<svelte:head>
	<title>Log · {SITE_NAME}</title>
</svelte:head>

<div class="flex flex-wrap gap-2">
	<input
		class="input flex-1 basis-full sm:min-w-48 sm:basis-0"
		type="search"
		placeholder="Search by person or addon"
		aria-label="Search the log"
		bind:value={query}
	/>
	<select class="input w-auto flex-1 sm:w-44 sm:flex-none" aria-label="Kind of action" bind:value={group}>
		{#each Object.entries(GROUPS) as [value, label] (value)}
			<option {value}>{label}</option>
		{/each}
	</select>
</div>

<div aria-live="polite">
	{#if error || notice}
		<p class={['mt-2 break-words', error ? 'text-danger' : 'text-accent']}>{error || notice}</p>
	{/if}
</div>

<div class="panel mt-2">
	{#if !loaded}
		<p class="px-3 py-8 text-center text-muted">Loading the log…</p>
	{:else if !visible.length}
		<p class="px-3 py-8 text-center text-muted">
			{entries.length ? 'No line matches.' : 'Nothing has been logged yet.'}
		</p>
	{:else}
		{#each visible as entry (entry.id)}
			{@const addon = live(entry.addon_id)}
			{@const actions = undos(entry, addon)}
			<div class="border-b border-border px-3 py-2 last:border-b-0">
				<div class="flex flex-wrap items-baseline gap-x-3">
					<p class="min-w-0 flex-1 break-words">
						<UserLink name={entry.actor_name} fallback="The system" class="font-bold" />
						<span class={entry.action.startsWith('user.') || entry.action === 'addon.delete' || entry.action === 'trash.purge' ? 'text-danger' : 'text-muted'}>
							{ACTION_TEXT[entry.action] ?? entry.action}
						</span>
						{#if entry.action === 'user.autosuspend'}
							{entry.details?.reason}
						{:else if addon}
							<a href={resolve('/addon/[slug]', { slug: addon.slug })} class="text-accent hover:underline">
								{entry.subject}
							</a>
						{:else if entry.action.startsWith('user.')}
							<UserLink name={entry.subject} />
						{:else}
							{entry.subject}
						{/if}
						{#if entry.action === 'group.decline' && entry.details?.target}
							<span class="text-muted">with</span> {entry.details.target}
						{/if}
						{#if entry.details?.trashed}<span class="text-muted">and trashed their addons</span>{/if}
					</p>
					<!-- The way back, on the line itself. Gone once it no longer applies. -->
					{#each actions as action (action.label)}
						<button
							class={['btn shrink-0 px-2 py-0.5 text-sm', action.danger && 'btn-danger']}
							onclick={() => undo(action)}
						>
							{action.label}
						</button>
					{/each}
					<span class="shrink-0 text-sm text-muted">{when(entry.at)}</span>
				</div>

				{#if entry.action === 'trash.purge' && entry.details?.names && entry.details.names.length > 1}
					<p class="mt-1 text-sm break-words text-muted">{entry.details.names.join(', ')}</p>
				{/if}

				{#if entry.details?.changed && entry.details.before}
					{@const before = entry.details.before}
					{@const after = entry.details.after}
					<details class="mt-1 text-sm">
						<summary class="cursor-pointer text-muted hover:text-fg">
							Changed {entry.details.changed.join(', ')}. Show what changed.
						</summary>
						{#each entry.details.changed as field (field)}
							<div class="mt-2">
								<h3 class="label">{field}</h3>
								<div class="grid gap-2 sm:grid-cols-2">
									<div class="border border-border p-2">
										<p class="label text-danger">Before</p>
										<p class="max-h-40 overflow-y-auto break-words whitespace-pre-wrap">{shown(before[field])}</p>
									</div>
									<div class="border border-border p-2">
										<p class="label text-accent">After</p>
										<p class="max-h-40 overflow-y-auto break-words whitespace-pre-wrap">
											{after ? shown(after[field]) : 'Not recorded for this line.'}
										</p>
									</div>
								</div>
							</div>
						{/each}
					</details>
				{/if}
			</div>
		{/each}
	{/if}
</div>

{#if loaded && more}
	<button class="btn mt-2 w-full" onclick={() => load(true)}>Show older lines</button>
{/if}
