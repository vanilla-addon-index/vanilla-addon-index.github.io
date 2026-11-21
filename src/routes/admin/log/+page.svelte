<script lang="ts">
	import { entryHref } from '#lib/entry-href.ts';
	import HistoryGrouping from '#lib/components/HistoryGrouping.svelte';
	import HistoryComparison from '#lib/components/HistoryComparison.svelte';
	import LogAddonHistory from '#lib/components/LogAddonHistory.svelte';
	import { REASONS } from '#lib/reports.svelte.ts';
	import { fieldLabel, changeSummary } from '#lib/history.ts';
	import { recoveryComparison, type RecoveryComparison } from '#lib/admin.ts';
	import AdminToolbar from '#lib/components/AdminToolbar.svelte';
	import AdminSidebarContent from '#lib/components/AdminSidebarContent.svelte';
	import AdminNavigation from '#lib/components/AdminNavigation.svelte';
	import ReviewQueueRow from '#lib/components/ReviewQueueRow.svelte';
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
	const BADGES: Record<string, string> = {
		addon: 'Addon', group: 'Group', import: 'Import', report: 'Report',
		user: 'Account', account: 'Account', trash: 'Trash'
	};

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
	const addressQuery = $derived(page.url.searchParams.get('q') ?? '');
	$effect(() => { query = addressQuery; });
	let typing: ReturnType<typeof setTimeout>;
	$effect(() => () => clearTimeout(typing));
	function search() {
		clearTimeout(typing);
		typing = setTimeout(() => narrow({ q: query.trim() || undefined }), 300);
	}
	let outcomes = $state<Record<number, { text: string; failed: boolean }>>({});
	let selectedId = $state<number>();
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
			if (!older) {
				comparison = undefined;
				selectedId = wanted.entryId && next.length ? wanted.entryId : undefined;
			}
			if (wanted.entryId) {
				const entry = next[0];
				if (entry) void inspect(entry);
				await tick();
				if (mine !== asked) return;
				const summary = document.querySelector<HTMLElement>(`#log-${wanted.entryId} [data-act="review"]`);
				summary?.focus({ preventScroll: true });
				summary?.scrollIntoView({ block: 'start' });
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
	let comparison = $state<RecoveryComparison>();
	let comparisonError = $state('');
	let comparisonRequest = 0;
	async function inspect(entry: LogEntry) {
		const request = ++comparisonRequest;
		comparisonError = '';
		if (!entry.details?.changed || !entry.details.before) return;
		try {
			const result = await recoveryComparison(entry.id);
			if (request === comparisonRequest && selectedId === entry.id) comparison = result;
		} catch (e) {
			if (request === comparisonRequest && selectedId === entry.id) comparisonError = (e as Error).message;
		}
	}

	async function selectEntry(entry: LogEntry) {
		if (selectedId === entry.id) {
			selectedId = undefined;
			return;
		}
		comparison = undefined;
		selectedId = entry.id;
		void inspect(entry);
		await tick();
		document.querySelector(`#log-${entry.id} [data-act="review"]`)?.scrollIntoView({ block: 'nearest' });
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
		const selected = current.find(entry => entry.id === selectedId);
		if (selected) await inspect(selected);
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
			if (row?.isConnected && top !== undefined) {
				const offset = row.getBoundingClientRect().top - top;
				const region = row.closest('[aria-label="Admin content"]');
				if (region && getComputedStyle(region).overflowY === 'auto') region.scrollBy(0, offset);
				else window.scrollBy(0, offset);
			}
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

<AdminSidebarContent>
	<div class="panel">
		<header class="border-b border-border px-3 py-2">
			<h1 class="text-2xl leading-tight font-bold">Log</h1>
			<p class="text-sm text-muted">Activity and recovery.</p>
		</header>
		<div class="px-3 py-2">
			<label class="label" for="log-kind">Kind of action</label>
			<select id="log-kind" class="input" value={filter.kind ?? 'all'} onchange={(event) => narrow({kind:event.currentTarget.value === 'all' ? undefined : event.currentTarget.value})}>
				{#each Object.entries(GROUPS) as [value,label]}<option {value}>{label}</option>{/each}
			</select>
		</div>
		<dl class="flex justify-between gap-2 border-t border-border px-3 py-2 text-sm">
			<dt class="text-muted">Loaded entries</dt><dd class="tabular-nums">{loaded ? entries.length : '…'}</dd>
		</dl>
	</div>
</AdminSidebarContent>

<AdminToolbar>
	<input
		class="input w-full"
		type="search"
		placeholder="Search by person or addon"
		aria-label="Search the log"
		bind:value={query}
		oninput={search}
	/>
	<AdminNavigation />
</AdminToolbar>

{#if filter.entryId}
	<p class="mb-2">Log entry #{filter.entryId}
		<a class="ml-2 text-sm text-accent hover:underline" href={resolve('/admin/log')}>Show the whole log</a>
	</p>
{/if}

{#if filter.addonId || filter.by}
	<p class="mb-2">
		{#if filter.addonId}History of{' '}<span class="font-bold">{historyOf}</span>{/if}
		{#if filter.by}{filter.addonId ? ', by' : 'Everything done by'}{' '}<span class="font-bold">{filter.by}</span>{/if}
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
			{@const kind = entry.action.split('.')[0]}
			{@const recovery = recoveries[entry.id]}
			<ReviewQueueRow rowId={`log-${entry.id}`} selected={selectedId === entry.id} collapsible onselect={() => selectEntry(entry)}>
				{#snippet title()}
					{entry.actor_name ?? 'The system'}
					<span class="font-normal text-muted">{ACTION_TEXT[entry.action] ?? entry.action}</span>
					{entry.action === 'user.autosuspend' ? entry.details?.reason : entry.subject}
					{#if entry.action === 'group.decline' && entry.details?.target}
						<span class="font-normal text-muted">with</span> {entry.details.target}
					{/if}
					{#if entry.details?.trashed}<span class="font-normal text-muted">and trashed their addons</span>{/if}
				{/snippet}
				{#snippet badges()}
					<span class="flex flex-wrap items-center gap-x-admin-badge gap-y-1 sm:grid sm:grid-cols-[4.25rem_8rem]">
						<span class={['admin-badge w-17', entry.action === 'user.ban' || entry.action === 'addon.delete' || entry.action === 'trash.purge' ? 'border-danger/35 text-danger' : 'border-border text-muted']}>
							{BADGES[kind] ?? 'Activity'}
						</span>
						<time datetime={entry.at} class="text-xs text-muted tabular-nums">{when(entry.at)}</time>
					</span>
				{/snippet}

				{#if selectedId === entry.id}
					{@const actions = undos(entry, addon)}
					{@const canEdit = addon && entry.details?.changed && entry.details.before && !recovery?.recovery_id}
					{@const canReviewGroup = addon && entry.details?.groups_before?.length && recovery?.reason}
					{@const details = entry.details}
					{@const reportReason = kind === 'report' && details?.reason ? Object.entries(REASONS).find(([key]) => key === details.reason)?.[1] ?? details.reason : undefined}
					{@const removed = entry.action === 'trash.purge' && details?.names && details.names.length > 1 ? details.names : undefined}
					<div class="space-y-2">
						<p class="text-sm text-muted">
							By <UserLink name={entry.actor_name} fallback="the system" class={entry.actor_name ? 'text-accent' : ''} />
							{#if kind === 'user' && entry.subject && entry.subject !== entry.actor_name}
								<span aria-hidden="true"> · </span>Account <UserLink name={entry.subject} class="text-accent" />
							{/if}
						</p>

						{#if addon || details?.undid || actions.length}
							<div class="flex flex-wrap items-center gap-2" role="group" aria-label="Entry actions">
								{#if addon}
									<a href={entryHref(addon)} class="btn py-1">{canReviewGroup ? 'Review current grouping' : 'Open the addon'}</a>
								{/if}
								{#if canEdit && addon}
									<a class="btn py-1" href={resolve(`/submit?edit=${addon.slug}&review=${entry.id}`)}>Edit current addon</a>
								{/if}
								{#if details?.undid}
									<a class="btn py-1" href={resolve(`/admin/log?entry=${details.undid}#log-${details.undid}`)}>View original entry</a>
								{/if}
								{#each actions as action (action.label)}
									<button class={['btn py-1', action.danger ? 'btn-danger' : 'btn-primary']} disabled={active !== null || loading} onclick={() => undo(entry, action)}>
										{action.label}
									</button>
								{/each}
							</div>
						{/if}
						<section class="space-y-1.5 border-t border-border pt-2 text-sm" aria-label="Entry details">
							<h3 class="font-semibold">Details</h3>
							{#if recovery?.recovery_id}
								<p class="text-sm text-muted">
									<a class="text-accent hover:underline" href={resolve(`/admin/log?entry=${recovery.recovery_id}#log-${recovery.recovery_id}`)}>
										Recovered by {recovery.actor_name ?? 'Deleted account'}
										{#if recovery.recovered_at}· {when(recovery.recovered_at)}{/if}
									</a>
								</p>
							{:else if recovery?.reason}
								<p class="text-sm text-muted">{recovery.reason}</p>
							{/if}
							{#if active === entry.id}<p class="text-sm text-muted" role="status">Recovering…</p>{/if}
							{#if outcomes[entry.id]}
								<p class={['text-sm break-words', outcomes[entry.id].failed ? 'text-danger' : 'text-accent']} role="status">{outcomes[entry.id].text}</p>
							{/if}
							{#if reportReason}<p class="text-muted">Reason <span class="ml-1 text-fg">{reportReason}</span></p>{/if}
							{#if details?.url}
								<p class="text-muted">Source <span class="ml-1 [overflow-wrap:anywhere] text-fg">{details.url}</span></p>
							{/if}

							{#if entry.action === 'user.rollback'}
								<p class="text-sm text-muted">{entry.details?.steps ?? 0} changes rolled back; {entry.details?.skipped ?? 0} steps could not be undone.</p>
								{#each entry.details?.skipped_details ?? [] as miss, index (index)}
									<p class="text-sm break-words text-danger">Cannot undo "{ACTION_TEXT[miss.action] ?? miss.action} {miss.subject}": {miss.why}</p>
								{/each}
								{#if entry.details?.skipped && !entry.details.skipped_details}
									<p class="text-sm text-muted">Detailed failure reasons were not recorded for this older rollback.</p>
								{/if}
							{/if}

							{#if removed}
								<p class="break-words text-muted">Removed {removed.join(', ')}</p>
							{/if}

							{#if entry.details?.groups_before?.length}
								<section aria-label="Grouping changes">
									<HistoryGrouping {entry} addons={store.addons} />
								</section>
							{/if}
							{#if entry.details?.changed && entry.details.before}
								<section aria-label="Changes">
									<p class="text-sm text-muted">{changeSummary(entry.details.changed, entry.details.before, entry.details.after)}</p>
									{#if comparisonError}<p class="text-sm text-danger" role="alert">{comparisonError}</p>
									{:else if !comparison}<p class="text-sm text-muted" role="status">Loading current content…</p>{/if}
									<HistoryComparison {entry} {comparison} showSummary={false} />
								</section>
							{:else if entry.details?.changed}
								<p class="text-sm text-muted">
									Changed {entry.details.changed.map(fieldLabel).join(', ')}. What it looked like before is no longer kept.
								</p>
							{/if}
							{#if !recovery?.recovery_id && !recovery?.reason && !outcomes[entry.id] && active !== entry.id &&
								!reportReason && !details?.url && !removed && !details?.changed && !details?.groups_before?.length &&
								entry.action !== 'user.rollback'}
								<p class="text-muted">No additional details were recorded.</p>
							{/if}
						</section>
						{#if entry.addon_id && !filter.addonId}
							<LogAddonHistory addonId={entry.addon_id} entryId={entry.id} {when} />
						{/if}
					</div>
				{/if}
			</ReviewQueueRow>
		{/each}
	{/if}
</div>

{#if loaded && more}
	<button class="btn mt-2 w-full" disabled={loading || active !== null} onclick={() => load(true)}>{loading ? 'Loading…' : 'Show older lines'}</button>
{/if}
