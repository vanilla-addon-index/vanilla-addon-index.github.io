<script lang="ts">
	import { expandArticle, imports, type QueueItem } from '#lib/imports.svelte.ts';
	import { articleLinks, repositoryUrl } from '#lib/wiki-article.ts';
	let { item }: { item: QueueItem } = $props();
	let pasted = $state('');
	function usePasted() {
		const parsed = articleLinks(pasted);
		const links = parsed.length ? parsed : [...pasted.matchAll(/https:\/\/[^\s<>\]"']+/g)].flatMap(m => {
			const url = repositoryUrl(m[0]); return url ? [{ url, recommended: false }] : [];
		});
		void expandArticle(item, [...new Map(links.map(link => [link.url, link])).values()]);
	}
</script>

<div class="mt-2 text-sm">
	{#if imports.wikiReading[item.id]}
		<p class="text-muted" role="status">Finding download links on the wiki… They will appear as normal import entries.</p>
	{:else}
		<p class="text-muted">{imports.wikiErrors[item.id] || 'This wiki article needs download links before it can be imported.'}</p>
		<button type="button" class="btn mt-2" onclick={() => expandArticle(item)}>Retry reading wiki</button>
		<label class="mt-2 block" for={`wiki-links-${item.id}`}>Paste repository links or wiki source</label>
		<textarea id={`wiki-links-${item.id}`} class="input" rows="3" bind:value={pasted}></textarea>
		<button type="button" class="btn mt-2" disabled={!pasted.trim()} onclick={usePasted}>Add to import queue</button>
	{/if}
</div>
