<script lang="ts">
	import { entryHref } from '#lib/entry-href.ts';
	import { clientKind } from '#lib/client-kinds.ts';
	import { formatUpdateDate, latestAddonCodeUpdate } from '#lib/addon-update.ts';
	import type { Addon } from '#lib/types.ts';

	type Props = {
		addon: Pick<Addon, 'slug' | 'name' | 'description' | 'category' | 'entry_type'>
			& Partial<Pick<Addon, 'code_update' | 'link_code_updates'>>;
		updateDate?: string;
		// Renders the row without links, for the live preview on the submit page.
		preview?: boolean;
		catalogueId?: number;
		// Who hosts it, shown when another addon in the list has the same name or it is in a group.
		owner?: string;
		// Another version in a group: indented under the group's main version, with a line down
		// the indent joining them.
		minor?: boolean;
	};
	let { addon, updateDate, preview = false, catalogueId, owner, minor = false }: Props = $props();

	// The row shows where the description starts.
	const blurb = $derived(addon.description.trim().split('\n')[0]);
	const date = $derived(minor ? undefined : updateDate ?? latestAddonCodeUpdate(addon)?.date);
</script>

<div
	data-catalogue-id={catalogueId}
	class={[
		'relative grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 border-b border-l-2 border-border/50 border-l-transparent px-3 py-1.25 font-read text-sm sm:grid-cols-subgrid',
		!preview && 'transition-colors duration-100 hover:border-l-accent/60 hover:bg-raised',
		catalogueId === undefined ? 'last:border-b-0' : 'catalogue-row',
		minor && 'pl-8 before:absolute before:top-0 before:-bottom-px before:left-4 before:border-l before:border-border'
	]}
>
	<!-- Name and description share the list's first column, the description straight after
	     the name. On a phone the wrapper steps aside and they are cells of the row's own grid. -->
	<span class="contents sm:flex sm:min-w-0 sm:gap-2">
		<!-- The name's link is stretched over the whole row. -->
		<svelte:element
			this={preview ? 'span' : 'a'}
			href={preview ? undefined : entryHref(addon)}
			class="min-h-[1lh] truncate after:absolute after:inset-0 sm:max-w-64 sm:shrink-0"
		>
			{addon.name}{#if owner}&nbsp;<span class="ml-1 text-muted">{owner}</span>{/if}
		</svelte:element>
		<!-- Punctuation between the two, fainter than either; a phone stacks them instead. -->
		{#if blurb}<span class="hidden text-muted/50 sm:inline" aria-hidden="true">–</span>{/if}
		<span class="col-span-2 row-start-2 min-w-0 truncate text-muted">
			{blurb}
		</span>
	</span>
	<span class="contents sm:flex sm:items-center sm:justify-end sm:gap-4">
		<span class="col-start-2 row-start-1 font-sans text-muted sm:col-start-auto sm:row-start-auto sm:text-right">
			{addon.entry_type === 'dll' ? clientKind(addon.category) : addon.category}
		</span>
		<span class={[
			'pointer-events-none col-span-2 row-start-3 shrink-0 font-sans whitespace-nowrap text-muted tabular-nums sm:relative sm:col-span-1 sm:row-start-auto',
			minor && 'hidden sm:block'
		]}>
			<!-- Reserve a date's width on desktop, even when this row has no date. -->
			<span class="invisible hidden sm:block" aria-hidden="true">2000-12-28</span>
			{#if !minor}
				<span class="sm:absolute sm:inset-x-0 sm:top-0">
					{#if date}
						<span class="sr-only">Last update </span><time datetime={date}>{formatUpdateDate(date)}</time>
					{:else}
						<span class="sr-only">Last update unknown</span><span aria-hidden="true">—</span>
					{/if}
				</span>
			{/if}
		</span>
	</span>
</div>
