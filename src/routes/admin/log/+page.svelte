<script lang="ts">
	import HistoryGrouping from '#lib/components/HistoryGrouping.svelte';
	import HistoryComparison from '#lib/components/HistoryComparison.svelte';
	import { fieldLabel, changeSummary } from '#lib/history.ts';
	import { recoveryComparison, type RecoveryComparison } from '#lib/admin.ts';
	import AdminToolbar from '#lib/components/AdminToolbar.svelte';
	import AdminSidebarContent from '#lib/components/AdminSidebarContent.svelte';
	import AdminNavigation from '#lib/components/AdminNavigation.svelte';
	import { goto } from '$app/navigation';
	import { tick } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		ACTION_TEXT,
		LOG_PAGE,
		loadLog,
		loadTrashIds,
		loadRecoveryStatus,
		type RecoveryStatus,
		remembered,
		requeueImport,
		reopenReport,
		restoreAddon,
		revertEdit,
		unapproveImport,
		unbanByName,
		undoGrouping,
		type LogEntry,
		type LogFilter
	} from '#lib/admin.ts';
	import { deleteAddon, loadAddons, store } from '#lib/addons.svelte.ts';
	import UserLink from '#lib/components/UserLink.svelte';
	import { SITE_NAME } from '#lib/config.ts';
	import { ask } from '#lib/confirm.svelte.ts';
	import { auth } from '#lib/auth.svelte.ts';
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

	// What the log is narrowed down to is in the address, so a view can be linked to: an
	// addon's history from its page, an account's actions from its profile.
	const filter = $derived.by<LogFilter>(() => {
		const params = page.url.searchParams;
		const entryId = Number(params.get('entry'));
		if (Number.isSafeInteger(entryId) && entryId > 0) return { entryId };
		const kind = params.get('kind') ?? '';
		return {
			kind: kind in GROUPS && kind !== 'all' ? kind : undefined,
			addonId: Number(params.get('addon')) || undefined,
			by: params.get('by') || undefined,
			recoveryId: params.get('recovery') || undefined,
			q: params.get('q') || undefined
		};
	});
	const filtered = $derived(Boolean(filter.entryId || filter.kind || filter.addonId || filter.by || filter.recoveryId || filter.q));

	function narrow(change: Record<string, string | undefined>) {
		const url = new URL(page.url.href);
		url.searchParams.delete('entry');
		url.hash = '';
		for (const [key, value] of Object.entries(change)) {
			if (value) url.searchParams.set(key, value);
			else url.searchParams.delete(key);
		}
		goto(url, { replace: true, reset: false });
	}

	// The unfiltered log is remembered between visits to the tab; a narrowed one is fetched.
	const start = page.url.search ? undefined : remembered.log;
	let entries = $state<LogEntry[]>(start ?? []);
	let loaded = $state(Boolean(start));
	// False once a page comes back short: there is nothing older.
	let more = $state(true);
	// What is in the search box. It reaches the address, and so the database, once typing pauses.
	let query = $state(page.url.searchParams.get('q') ?? '');
	let typing: ReturnType<typeof setTimeout>;
	function search() {
		clearTimeout(typing);
		typing = setTimeout(() => narrow({ q: query.trim() || undefined }), 300);
	}
	let outcomes = $state<Record<number, { text: string; failed: boolean }>>({});
	let active = $state<number | null>(null);
	let loading = $state(false);
	let recoveries = $state<Record<number, RecoveryStatus>>({});
	let error = $state('');
	// What is still in the trash, so "Restore" is only offered for what can be restored.
	let inTrash = $state(new Set<number>());

	// Counts the requests, so an answer that arrives after a newer question is dropped.
	let asked = 0;
	async function load(older = false) {
		const mine = ++asked;
		const wanted = filter;
		loading = true;
		error = '';
		try {
			const next = await loadLog(wanted, older ? entries.at(-1)?.id : undefined);
			if (mine !== asked) return;
			const combined = older ? [...entries, ...next] : next;
			const [trash, status] = await Promise.all([
				loadTrashIds(combined.flatMap(entry => entry.details?.trash_id === undefined ? [] : [entry.details.trash_id])),
				loadRecoveryStatus(combined.map(entry => entry.id))
			]);
			if (mine !== asked) return;
			entries = combined;
			inTrash = trash;
			recoveries = status;
			if (!filtered) remembered.log = entries;
			more = next.length === LOG_PAGE;
			loaded = true;
			if (wanted.entryId) {
				await tick();
				if (mine !== asked) return;
				const row = document.getElementById(`log-${wanted.entryId}`);
				const comparison = row?.querySelector<HTMLDetailsElement>('details[data-comparison]');
				if (comparison?.open) {
					const entry = next.find(entry => entry.id === wanted.entryId);
					if (entry?.details?.changed) void inspect(entry);
				} else if (comparison) comparison.open = true;
				row?.focus({ preventScroll: true });
				row?.scrollIntoView({ block: 'start' });
			}

		} catch (e) {
			if (mine === asked) {
				error = (e as Error).message;
				recoveries = {};
			}
		} finally {
			if (mine === asked) loading = false;
		}
	}
	// Runs at once, and again whenever the log is narrowed differently.
	$effect(() => {
		void filter;
		load();
	});


	const when = (iso: string) =>
		new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	const live = (id: number | null) => store.addons.find((a) => a.id === id);
	// The addon whose history is shown, by the name it has now or had in its last line.
	const historyOf = $derived(
		filter.addonId ? (live(filter.addonId)?.name ?? entries.find((e) => e.subject)?.subject ?? 'this addon') : ''
	);
	let comparisons = $state<Record<number, RecoveryComparison>>({});
	let comparisonErrors = $state<Record<number, string>>({});
	async function inspect(entry: LogEntry) {
		try { comparisons[entry.id] = await recoveryComparison(entry.id); comparisonErrors[entry.id] = ''; }
		catch(e) { comparisonErrors[entry.id] = (e as Error).message; }
	}

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

	// Recovery status comes from the whole audit trail, independently of these entries.

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
		const recovery = recoveries[entry.id];
		if (['user.ban', 'import.reject'].includes(entry.action) && outcomes[entry.id] && !outcomes[entry.id].failed) return [];
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
				return addon && recovery?.available
					? [
							{
								label: 'Revert',
                                title: `Recover the changes to "${name}"?`,
                                body: 'Only the fields changed by this edit will be restored. Unrelated later edits are preserved. Conflicting changes will stop recovery.',
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
				return recovery?.available
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
			case 'report.handle':
			case 'report.dismiss':
				return auth.isOwner && recovery?.available ? [{
					label: 'Reopen report',
					title: `Reopen the report about "${name}"?`,
					body: 'The original report returns to the review queue. A later decision will be preserved.',
					run: () => reopenReport(entry.id),
					done: `The report about "${name}" is open again.`
				}] : [];
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

	// Refresh status without replacing or prepending any of the loaded log entries.
	async function refreshStatus() {
		const mine = asked;
		const current = entries;
		const [trash, status] = await Promise.all([
			loadTrashIds(current.flatMap(entry => entry.details?.trash_id === undefined ? [] : [entry.details.trash_id])),
			loadRecoveryStatus(current.map(entry => entry.id))
		]);
		if (mine !== asked) return;
		inTrash = trash;
		recoveries = status;
		await Promise.all(current.filter(entry => comparisons[entry.id]).map(entry => inspect(entry)));
	}

	async function undo(entry: LogEntry, action: Undo) {
		if (active !== null) return;
		active = entry.id;
		try {
			const confirmed = await ask({ title: action.title, body: action.body, action: action.label, danger: action.danger });
			if (!confirmed) return;
			const result = await action.run();
			const row = document.getElementById(`log-${entry.id}`);
			const top = row?.getBoundingClientRect().top;
			outcomes[entry.id] = {
				text: result === false ? 'That action has already been undone or superseded.' : action.done,
				failed: false
			};
			try {
				await loadAddons();
				await refreshStatus();
			} catch (e) {
				// The recovery succeeded even if its status could not be refreshed.
				recoveries = {};
				outcomes[entry.id].text += ` Status could not be refreshed: ${(e as Error).message}. Reload before continuing.`;
			}
			await tick();
			if (row?.isConnected && top !== undefined) window.scrollBy(0, row.getBoundingClientRect().top - top);
		} catch (e) {
			outcomes[entry.id] = { text: `Recovery failed: ${(e as Error).message}`, failed: true };
			// A concurrent recovery may have invalidated the confirmation.
			try { await refreshStatus(); } catch { recoveries = {}; }
		} finally {
			active = null;
		}
	}

</script>

<svelte:head>
	<title>Log · {SITE_NAME}</title>
</svelte:head>

<AdminToolbar>
<AdminSidebarContent>
	<div class="panel p-3"><h1 class="text-2xl font-bold">Log</h1><p class="text-muted">Activity and recovery.</p></div>
	<dl class="panel p-3"><div class="flex justify-between gap-2"><dt class="text-muted">Loaded entries</dt><dd>{loaded ? entries.length : '…'}</dd></div></dl>
	<div class="panel p-3">
	<label class="label" for="log-kind">Kind of action</label>
	<select id="log-kind" class="input" aria-label="Kind of action" value={filter.kind ?? 'all'} onchange={(event) => narrow({kind:event.currentTarget.value === 'all' ? undefined : event.currentTarget.value})}>
		{#each Object.entries(GROUPS) as [value,label]}<option {value}>{label}</option>{/each}
	</select>
	</div>
	<p class="panel p-3 text-sm text-muted">Search by person or addon. Expand an entry to inspect its changes and available undo actions.</p>
</AdminSidebarContent>
<div class="flex flex-wrap gap-2">
	<input
		class="input flex-1 basis-full sm:min-w-48 sm:basis-0"
		type="search"
		placeholder="Search by person or addon"
		aria-label="Search the log"
		bind:value={query}
		oninput={search}
	/>
</div>

<AdminNavigation />
</AdminToolbar>

{#if filter.entryId}
	<p class="mb-2">Log entry #{filter.entryId}
		<a class="ml-2 text-sm text-accent hover:underline" href={resolve('/admin/log')}>Show the whole log</a>
	</p>
{/if}

{#if filter.addonId || filter.by}
	<p class="mb-2">
		{#if filter.addonId}History of <span class="font-bold">{historyOf}</span>{/if}
		{#if filter.by}{filter.addonId ? ', by' : 'Everything done by'} <span class="font-bold">{filter.by}</span>{/if}
		<button
			class="ml-2 cursor-pointer text-sm text-muted hover:text-accent hover:underline"
			onclick={() => narrow({ addon: undefined, by: undefined })}
		>
			Show the whole log
		</button>
	</p>
{/if}

<div aria-live="polite">
	{#if error}
		<p class="mb-2 break-words text-danger">{error}</p>
	{/if}
</div>

<div class="panel">
	{#if !loaded}
		<p class="px-3 py-8 text-center text-muted">Loading the log…</p>
	{:else if !entries.length}
		<p class="px-3 py-8 text-center text-muted">
			{filter.entryId ? 'This log entry is unavailable or no longer exists.' : filtered ? 'No line matches.' : 'Nothing has been logged yet.'}
		</p>
	{:else}
		{#each entries as entry (entry.id)}
			{@const addon = live(entry.addon_id)}
			{@const actions = undos(entry, addon)}
			<div id={`log-${entry.id}`} tabindex="-1" class="border-b border-border px-3 py-2 last:border-b-0">
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
					<!-- Everything that ever happened to this addon, deleted or not. -->
					{#if entry.addon_id && !filter.addonId}
						<a
							href={resolve(`/admin/log?addon=${entry.addon_id}`)}
							class="btn shrink-0 px-2 py-0.5 text-sm"
						>
							History
						</a>
					{/if}
					<!-- The way back, on the line itself. Gone once it no longer applies. -->
					{#each actions as action (action.label)}
						<button
							class={['btn shrink-0 px-2 py-0.5 text-sm', action.danger && 'btn-danger']}
							disabled={active !== null || loading}
							onclick={() => undo(entry, action)}
						>
							{action.label}
						</button>
					{/each}

					{#if entry.details?.undid}<a class="shrink-0 text-sm text-accent hover:underline" href={resolve(`/admin/log?entry=${entry.details.undid}#log-${entry.details.undid}`)}>View original entry</a>{/if}
					<a class="shrink-0 text-sm text-muted hover:text-accent hover:underline" href={resolve(`/admin/log?entry=${entry.id}#log-${entry.id}`)}>Link to entry</a>
					<span class="shrink-0 text-sm text-muted">{when(entry.at)}</span>
				</div>

				{#if recoveries[entry.id]?.recovery_id}
					<a class="mt-1 block text-sm text-accent hover:underline" href={resolve(`/admin/log?entry=${recoveries[entry.id].recovery_id}#log-${recoveries[entry.id].recovery_id}`)}>
						Recovered by {recoveries[entry.id].actor_name ?? 'Deleted account'}
						{#if recoveries[entry.id].recovered_at}· {when(recoveries[entry.id].recovered_at!)}{/if}
					</a>
				{:else if recoveries[entry.id]?.reason}
					<p class="mt-1 text-sm text-muted">{recoveries[entry.id].reason}</p>
				{/if}
				{#if active === entry.id}<p class="mt-1 text-sm text-muted" role="status">Recovering…</p>{/if}
				{#if outcomes[entry.id]}
					<p class={['mt-1 text-sm break-words', outcomes[entry.id].failed ? 'text-danger' : 'text-accent']} role="status">{outcomes[entry.id].text}</p>
				{/if}

				{#if entry.action === 'user.rollback'}
					<p class="mt-1 text-sm text-muted">{entry.details?.steps ?? 0} changes rolled back; {entry.details?.skipped ?? 0} steps could not be undone.</p>
					{#each entry.details?.skipped_details ?? [] as miss, index (index)}
						<p class="mt-1 text-sm break-words text-danger">Cannot undo "{ACTION_TEXT[miss.action] ?? miss.action} {miss.subject}": {miss.why}</p>
					{/each}
					{#if entry.details?.skipped && !entry.details.skipped_details}
						<p class="mt-1 text-sm text-muted">Detailed failure reasons were not recorded for this older rollback.</p>
					{/if}
				{/if}

				{#if entry.action === 'trash.purge' && entry.details?.names && entry.details.names.length > 1}
					<p class="mt-1 text-sm break-words text-muted">{entry.details.names.join(', ')}</p>
				{/if}

				{#if entry.details?.groups_before?.length}
					<details data-comparison class="mt-2 text-sm"><summary class="cursor-pointer text-muted">View grouping changes</summary><HistoryGrouping {entry} addons={store.addons} /></details>
					{#if addon && recoveries[entry.id]?.reason}<a class="btn mt-2 text-sm" href={resolve('/addon/[slug]',{slug:addon.slug})}>Review current grouping</a>{/if}
				{/if}

				{#if entry.details?.changed && entry.details.before}
					<p class="mt-1 text-sm text-muted">{changeSummary(entry.details.changed,entry.details.before,entry.details.after)}</p>
					<details data-comparison class="mt-1 text-sm" ontoggle={event => { if(event.currentTarget.open) void inspect(entry); }}>
						<summary class="cursor-pointer text-muted hover:text-fg">View changes</summary>
						{#if comparisonErrors[entry.id]}<p class="text-danger">{comparisonErrors[entry.id]}</p>{/if}
						{#if !comparisons[entry.id]}<p class="text-muted">Loading current content…</p>{/if}
						<HistoryComparison {entry} comparison={comparisons[entry.id]} showSummary={false} />
					</details>
					{#if addon && !recoveries[entry.id]?.recovery_id}
						<a class="btn mt-2 text-sm" href={resolve(`/submit?edit=${addon.slug}&review=${entry.id}`)}>Edit current addon</a>
					{/if}
				{:else if entry.details?.changed}
					<!-- Older than 90 days: the line stays, the copy of the addon does not. -->
					<p class="mt-1 text-sm text-muted">
						Changed {entry.details.changed.map(fieldLabel).join(', ')}. What it looked like before is no longer kept.
					</p>
				{/if}
			</div>
		{/each}
	{/if}
</div>

{#if loaded && more}
	<button class="btn mt-2 w-full" disabled={loading || active !== null} onclick={() => load(true)}>{loading ? 'Loading…' : 'Show older lines'}</button>
{/if}
