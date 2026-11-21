<script lang="ts">
	import { entryHref } from '#lib/entry-href.ts';
	import type { LinkRequest } from '#lib/link-reviews.svelte.ts';
	import type { Addon } from '#lib/types.ts';

	let { request, addon, busy, ondecision }: {
		request: LinkRequest;
		addon?: Addon;
		busy: boolean;
		ondecision: (accept: boolean) => void;
	} = $props();
</script>

<p class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
	<span class="font-semibold text-muted">Suggested link</span>
	<a class="text-accent [overflow-wrap:anywhere] hover:underline" href={request.url} target="_blank" rel="noopener noreferrer">{request.url}</a>
</p>
{#if request.images?.length}
	<div class="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
		{#each request.images as image}
			<img src={image} alt="Suggested screenshot" referrerpolicy="no-referrer" class="aspect-video max-h-40 w-full border border-border object-contain" />
		{/each}
	</div>
{/if}
<div class="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2">
	{#if addon}<a class="btn py-1" href={entryHref(addon)}>Open the addon</a>{/if}
	<button class="btn btn-primary py-1" disabled={busy || !addon} onclick={() => ondecision(true)}>Approve link</button>
	<button class="btn py-1" disabled={busy} onclick={() => ondecision(false)}>Reject link</button>
</div>
