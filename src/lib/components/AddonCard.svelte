<script lang="ts">
	import { resolve } from '$app/paths';
	import { LINK_HOSTS } from '#lib/config.ts';
	import { linkKey } from '#lib/links.ts';
	import type { Addon } from '#lib/types.ts';

	type Props = {
		addon: Pick<Addon, 'slug' | 'name' | 'description' | 'category' | 'repo_url'>;
		// Renders the row without links, for the live preview on the submit page.
		preview?: boolean;
		// Let the desktop catalogue skip layout for rows outside its scroll viewport.
		defer?: boolean;
		// Who hosts it, shown when another addon in the list has the same name or it is in a group.
		owner?: string;
		// Another version in a group: indented under the group's main version, with a line down
		// the indent joining them.
		minor?: boolean;
	};
	let { addon, preview = false, defer = false, owner, minor = false }: Props = $props();

	// The row shows where the description starts.
	const blurb = $derived(addon.description.trim().split('\n')[0]);
	// The link is a small button naming the site it opens. Every button is as wide as the
	// longest name among the allowed sites, so they are all one size.
	const host = $derived(linkKey(addon.repo_url ?? '').split('/')[0]);
	const WIDEST = LINK_HOSTS.map((h) => h.split('/')[0]).reduce((a, b) => (b.length > a.length ? b : a));
</script>

<div
	class={[
		'relative grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 border-b border-l-2 border-border/50 border-l-transparent px-3 py-1.25 font-read text-sm last:border-b-0 sm:grid-cols-subgrid',
		!preview && 'transition-colors duration-100 hover:border-l-accent/60 hover:bg-raised',
		defer && 'deferred-addon',
		minor && 'pl-8 before:absolute before:top-0 before:-bottom-px before:left-4 before:border-l before:border-border'
	]}
>
	<!-- Name and description share the list's first column, the description straight after
	     the name. On a phone the wrapper steps aside and they are cells of the row's own grid. -->
	<span class="contents sm:flex sm:min-w-0 sm:gap-2">
		<!-- The name's link is stretched over the whole row; the addon link sits above it. -->
		<svelte:element
			this={preview ? 'span' : 'a'}
			href={preview ? undefined : resolve('/addon/[slug]', { slug: addon.slug })}
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
			{addon.category}
		</span>
		<span class="col-span-2 row-start-3 flex min-w-0 items-center sm:col-span-1 sm:row-start-auto sm:justify-end">
			{#if host}
				<svelte:element
					this={preview ? 'span' : 'a'}
					href={preview ? undefined : addon.repo_url}
					target={preview ? undefined : '_blank'}
					rel={preview ? undefined : 'noopener nofollow'}
					class={[
						'relative shrink-0 border border-border px-1.5 font-sans text-sm leading-tight text-muted',
						!preview && 'transition-colors duration-100 hover:bg-raised hover:text-fg'
					]}
				>
					<span class="invisible" aria-hidden="true">{WIDEST} ↗</span>
					<span class="absolute inset-x-1.5 inset-y-0 flex items-center justify-between gap-1">
						<span class="truncate">{host}</span>
						<span aria-hidden="true">↗</span>
					</span>
				</svelte:element>
			{:else}<span class="text-sm text-muted">No download links</span>{/if}
		</span>
	</span>
</div>
