<script lang="ts">
	import { wikiThanks } from '#lib/wiki-submission.svelte.ts';
	import { wikiSubmission } from '#lib/wiki-submission.ts';
	let dialog = $state<HTMLDialogElement>();
	let code = $state<HTMLTextAreaElement>();
	let copied = $state(false);
	let copyError = $state('');
	const entry = $derived(wikiThanks.addon ? wikiSubmission(wikiThanks.addon) : null);
	$effect(() => { if (entry && !dialog?.open) { copied = false; copyError = ''; dialog?.showModal(); } });
	function close() { dialog?.close(); wikiThanks.addon = null; }
	function closeOutside(event: MouseEvent) {
		if (event.target !== dialog || !dialog) return;
		const bounds = dialog.getBoundingClientRect();
		if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
	}
	async function copy() {
		if (!entry) return;
		try { await navigator.clipboard.writeText(entry.markup); copied = true; copyError = ''; }
		catch { code?.focus(); code?.select(); copyError = 'Could not copy automatically. The entry is selected so you can copy it manually.'; }
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog bind:this={dialog} class="wiki-dialog" aria-labelledby="wiki-thanks-title" oncancel={(event) => event.preventDefault()} onclick={closeOutside}>
	{#if entry}
		<div class="flex items-start justify-between gap-4">
			<h2 id="wiki-thanks-title" class="text-2xl font-bold">Addon submitted successfully!</h2>
			<button type="button" class="btn shrink-0" aria-label="Close wiki helper" onclick={close}>✕</button>
		</div>
		<p class="mt-3 text-accent">Help more players discover your addon by adding it to the <span class="text-[#a3d631]">Turtle WoW Wiki</span>.</p>
		<p class="mt-2 text-sm text-muted">This post is saved here. It is not automatically sent to the wiki. To add it there, sign in with a Fandom account, check whether it is already listed, then edit the section and paste the entry in source mode after the new line’s bullet before saving. The copied entry leaves out the bullet because the wiki adds it for you.</p>
		<div class="mt-5 flex items-center justify-between gap-3">
			<label for="wiki-entry" class="font-bold">Wiki entry <span class="text-sm font-normal text-muted">(wikitext)</span></label>
			<button type="button" class="btn" onclick={copy}>{copied ? 'Copied!' : 'Copy wiki entry'}</button>
		</div>
		<textarea bind:this={code} id="wiki-entry" class="mt-2 w-full resize-y border border-border bg-surface p-3 font-mono text-sm" rows="4" readonly value={entry.markup}></textarea>
		<p aria-live="polite" class="mt-1 text-sm text-muted">{copyError || (copied ? 'Wiki entry copied to clipboard.' : '')}</p>
		<h3 class="mt-4 font-bold">Wiki preview</h3>
		<div class="wiki-preview mt-2">
			<ul><li><a href={entry.url} target="_blank" rel="noopener noreferrer">{entry.name}</a> - {entry.description}{#each entry.images as image, i}{' '}<a href={image} target="_blank" rel="noopener noreferrer">[Img{i + 1}]</a>{/each}</li></ul>
		</div>
		<div class="mt-5 flex flex-wrap justify-end gap-2">
			<a class="btn btn-primary" href={entry.href} target="_blank" rel="noopener noreferrer">Open wiki editor ↗</a>
		</div>
	{/if}
</dialog>

<style>
	.wiki-dialog { margin: auto; width: min(46rem, 94vw); max-height: 90dvh; overflow-y: auto; padding: 1.5rem; border: 1px solid var(--color-border); background: var(--color-bg); color: var(--color-fg); }
	.wiki-dialog::backdrop { background: rgb(0 0 0 / 75%); }
	.wiki-preview { background: #161310; color: #e6e6e6; padding: 1rem 1.25rem; font: 16px/1.75 Arial, sans-serif; overflow-wrap: anywhere; }
	.wiki-preview ul { list-style: disc; padding-left: 1.25rem; margin: 0; }
	.wiki-preview a { color: #a3d631; text-decoration: none; }
	.wiki-preview a:hover { text-decoration: underline; }
</style>
