<script lang="ts">
	import {getContext, type Snippet} from 'svelte';
	let {children}: {children: Snippet} = $props();
	const sidebar = getContext<{register: (content: Snippet) => () => void}>('admin-sidebar');
	$effect(() => sidebar.register(children));
</script>
