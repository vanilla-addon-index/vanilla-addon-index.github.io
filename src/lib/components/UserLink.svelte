<script lang="ts">
	import { resolve } from '$app/paths';
	import { auth } from '#lib/auth.svelte.ts';

	// A username that admins can click through to that account's page in the admin panel.
	// Anyone else, and a missing name, gets plain text.
	let { name, fallback = '', class: classes = '' }: { name: string | null | undefined; fallback?: string; class?: string } =
		$props();
</script>

{#if name && auth.isAdmin}
	<a
		href={resolve(`/admin/users/profile?name=${encodeURIComponent(name)}`)}
		class={['hover:text-accent hover:underline', classes]}>{name}</a
	>
{:else}
	<span class={classes}>{name || fallback}</span>
{/if}
