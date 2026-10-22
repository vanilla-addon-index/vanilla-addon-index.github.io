<script lang="ts">
	import { tick } from 'svelte';
	import { auth } from '#lib/auth.svelte.ts';
	import { loadAddons } from '#lib/addons.svelte.ts';
	import { requestLink, ownLinkRequests, withdrawLink, type LinkRequest } from '#lib/link-reviews.svelte.ts';
	import { hostAllowed, hostNames } from '#lib/hosts.ts';
	import { linkError } from '#lib/link-validation.ts';
	let { addonId, hasLinks }: { addonId: number; hasLinks: boolean } = $props();
	let open = $state(false), url = $state(''), busy = $state(false), error = $state(''), message = $state('');
	let input = $state<HTMLInputElement>();
	let pending = $state<Pick<LinkRequest, 'id' | 'url'>[]>([]);
	let invalid = $state('');
	function validate(value = url) {
		invalid = linkError(value) || (!auth.isAdmin && !hostAllowed(value.trim(), 'link') ? `Use a repository link from ${hostNames('link')}.` : '');
		return !invalid;
	}
	$effect(() => {
		const target = addonId;
		let current = true;
		if (!auth.isAdmin) ownLinkRequests(target).then(rows => { if (current) pending = rows; }).catch(e => { if (current) error = e.message; });
		return () => { current = false; };
	});
	async function withdraw(id: number) {
		busy = true; error = '';
		try { await withdrawLink(id); pending = pending.filter(r => r.id !== id); }
		catch (e) { error = (e as Error).message; }
		finally { busy = false; }
	}
	async function show() {
		open = true; error = ''; message = '';
		await tick(); input?.focus();
	}
	async function submit(event: SubmitEvent) {
		event.preventDefault(); error = ''; message = '';
		const link = url.trim();
		if (!validate()) { input?.focus(); return; }
		busy = true;
		try {
			await requestLink(addonId, link);
			if (auth.isAdmin) { await loadAddons(); message = 'Link added.'; }
			else pending = await ownLinkRequests(addonId);
			url = ''; open = false;
		} catch (e) { error = (e as Error).message; }
		finally { busy = false; }
	}
</script>

{#if open}
	<form class="panel space-y-2 p-3" onsubmit={submit}>
		<label class="block" for="additional-addon-link">Repository link</label>
		<input bind:this={input} id="additional-addon-link" class={['input w-full', invalid && 'border-danger']} type="url" required maxlength="300" placeholder="https://github.com/author/addon" bind:value={url} disabled={busy}
			aria-invalid={!!invalid} aria-describedby={invalid ? 'additional-link-error' : undefined}
			oninvalid={(event) => { event.preventDefault(); validate(); input?.focus(); }}
			onblur={() => { if (url.trim()) validate(); }} oninput={(event) => { if (invalid) validate(event.currentTarget.value); }} />
		{#if invalid}<p id="additional-link-error" class="text-sm text-danger" role="alert">{invalid}</p>{/if}
		{#if !auth.isAdmin}<p class="text-sm text-muted">An admin will review your link before it appears here.</p>{/if}
		{#if error}<p class="text-sm text-danger" role="alert">{error}</p>{/if}
		<div class="flex gap-2">
			<button class="btn btn-primary" disabled={busy}>{busy ? 'Submitting…' : auth.isAdmin ? 'Add link' : 'Submit for review'}</button>
			<button class="btn" type="button" disabled={busy} onclick={() => { open = false; error = ''; }}>Cancel</button>
		</div>
	</form>
{:else}
	<button class="btn w-full" onclick={show}>{hasLinks ? 'Add another link' : 'Add a link'}</button>
{/if}
{#if message}<p class="panel px-3 py-2 text-sm text-accent" role="status">{message}</p>{/if}
{#if error && !open}<p class="panel px-3 py-2 text-sm text-danger" role="alert">{error}</p>{/if}
{#each pending as request (request.id)}
	<div class="panel space-y-2 p-3 text-sm">
		<p role="status">Your link is waiting for admin review.</p>
		<p class="break-all text-muted">{request.url}</p>
		<button class="btn" disabled={busy} onclick={() => withdraw(request.id)}>Withdraw link</button>
	</div>
{/each}
