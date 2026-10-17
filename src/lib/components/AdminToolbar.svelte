<script lang="ts">
	import { getContext, type Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();
	const toolbar = getContext<{ register: (content: Snippet) => () => void }>('admin-toolbar');
	$effect(() => toolbar.register(children));
</script>
