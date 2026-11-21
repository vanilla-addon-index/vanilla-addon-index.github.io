<script lang="ts">
	import { entryHref } from '#lib/entry-href.ts';
	import { store } from '#lib/addons.svelte.ts';
	import { decideLink, type LinkRequest } from '#lib/link-reviews.svelte.ts';
	import type { createModerationQueue } from '#lib/moderation-queue.svelte.ts';
	let { queue }: { queue: ReturnType<typeof createModerationQueue<LinkRequest>> } = $props();
	let busy = $state<number>(), error = $state('');
	async function decide(r: LinkRequest, accept: boolean) {
		busy = r.id; error = '';
		try { await decideLink(r.id, accept); queue.remove(r.id); }
		catch (e) { error = (e as Error).message; }
		finally { busy = undefined; }
	}
</script>

<section aria-label="Link suggestions">
	{#if error || queue.error}<p class="mb-3 text-danger" role="alert">{error || queue.error}</p>{/if}
	{#if !queue.loaded && queue.loading}<p class="mb-3 text-muted">Loading link suggestions…</p>{/if}
	{#each queue.rows as request (request.id)}
		{@const addon = store.addons.find(a => a.id === request.addon_id)}
		<div class="panel mb-4 p-4">
			<h2 class="font-bold">New link for {#if addon}<a class="text-accent" href={entryHref(addon)}>{addon.name}</a>{:else}unavailable addon{/if}</h2>
			<p class="mt-1 text-sm text-muted">Suggested by {request.proposer?.username ?? 'a member'}</p>
			<a class="mt-2 block break-all text-accent hover:underline" href={request.url} target="_blank" rel="noopener noreferrer">{request.url}</a>
			{#if request.images?.length}
            <div class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {#each request.images as image}<img src={image} alt="Suggested screenshot" referrerpolicy="no-referrer" class="aspect-video w-full border border-border object-contain" />{/each}
            </div>
            {/if}
            <div class="mt-3 flex gap-2">
				<button class="btn btn-primary" disabled={busy === request.id || !addon} onclick={() => decide(request, true)}>Approve link</button>
				<button class="btn" disabled={busy === request.id} onclick={() => decide(request, false)}>Reject link</button>
			</div>
		</div>
	{/each}
	{#if queue.hasMore || (!queue.loaded && queue.error)}
		<button class="btn mb-4 w-full" disabled={queue.loading} onclick={queue.loadMore}>
			{queue.loaded ? 'Show more link suggestions' : 'Retry loading link suggestions'}
		</button>
	{/if}
</section>
