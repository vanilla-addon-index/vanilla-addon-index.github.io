<script lang="ts">
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';
	let { label, children }: { label: string; children: Snippet } = $props();
	let expanded = $state(false);
	$effect(() => {
		void page.url.pathname;
		expanded = false;
	});
</script>

<div class={[expanded && 'space-y-2', 'md:contents']}>
	<button
		type="button"
		class="panel flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 px-3 py-2 text-left font-bold md:hidden"
		aria-expanded={expanded}
		onclick={() => (expanded = !expanded)}
	>
		<span>{label}</span>
		<span aria-hidden="true" class="text-muted">{expanded ? '−' : '+'}</span>
	</button>
	<div class={[expanded ? 'space-y-2' : 'hidden', 'md:block md:space-y-2']}>
		{@render children()}
	</div>
</div>
