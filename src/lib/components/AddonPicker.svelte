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

	const id = $props.id();
	let query = $state('');
	const matches = $derived(searchAddons(query, exclude));
	const open = $derived(Boolean(query.trim()));
	// The match the arrow keys are on, which Enter takes. The first until they move.
	let active = $state(0);

	function pick(addon: Addon) {
		query = '';
		onpick(addon);
	}

	function keydown(event: KeyboardEvent) {
		if (event.key === 'Escape') query = '';
		const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
		if (step && matches.length) {
			// Keeps the caret where it is instead of jumping to an end of the text.
			event.preventDefault();
			active = (active + step + matches.length) % matches.length;
		}
		if (event.key !== 'Enter') return;
		// Enter never submits a surrounding form.
		event.preventDefault();
		if (matches[active]) pick(matches[active]);
	}
</script>

<!-- Find one addon among many by typing part of its name: the best few matches appear
     underneath, each with who hosts it, since names repeat. The keyboard stays in the
     text field: the arrow keys move through the matches and Enter takes one, which is how
     a screen reader expects a list of suggestions to work. -->
<div class="relative">
	<input
		class="input"
		type="search"
		role="combobox"
		aria-autocomplete="list"
		aria-expanded={open}
		aria-controls="{id}-list"
		aria-activedescendant={open && matches[active] ? `${id}-${matches[active].id}` : undefined}
		{placeholder}
		aria-label={placeholder}
		bind:value={query}
		oninput={() => (active = 0)}
		onkeydown={keydown}
	/>
	{#if open}
		<ul id="{id}-list" role="listbox" aria-label="Matching addons" class="absolute inset-x-0 top-full z-10 mt-1 border border-border bg-bg">
			{#each matches as addon, index (addon.id)}
				<!-- The keys are handled by the text field above, which keeps the focus. -->
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<li
					id="{id}-{addon.id}"
					role="option"
					aria-selected={index === active}
					class={[
						'flex cursor-pointer items-baseline gap-2 px-3 py-1 transition-colors duration-100 hover:bg-raised',
						index === active && 'bg-raised'
					]}
					onclick={() => pick(addon)}
				>
					<span class="truncate">{addon.name}</span>
					<span class="shrink-0 text-sm text-muted">{linkOwner(addon.repo_url)}</span>
				</li>
			{/each}
		</ul>
		{#if !matches.length}
			<p role="status" class="absolute inset-x-0 top-full z-10 mt-1 border border-border bg-bg px-3 py-1 text-muted">
				No addon with that name.
			</p>
		{/if}
	{/if}
</div>
