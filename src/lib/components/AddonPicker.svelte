<script lang="ts">
	import { searchAddons } from '#lib/addons.svelte.ts';
	import { linkOwner } from '#lib/links.ts';
	import type { Addon } from '#lib/types.ts';

	type Props = {
		placeholder: string;
		// Addons that must not be offered, such as the one being edited.
		exclude?: (addon: Addon) => boolean;
		onpick: (addon: Addon) => void;
	};
	let { placeholder, exclude = () => false, onpick }: Props = $props();

	let query = $state('');
	const matches = $derived(searchAddons(query, exclude));

	function pick(addon: Addon) {
		query = '';
		onpick(addon);
	}
</script>

<!-- Find one addon among many by typing part of its name: the best few matches appear
     underneath, each with who hosts it, since names repeat. -->
<div class="relative">
	<input
		class="input"
		type="search"
		{placeholder}
		aria-label={placeholder}
		bind:value={query}
		onkeydown={(event) => {
			if (event.key === 'Escape') query = '';
			if (event.key !== 'Enter') return;
			// Enter takes the top match, and never submits a surrounding form.
			event.preventDefault();
			if (matches[0]) pick(matches[0]);
		}}
	/>
	{#if query.trim()}
		<ul class="absolute inset-x-0 top-full z-10 mt-1 border border-border bg-bg">
			{#each matches as addon (addon.id)}
				<li>
					<button
						type="button"
						class="flex w-full cursor-pointer items-baseline gap-2 px-3 py-1 text-left transition-colors duration-100 hover:bg-raised"
						onclick={() => pick(addon)}
					>
						<span class="truncate">{addon.name}</span>
						<span class="shrink-0 text-sm text-muted">{linkOwner(addon.repo_url)}</span>
					</button>
				</li>
			{:else}
				<li class="px-3 py-1 text-muted">No addon with that name.</li>
			{/each}
		</ul>
	{/if}
</div>
