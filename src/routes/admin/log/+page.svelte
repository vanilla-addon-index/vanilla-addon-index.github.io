<script lang="ts">
	import { resolve } from '$app/paths';
	import { ACTION_TEXT, LOG_PAGE, loadLog, remembered, revertEdit, type LogEntry } from '#lib/admin.ts';
	import { loadAddons, store } from '#lib/addons.svelte.ts';
	import UserLink from '#lib/components/UserLink.svelte';
	import { SITE_NAME } from '#lib/config.ts';
	import { ask } from '#lib/confirm.svelte.ts';

	const GROUPS = { all: 'Everything', addon: 'Addons', group: 'Groups', import: 'Imports', user: 'Accounts' } as const;
	type Group = keyof typeof GROUPS;

	let entries = $state<LogEntry[]>(remembered.log ?? []);
	let loaded = $state(Boolean(remembered.log));
	// False once a page comes back short: there is nothing older.
	let more = $state(true);
	let group = $state<Group>('all');
	let query = $state('');
	let notice = $state('');
	let error = $state('');

	async function load(older = false) {
		try {
			const next = await loadLog(older ? entries.at(-1)?.id : undefined);
			entries = older ? [...entries, ...next] : next;
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

	async function revert(entry: LogEntry) {
		const confirmed = await ask({
			title: `Revert this edit of "${entry.subject}"?`,
			body: 'The changed fields go back to what is shown under "Before".',
			action: 'Revert'
		});
		if (!confirmed) return;
		error = notice = '';
		try {
			await revertEdit(entry.id);
			await Promise.all([loadAddons(), load()]);
			notice = `"${entry.subject}" is back to how it was before that edit.`;
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

<p class={['mt-2 min-h-[1lh] truncate', error ? 'text-danger' : 'text-accent']} aria-live="polite">
	{error || notice}
</p>

<div class="panel mt-1">
	{#if !loaded}
		<p class="px-3 py-8 text-center text-muted">Loading the log…</p>
	{:else if !visible.length}
		<p class="px-3 py-8 text-center text-muted">
			{entries.length ? 'No line matches.' : 'Nothing has been logged yet.'}
		</p>
	{:else}
		{#each visible as entry (entry.id)}
			{@const addon = live(entry.addon_id)}
			<div class="border-b border-border px-3 py-2 last:border-b-0">
				<div class="flex flex-wrap items-baseline gap-x-3">
					<p class="min-w-0 flex-1 break-words">
						<UserLink name={entry.actor_name} fallback="The system" class="font-bold" />
						<span class={entry.action.startsWith('user.') || entry.action === 'addon.delete' ? 'text-danger' : 'text-muted'}>
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
						{#if entry.details?.trashed}<span class="text-muted">and trashed their addons</span>{/if}
					</p>
					<span class="shrink-0 text-sm text-muted">{when(entry.at)}</span>
				</div>

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
						{#if addon}
							<button class="btn mt-2 py-1" onclick={() => revert(entry)}>Revert to "Before"</button>
						{/if}
					</details>
				{/if}
			</div>
		{/each}
	{/if}
</div>

{#if loaded && more}
	<button class="btn mt-2 w-full" onclick={() => load(true)}>Show older lines</button>
{/if}
