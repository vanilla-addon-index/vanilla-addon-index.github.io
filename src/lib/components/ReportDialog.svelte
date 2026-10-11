<script lang="ts">
	import { NOTE_MAX, REASONS, reportAddon, type Reason } from '#lib/reports.svelte.ts';
	import type { Addon } from '#lib/types.ts';

	let { addon }: { addon: Pick<Addon, 'id' | 'name'> } = $props();

	let dialog = $state<HTMLDialogElement>();
	let reason = $state<Reason | ''>('');
	let note = $state('');
	let sending = $state(false);
	let sent = $state(false);
	let error = $state('');

	export function open() {
		reason = '';
		note = '';
		error = '';
		sent = false;
		dialog?.showModal();
	}

	async function send(event: SubmitEvent) {
		event.preventDefault();
		if (!reason) return;
		sending = true;
		error = '';
		try {
			await reportAddon(addon.id, reason, note);
			sent = true;
		} catch (e) {
			error = (e as Error).message;
		} finally {
			sending = false;
		}
	}
</script>

<!-- Escape and a click outside both close it. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
	bind:this={dialog}
	class="dialog w-[min(28rem,92vw)] p-4"
	aria-labelledby="report-title"
	onclick={(event) => event.target === dialog && dialog?.close()}
>
	<h2 id="report-title" class="text-xl leading-tight font-bold break-words">Report "{addon.name}"</h2>
	{#if sent}
		<p class="mt-2 text-muted">Thank you. An admin will take a look.</p>
		<div class="mt-4 flex justify-end">
			<button class="btn" onclick={() => dialog?.close()}>Close</button>
		</div>
	{:else}
		<form onsubmit={send}>
			<label class="field-label mt-3" for="report-reason">What is wrong with it?</label>
			<select id="report-reason" class="input" required bind:value={reason}>
				<option value="" hidden>Pick a reason</option>
				{#each Object.entries(REASONS) as [value, label] (value)}
					<option {value}>{label}</option>
				{/each}
			</select>
			<div class="mt-3 flex items-baseline justify-between">
				<label class="field-label" for="report-note">Details</label>
				<span class="text-sm text-muted">optional · {note.length} / {NOTE_MAX}</span>
			</div>
			<textarea
				id="report-note"
				class="input min-h-24"
				maxlength={NOTE_MAX}
				placeholder="Anything that helps an admin check it"
				bind:value={note}
			></textarea>
			{#if error}<p class="mt-2 text-danger">{error}</p>{/if}
			<div class="mt-4 flex justify-end gap-2">
				<button type="button" class="btn" onclick={() => dialog?.close()}>Cancel</button>
				<button class="btn btn-primary" disabled={sending || !reason}>{sending ? 'Sending…' : 'Send report'}</button>
			</div>
		</form>
	{/if}
</dialog>
