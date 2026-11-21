<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { entryHref } from '#lib/entry-href.ts';
	import LinkReviewDetails from '#lib/components/LinkReviewDetails.svelte';
	import AdminToolbar from '#lib/components/AdminToolbar.svelte';
	import AdminSidebarContent from '#lib/components/AdminSidebarContent.svelte';
	import AdminNavigation from '#lib/components/AdminNavigation.svelte';
	import ReviewQueueRow from '#lib/components/ReviewQueueRow.svelte';
	import { store } from '#lib/addons.svelte.ts';
	import { FIELD_LABELS, displayEditValue as value, decideEdit, type EditField, type EditRequest } from '#lib/edit-reviews.svelte.ts';
	import { decideLink, type LinkRequest } from '#lib/link-reviews.svelte.ts';
	import { createModerationQueue } from '#lib/moderation-queue.svelte.ts';
	import { adminBadgeCounts } from '#lib/admin-badges.svelte.ts';
	import { SITE_NAME } from '#lib/config.ts';

	const addonOf = (id: number) => store.addons.find(addon => addon.id === id);
	const fieldsOf = (request: EditRequest) => Object.keys(request.changes) as EditField[];
	let fields = $state<Record<number, EditField[]>>({});
	let query = $state('');
	let openId = $state<string>();
	let busy = $state(false);
	let error = $state('');
	let list = $state<HTMLDivElement>();

	const edits = createModerationQueue<EditRequest>('edits', request =>
		[addonOf(request.addon_id)?.name, request.proposer?.username, ...fieldsOf(request).map(key => FIELD_LABELS[key])].join(' '),
		rows => {
			for (const request of rows) fields[request.id] ??= fieldsOf(request);
		});
	const links = createModerationQueue<LinkRequest>('links', request =>
		[addonOf(request.addon_id)?.name, request.url, request.proposer?.username].join(' '));
	const rows = $derived([
		...links.rows.map(request => ({ kind: 'link' as const, id: 'link-review-' + request.id, request, addon: addonOf(request.addon_id) })),
		...edits.rows.map(request => ({ kind: 'edit' as const, id: 'edit-review-' + request.id, request, addon: addonOf(request.addon_id) }))
	].sort((a, b) => (a.addon?.name ?? 'Unavailable addon').localeCompare(b.addon?.name ?? 'Unavailable addon')));
	const rowIds = $derived(rows.map(row => row.id));
	const selected = $derived(openId && rowIds.includes(openId) ? openId : rowIds[0]);
	const loading = $derived(links.loading || edits.loading);
	const hasMore = $derived(links.hasMore || edits.hasMore);
	const canRetry = $derived(Boolean((!links.loaded && links.error) || (!edits.loaded && edits.error)));

	function loadMore() {
		openId = selected;
		links.loadMore();
		edits.loadMore();
	}

	$effect(() => {
		const term = query.trim();
		const stopEdits = untrack(() => edits.search(term));
		const stopLinks = untrack(() => links.search(term));
		return () => {
			stopEdits?.();
			stopLinks?.();
		};
	});

	const current = (request: EditRequest, key: EditField) => addonOf(request.addon_id)?.[key];
	const conflict = (request: EditRequest, key: EditField) =>
		JSON.stringify(current(request, key)) !== JSON.stringify(request.base[key]);

	async function decide(id: string, apply: () => Promise<void>, remove: () => void) {
		if (busy) return;
		error = '';
		busy = true;
		try {
			await apply();
			if (selected === id) {
				const index = rowIds.indexOf(id);
				openId = rowIds[index + 1] ?? rowIds[index - 1];
			}
			remove();
		} catch (e) {
			error = (e as Error).message;
		} finally {
			busy = false;
		}
		await tick();
		if (document.activeElement === document.body && selected) {
			list?.querySelector<HTMLElement>('#' + selected + ' [data-act="review"]')?.focus();
		}
	}
</script>

<svelte:head><title>Edit reviews · {SITE_NAME}</title></svelte:head>

<AdminToolbar>
	<input class="input w-full" type="search" aria-label="Search edit reviews" placeholder="Search edit reviews" bind:value={query} />
	<AdminNavigation />
</AdminToolbar>

<AdminSidebarContent>
	<div class="panel">
		<header class="border-b border-border px-3 py-2">
			<h1 class="text-2xl leading-tight font-bold">Edit reviews</h1>
			<p class="text-sm text-muted">Review link suggestions and contributor proposals.</p>
		</header>
		<dl class="flex justify-between gap-2 px-3 py-2 text-sm font-semibold">
			<dt>Waiting</dt><dd class="tabular-nums">{edits.loaded && links.loaded ? adminBadgeCounts().edits : '…'}</dd>
		</dl>
	</div>
	<details class="panel px-3 py-2 text-sm">
		<summary class="cursor-pointer font-semibold hover:text-accent">Reviewing edits</summary>
		<p class="mt-2 text-muted">Select the fields to accept. If a field has changed since the proposal, leave it unselected and ask the contributor for a revision.</p>
	</details>
