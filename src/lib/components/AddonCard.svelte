<script lang="ts">
	import { resolve } from '$app/paths';
	import type { Addon } from '#lib/types.ts';

	type Props = {
		addon: Pick<Addon, 'slug' | 'name' | 'description' | 'category' | 'repo_url' | 'versions'>;
		// Renders the row without links, for the live preview on the submit page.
		preview?: boolean;
		// Who hosts it, shown when another addon in the list has the same name.
		owner?: string;
		// Another version in a group: indented, smaller and a little dimmed under the group's main
		// version. No fainter than this: its grey text still has to be readable.
		minor?: boolean;
	};
	let { addon, preview = false, owner, minor = false }: Props = $props();

	// The row shows where the description starts.
	const blurb = $derived(addon.description.trim().split('\n')[0]);
	const others = $derived(addon.versions.filter((v) => v.url.trim()).length - 1);
</script>

<div
	class={[
		'relative grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 border-b border-l-2 border-border border-l-transparent px-3 py-2 last:border-b-0 sm:grid-cols-[minmax(0,auto)_minmax(0,1fr)_minmax(0,auto)_auto]',
		!preview && 'transition-colors duration-100 hover:border-l-accent/60 hover:bg-raised',
		minor && 'pl-8 text-sm opacity-80 hover:opacity-100'
	]}
>
	<!-- The name's link is stretched over the whole row; the addon link sits above it. -->
	<svelte:element
		this={preview ? 'span' : 'a'}
		href={preview ? undefined : resolve('/addon/[slug]', { slug: addon.slug })}
		class="min-h-[1lh] truncate after:absolute after:inset-0 sm:max-w-64"
	>
		{addon.name}{#if owner}&nbsp;<span class="ml-1 text-accent/80">{owner}</span>{/if}
	</svelte:element>
	<span class="col-span-2 row-start-2 truncate text-muted sm:col-span-1 sm:row-start-auto">
		{blurb}
	</span>
	<span class="col-span-2 row-start-3 flex min-w-0 gap-2 sm:col-span-1 sm:row-start-auto sm:max-w-96">
		<svelte:element
			this={preview ? 'span' : 'a'}
			href={preview ? undefined : addon.repo_url}
			target={preview ? undefined : '_blank'}
			rel={preview ? undefined : 'noopener nofollow'}
			class={['relative truncate text-accent/80', !preview && 'hover:text-accent hover:underline']}
		>
			{addon.repo_url}
		</svelte:element>
		{#if others > 0}
			<span class="shrink-0 text-sm leading-7 text-muted">+{others} {others === 1 ? 'mirror' : 'mirrors'}</span>
		{/if}
	</span>
	<span class="col-start-2 row-start-1 text-sm leading-7 text-muted sm:col-start-auto sm:row-start-auto">
		{addon.category}
	</span>
</div>
