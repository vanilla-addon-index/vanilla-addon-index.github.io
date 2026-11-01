<script lang="ts">
	import { auth } from '#lib/auth.svelte.ts';
	import { supabase } from '#lib/supabase.ts';
	import { loadQueue } from '#lib/imports.svelte.ts';
	import { readDiscordExport, type DiscordPreview } from '#lib/discord-import.ts';
	let preview = $state<DiscordPreview | null>(null);
	let busy = $state(false);
	let message = $state('');
	let error = $state('');
	async function read(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		preview = null; message = ''; error = '';
		if (!file || !auth.isOwner) return;
		busy = true;
		try {
			if (file.size > 50 * 1024 * 1024) throw new Error('Choose an export smaller than 50 MB.');
			preview = readDiscordExport(file.name, new Uint8Array(await file.arrayBuffer()));
		} catch (e) { error = (e as Error).message; }
		finally { busy = false; }
	}
	async function queue() {
		if (!preview || !auth.isOwner || !supabase || busy) return;
		busy = true; error = '';
		try {
			const { data, error: failure } = await supabase.rpc('queue_discord_imports', { items: preview.items });
			if (failure) throw failure;
			message = `${data.added} new links queued. ${data.skipped} already listed or previously imported links skipped.`;
			preview = null;
			await loadQueue();
		} catch (e) { error = (e as Error).message; }
		finally { busy = false; }
	}
</script>

{#if auth.isOwner}
	<div class="panel min-w-0 p-3">
		<h2 class="label">Import Discord</h2>
		<p class="my-2 text-sm text-muted">ZIP or JSON · Max 50 MB</p>
		<input class="mt-1 block w-full min-w-0 text-sm" aria-label="Choose Discord export" type="file" accept=".zip,.json" disabled={busy} onchange={read} />
		{#if preview}
			<button class="btn mt-2" disabled={busy || !preview.items.length} onclick={queue}>Add to import queue</button>
		{/if}
		<p aria-live="polite" class={error ? 'text-danger' : 'text-accent'}>{busy ? 'Reading export…' : error || message}</p>
	</div>
{/if}