</AdminSidebarContent>

{#if error}<p class="mb-2 break-words text-danger" role="alert">{error}</p>{/if}

<div class="panel" bind:this={list}>
	{#if links.error}<p class="px-3 py-2 text-danger" role="alert">{links.error}</p>{/if}
	{#if edits.error}<p class="px-3 py-2 text-danger" role="alert">{edits.error}</p>{/if}
	{#if loading && (!links.loaded || !edits.loaded)}
		<p class="px-3 py-2 text-muted" role="status">Loading edit reviews…</p>
	{/if}

	{#each rows as row (row.id)}
		{@const { id, addon, request } = row}
		{@const subtitle = (row.kind === 'link' ? 'Suggested' : 'Proposed') + ' by ' + (request.proposer?.username ?? 'a contributor')}
		<ReviewQueueRow rowId={id} title={addon?.name ?? 'Unavailable addon'} {subtitle} selected={selected === id} onselect={() => (openId = id)}>
			{#snippet badges()}
				<span class="rounded border border-border px-1.5 py-0.5 text-xs text-muted">{row.kind === 'link' ? 'Link suggestion' : 'Edit proposal'}</span>
				{#if row.kind === 'link'}
					{@const count = row.request.images?.length ?? 0}
					{#if count}
						<span class="rounded border border-border px-1.5 py-0.5 text-xs text-muted">{count} {count === 1 ? 'screenshot' : 'screenshots'}</span>
					{/if}
				{:else}
					{@const proposal = row.request}
					{@const keys = fieldsOf(proposal)}
					{#each keys as key (key)}
						<span class="rounded border border-border px-1.5 py-0.5 text-xs text-muted">{FIELD_LABELS[key]}</span>
					{/each}
					{#if addon && keys.some(key => conflict(proposal, key))}
						<span class="rounded border border-accent/35 px-1.5 py-0.5 text-xs text-accent">Conflict</span>
					{/if}
				{/if}
			{/snippet}
			{#if selected === id}
				{#if row.kind === 'link'}
					<LinkReviewDetails request={row.request} {addon} {busy} ondecision={accept => decide(id, () => decideLink(request.id, accept), () => links.remove(request.id))} />
				{:else}
					{@const proposal = row.request}
					{@const decideProposal = (accept: boolean) => decide(id, () => decideEdit(proposal.id, accept, fields[proposal.id]), () => {
						edits.remove(proposal.id);
						delete fields[proposal.id];
					})}
					{#each fieldsOf(proposal) as key (key)}
						<div class="border-b border-border pb-2 not-first:pt-2">
							<label class="flex items-center gap-2 font-semibold">
								<input class="accent-accent" type="checkbox" value={key} bind:group={fields[proposal.id]} disabled={busy} />
								{FIELD_LABELS[key]}
							</label>
							{#if addon && conflict(proposal, key)}
								<p class="mt-1 text-sm text-danger">This field changed since the proposal. Leave it unselected and ask the contributor to revise it.</p>
							{/if}
							<div class="mt-1.5 grid gap-x-4 gap-y-2 sm:grid-cols-2">
								<div class="min-w-0"><h3 class="text-sm text-muted">Current</h3><p class="whitespace-pre-wrap [overflow-wrap:anywhere]">{value(current(proposal, key))}</p></div>
								<div class="min-w-0"><h3 class="text-sm text-accent">Proposed</h3><p class="whitespace-pre-wrap [overflow-wrap:anywhere]">{value(proposal.changes[key])}</p></div>
							</div>
						</div>
					{/each}
					<div class="mt-2 flex flex-wrap items-center gap-2">
						{#if addon}<a class="btn py-1" href={entryHref(addon)}>Open the addon</a>{/if}
						<button class="btn btn-primary py-1" disabled={busy || !fields[proposal.id]?.length || !addon} onclick={() => decideProposal(true)}>Accept selected fields</button>
						<button class="btn py-1" disabled={busy} onclick={() => decideProposal(false)}>Reject proposal</button>
					</div>
				{/if}
			{/if}
		</ReviewQueueRow>
	{/each}

	{#if edits.loaded && links.loaded && !rows.length && !hasMore}
		<div class="px-4 py-5 text-center">
			<h2 class="font-semibold">{query.trim() ? 'No edit reviews match your search.' : 'No edits are waiting for review.'}</h2>
		</div>
	{/if}
</div>
{#if hasMore || canRetry}
	<button class="btn mt-2 w-full" disabled={loading} onclick={loadMore}>{hasMore ? 'Show more reviews' : 'Retry loading reviews'}</button>
{/if}
