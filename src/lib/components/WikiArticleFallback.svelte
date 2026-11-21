<script lang="ts">
	import type { Snippet } from 'svelte';
	import { expandArticle, imports, type QueueItem } from '#lib/imports.svelte.ts';
	import { articleLinks, repositoryUrl } from '#lib/wiki-article.ts';

	let { item, rejectAction }: { item: QueueItem; rejectAction: Snippet } = $props();
	let pasted = $state('');
	let pasteOpen = $state(false);
	const id = $props.id();
	const reading = $derived(imports.wikiReading[item.id]);
	const failure = $derived(imports.wikiErrors[item.id]);

	function usePasted() {
		const parsed = articleLinks(pasted);
		const links = parsed.length ? parsed : [...pasted.matchAll(/https:\/\/[^\s<>\]"']+/g)].flatMap(match => {
			const url = repositoryUrl(match[0]);
			return url ? [{ url, recommended: false }] : [];
		});
		void expandArticle(item, [...new Map(links.map(link => [link.url, link])).values()]);
	}
</script>

<div class="space-y-2">
	{#if reading}
		<p role="status" class="text-sm text-muted">Finding download links…</p>
	{:else}
		<p class="text-sm">
			{#if failure}<span class="text-accent">{failure}</span>
			{:else}<span class="text-muted">Find download links in the wiki article to add them to the queue.</span>{/if}
		</p>
	{/if}

	<div class="flex flex-wrap items-center gap-2">
		<button type="button" class="btn btn-primary py-1" disabled={reading} onclick={() => expandArticle(item)}>Retry reading wiki</button>
		<button type="button" class="btn py-1" disabled={reading} aria-expanded={pasteOpen} aria-controls={id} onclick={() => (pasteOpen = !pasteOpen)}>
			Paste links manually
		</button>
		<a href={item.url} target="_blank" rel="noopener nofollow" class="px-1 text-sm text-accent hover:underline">Open wiki article ↗</a>
		<div class="ml-auto">{@render rejectAction()}</div>
	</div>

	<div id={id} hidden={!pasteOpen} class="border-t border-border pt-2">
		<label class="mb-1 block text-sm text-muted" for={id + '-input'}>Paste repository links or wiki source</label>
		<textarea id={id + '-input'} class="input" rows="3" bind:value={pasted} disabled={reading}></textarea>
		<button type="button" class="btn btn-primary mt-2" disabled={reading || !pasted.trim()} onclick={usePasted}>Add to import queue</button>
	</div>
</div>
