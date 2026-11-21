<script lang="ts">
	import { resolve } from '$app/paths';
	import { ACTION_TEXT, loadLog, type LogEntry } from '#lib/admin.ts';

	let { addonId, entryId, when }: {
		addonId: number;
		entryId: number;
		when: (at: string) => string;
	} = $props();

	const visibleCount = 5;
	let entries = $state<LogEntry[]>();
	let loading = $state(false);
	let error = $state('');

	async function showHistory() {
		if (entries || loading) return;
		loading = true;
		error = '';
		try {
			const recent = await loadLog({ addonId }, undefined, visibleCount + 1);
			entries = recent.filter(entry => entry.id !== entryId).slice(0, visibleCount);
		} catch (e) {
			error = (e as Error).message;
		} finally {
			loading = false;
		}
	}
</script>

<details class="border-t border-border pt-2 text-sm" ontoggle={event => { if (event.currentTarget.open) void showHistory(); }}>
	<summary class="cursor-pointer font-semibold hover:text-accent">Addon history</summary>
	{#if loading}
		<p class="mt-2 text-muted" role="status">Loading addon history…</p>
	{:else if error}
		<p class="mt-2 text-danger" role="alert">{error}</p>
		<button type="button" class="btn mt-2 py-1" onclick={showHistory}>Retry</button>
	{:else if entries?.length}
		<ul class="mt-2 divide-y divide-border border border-border">
			{#each entries as entry (entry.id)}
				<li>
					<a href={resolve(`/admin/log?entry=${entry.id}#log-${entry.id}`)} class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-2.5 py-1.5 hover:bg-raised hover:text-accent">
						<span class="min-w-0 [overflow-wrap:anywhere]">
							<span class="font-semibold">{entry.actor_name ?? 'The system'}</span>
							{ACTION_TEXT[entry.action] ?? entry.action} {entry.subject}
						</span>
						<time datetime={entry.at} class="text-xs text-muted tabular-nums">{when(entry.at)}</time>
					</a>
				</li>
			{/each}
		</ul>
	{:else if entries}
		<p class="mt-2 text-muted">No other entries for this addon.</p>
	{/if}
	<a href={resolve(`/admin/log?addon=${addonId}`)} class="mt-2 inline-block text-accent hover:underline">View full history</a>
</details>
