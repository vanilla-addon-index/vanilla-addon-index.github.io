<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';

	// The panel has no page of its own; it opens on the first tab.
	$effect(() => {
		goto(resolve('/admin/import'), { replace: true });
	});
</script>
