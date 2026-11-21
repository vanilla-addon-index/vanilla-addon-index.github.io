<script lang="ts">
	import type { Snippet } from 'svelte';

	let { title, subtitle, selected, onselect, badges, children, index, rowId, onreviewkey }: {
		title: string;
		subtitle: string;
		selected: boolean;
		onselect: () => void;
		badges: Snippet;
		children: Snippet;
		index?: number;
		rowId?: string;
		onreviewkey?: (event: KeyboardEvent) => void;
	} = $props();

	const panelId = $props.id();
</script>

<article id={rowId} data-entry={index} class="border-b border-border last:border-b-0">
	<button
		type="button"
		data-act="review"
		aria-expanded={selected}
		aria-disabled={selected}
		aria-controls={panelId}
		onclick={onselect}
		class={[
			'grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-l-2 px-3 py-2 text-left hover:bg-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent sm:grid-cols-[minmax(0,1fr)_fit-content(45%)_auto]',
			selected ? 'cursor-default border-accent bg-accent/10' : 'cursor-pointer border-transparent opacity-85 hover:opacity-100 focus-visible:opacity-100'
		]}
	>
		<span class="min-w-0">
			<span class="block font-bold [overflow-wrap:anywhere]">{title}</span>
			<span class="block truncate text-sm text-muted">{subtitle}</span>
		</span>
		<span class="col-start-1 row-start-2 flex min-w-0 flex-wrap gap-1 sm:col-start-2 sm:row-start-1 sm:justify-end">
			{@render badges()}
		</span>
		<span class={['col-start-2 row-start-1 size-1.5 border-r border-b border-current text-muted sm:col-start-3', selected ? 'invisible' : 'rotate-45']} aria-hidden="true"></span>
	</button>

	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div id={panelId} hidden={!selected} class="border-l-2 border-accent/35 px-3 py-2.5" onkeydown={onreviewkey}>
		{@render children()}
	</div>
</article>
