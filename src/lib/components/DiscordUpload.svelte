<script lang="ts">
	import { auth } from '#lib/auth.svelte.ts';
	import { supabase } from '#lib/supabase.ts';
	import { imports, loadQueue } from '#lib/imports.svelte.ts';
	import { ask } from '#lib/confirm.svelte.ts';
	import { readDiscordExport, type DiscordPreview } from '#lib/discord-import.ts';
	let preview = $state<DiscordPreview | null>(null);
	let busy = $state(false);
	let message = $state('');
	let error = $state('');
	const pendingDiscord = $derived(imports.items.filter(item => item.source === 'Discord').length);
	async function clearPending() {
		if (!auth.isOwner || !supabase || busy) return;
		if (!await ask({ title: 'Clear pending Discord imports?', body: 'Remove unreviewed Discord entries so you can import them again. Published addons, previous decisions and other sources are preserved.', action: 'Clear imports', danger: true })) return;
		busy = true; error = ''; message = '';
		try {
			const { data, error: failure } = await supabase.rpc('clear_pending_discord_imports');
			if (failure) throw failure;
			message = `${data} pending Discord imports cleared.`;
			await loadQueue();
		} catch (e) { error = (e as Error).message; }
		finally { busy = false; }
	}
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
		{#if pendingDiscord}
			<button class="btn mt-2" disabled={busy} onclick={clearPending}>Clear pending Discord imports</button>
		{/if}
		<p aria-live="polite" class={error ? 'text-danger' : 'text-accent'}>{busy ? 'Reading export…' : error || message}</p>
	</div>
{/if}
