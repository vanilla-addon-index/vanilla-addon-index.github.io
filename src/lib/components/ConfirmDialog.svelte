<script lang="ts">
	import { prompt } from '#lib/confirm.svelte.ts';

	let dialog = $state<HTMLDialogElement>();

	$effect(() => {
		if (prompt.open && !dialog?.open) dialog?.showModal();
	});

	function answer(confirmed: boolean) {
		const question = prompt.open;
		prompt.open = null;
		dialog?.close();
		question?.answer(confirmed);
	}
</script>

<!-- Escape and a click outside both decline. Cancel is first, so it has the focus:
     pressing Enter by reflex never confirms something destructive. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
	bind:this={dialog}
	class="dialog w-[min(28rem,92vw)] p-4"
	aria-labelledby="confirm-title"
	oncancel={(event) => {
		event.preventDefault();
		answer(false);
	}}
	onclick={(event) => event.target === dialog && answer(false)}
>
	{#if prompt.open}
		<h2 id="confirm-title" class="text-xl leading-tight font-bold break-words">{prompt.open.title}</h2>
		{#if prompt.open.body}
			<p class="mt-2 break-words whitespace-pre-line text-muted">{prompt.open.body}</p>
		{/if}
		<div class="mt-4 flex justify-end gap-2">
			<button class="btn" onclick={() => answer(false)}>Cancel</button>
			<button class={['btn', prompt.open.danger ? 'btn-danger' : 'btn-primary']} onclick={() => answer(true)}>
				{prompt.open.action}
			</button>
		</div>
	{/if}
</dialog>
