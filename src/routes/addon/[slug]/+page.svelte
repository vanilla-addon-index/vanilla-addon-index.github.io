<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		deleteAddon,
		fetchAddon,
		findAddon,
		store, pinLink, mergeAddons,
	} from '#lib/addons.svelte.ts';
	import { contributionAccess, ownPendingEdit, removeOwnLink, withdrawEdit, type ContributionAccess, type EditRequest } from '#lib/edit-reviews.svelte.ts';
	import { auth, canEdit } from '#lib/auth.svelte.ts';
	import AddonPicker from '#lib/components/AddonPicker.svelte';
	import FavoriteButton from '#lib/components/FavoriteButton.svelte';
	import ReportDialog from '#lib/components/ReportDialog.svelte';
	import UserLink from '#lib/components/UserLink.svelte';
	import { SITE_NAME } from '#lib/config.ts';
	import { ask } from '#lib/confirm.svelte.ts';
	import { linkAuthor } from '#lib/links.ts';
	import { loginHref } from '#lib/return.ts';
	import { addonTitle } from '#lib/seo.ts';
	import type { Addon } from '#lib/types.ts';

	const found = $derived(findAddon(page.params.slug));
	// While a delete is under way the addon is already gone from the list; the copy
	// taken just before keeps the page as it was until the next page replaces it.
	let kept = $state.raw<Addon>();
	let leaving = $state(false);
	const addon = $derived(leaving ? kept : found);
	const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' });

	let error = $state('');
	let report = $state<ReturnType<typeof ReportDialog>>();

	// An addon the list does not have may have been posted since the daily snapshot was
	// taken: the database is asked for just that one before the page says "not found".
	let lookedUp = $state('');
	$effect(() => {
		const slug = page.params.slug;
		if (!slug || found || leaving || !store.loaded || lookedUp === slug) return;
		fetchAddon(slug).finally(() => (lookedUp = slug));
	});

	let access=$state<ContributionAccess>({can_propose:false,links:[]}), pending=$state<EditRequest|null>(null);
	let accessKey='';
	async function refreshAccess() {
		if (!addon?.shared || !auth.session || auth.banned) return;
		const id=addon.id, user=auth.session.user.id;
		const [result,request]=await Promise.all([contributionAccess(id),ownPendingEdit(id)]);
		if(addon?.id===id && auth.session?.user.id===user && !auth.banned){access=result;pending=request;}
	}
	$effect(()=>{
		const key=(addon?.id??'')+':'+(auth.session?.user.id??'')+':'+!!auth.banned;
		if(accessKey===key)return;
		accessKey=key;access={can_propose:false,links:[]};pending=null;
		refreshAccess().catch(e=>error=e.message);
	});
	async function removeLink(link:string) {
		if(!addon)return;
		const confirmed=await ask({title:'Remove your link?',body:'The shared page stays available, even if this is its last link. An admin can undo the removal in History.',action:'Remove my link',danger:true});
		if(!confirmed)return;
		await change(async()=>{await removeOwnLink(addon.id,link);await refreshAccess();});
	}
	async function withdraw() {
		if(!pending)return;
		await change(async()=>{await withdrawEdit(pending!.id);pending=null;});
	}

	// Group changes are small and reversible, so they happen at once, with no prompt.
	async function change(work: () => Promise<void>) {
		error = '';
		try {
			await work();
		} catch (e) {
			error = (e as Error).message;
		}
	}

	// The screenshots that load, in the order they were given. Linked pictures disappear
	// from their hosts, so each one is tried before any is shown: a dead one never takes a
	// place, and the ones that work start where they will stay instead of moving up when
	// the dead one is found out.
	let shots = $state<string[]>([]);
	const wanted = $derived((addon?.images ?? []).join('\n'));
	$effect(() => {
		const images = wanted ? wanted.split('\n') : [];
		shots = [];
		if (!images.length) return;
		let current = true;
		const loaded = new Set<string>();
		let waiting = images.length;
		let shown = false;
		const show = () => {
			shown = true;
			if (current) shots = images.filter((image) => loaded.has(image));
		};
		// A host that neither answers nor refuses must not hold the others back for long.
		const patience = setTimeout(show, 3000);
		for (const image of images) {
			const probe = new Image();
			probe.referrerPolicy = 'no-referrer';
			const settle = (ok: boolean) => {
				if (ok) loaded.add(image);
				waiting--;
				// All of them have answered, or one has come in after the others were shown.
				if (!waiting || shown) show();
			};
			probe.onload = () => settle(true);
			probe.onerror = () => settle(false);
			probe.src = image;
		}
		return () => {
			current = false;
			clearTimeout(patience);
		};
	});

	let viewer = $state<HTMLDialogElement>();
	// Index of the screenshot shown full size, -1 when the viewer is closed.
	let viewing = $state(-1);

	function view(index: number) {
		viewing = index;
		viewer?.showModal();
	}

	function step(event: KeyboardEvent) {
		const move = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
		const count = shots.length;
		if (move && count) viewing = (viewing + move + count) % count;
	}

	async function remove() {
		if (!addon) return;
		const confirmed = await ask({
			title: `Delete "${addon.name}"?`,
			body: 'It goes to the trash, where an admin can restore it for 90 days.',
			action: 'Delete',
			danger: true
		});
		if (!confirmed) return;
		kept = addon;
		leaving = true;
		try {
			await deleteAddon(addon.id);
			await goto(resolve('/'));
		} catch (e) {
			error = (e as Error).message;
			leaving = false;
		}
	}
</script>

<svelte:head>
	<title>{addon ? addonTitle(addon) : SITE_NAME}</title>
</svelte:head>

{#if addon}
	<a href={resolve('/')} class="text-muted hover:text-accent">← All addons</a>

	<article class="mt-3 grid items-start gap-4 md:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_22rem]">
		<div class="panel p-4">
			<h1 class="text-3xl font-bold">{addon.name}</h1>

			<div class="mt-3 flex flex-wrap gap-1.5">
				<a href={resolve(`/?cat=${encodeURIComponent(addon.category)}`)} class="chip">
					{addon.category}
				</a>
			</div>

			{#if addon.description}
				<p class="mt-4 font-read text-[0.9rem] leading-relaxed break-words whitespace-pre-line">{addon.description}</p>
			{/if}

			{#if shots.length}
				<!-- Five across, the most an addon can have, so the row always fits the panel. -->
				<ul class="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-5">
					{#each shots as image, index (image)}
						<li>
							<button
								class="block w-full cursor-zoom-in transition-opacity duration-100 hover:opacity-80"
								aria-label="View screenshot {index + 1} of {addon.name} full size"
								onclick={() => view(index)}
							>
								<!-- Already loaded once, above, so it is drawn at once. -->
								<img src={image} alt="" referrerpolicy="no-referrer" class="aspect-video w-full object-contain" />
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>


		<!-- Full-size viewer. Escape or a click closes it; the arrow keys step through. -->
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
		<dialog
			bind:this={viewer}
			class="m-auto max-h-[94vh] max-w-[94vw] cursor-zoom-out border border-border bg-bg p-0 backdrop:bg-black/85"
			onclick={() => viewer?.close()}
			onclose={() => (viewing = -1)}
			onkeydown={step}
		>
			{#if shots[viewing]}
				<img
					src={shots[viewing]}
					alt="Screenshot {viewing + 1} of {addon.name}"
					referrerpolicy="no-referrer"
					class="max-h-[94vh] max-w-[94vw] object-contain"
				/>
			{/if}
		</dialog>

		<aside class="space-y-2">
			<div class="panel">
				<!-- Pinned link first, otherwise newest known code update. -->
				{#if !addon.versions.length}<p class="px-3 py-3 text-muted">No download links currently listed.</p>{/if}
				<ol>
					{#each addon.versions as version (version.url)}
						{@const update = addon.link_code_updates?.[version.url] ?? (version.url === addon.repo_url ? addon.code_update : null)}
						<li class="border-b border-border px-3 py-3 last:border-b-0">
							<a
								href={version.url}
								target="_blank"
								rel="noopener nofollow"
								class="break-all text-accent hover:underline"
							>
								{version.url}
							</a>
							{#if version.note}<p class="text-sm">{version.note}</p>{/if}
                            <dl class="mt-2 space-y-1 text-sm">
                                <div class="flex justify-between gap-4"><dt class="shrink-0 text-muted">Author</dt><dd class="min-w-0 break-words text-right">{(!addon.shared ? addon.author : '') || linkAuthor(version.url) || 'Unknown'}</dd></div>
                                <div class="flex justify-between gap-4"><dt class="shrink-0 text-muted">Last update</dt><dd>
                                    {#if update}<a href={update.url} target="_blank" rel="noopener noreferrer" class="text-accent hover:underline" title="View commit history"><time datetime={update.date}>{date(update.date)}</time></a>
                                    {:else}<span class="text-muted">Unknown</span>{/if}
                                </dd></div>
                            </dl>
                            {#if addon.pinned_link === version.url}<span class="text-sm text-accent">Pinned</span>{/if}
                            {#if auth.session && !auth.isAdmin && !auth.banned && access.links.includes(version.url)}<button class="btn mt-1 px-2 py-0.5 text-sm" onclick={()=>removeLink(version.url)}>Remove my link</button>{/if}
						</li>
					{/each}
				</ol>
			</div>

            {#if addon.shared}<p class="panel px-3 py-2 text-sm text-muted">This is a shared page. Original owners and contributors can propose edits for admin review.</p>{/if}
			<FavoriteButton addonId={addon.id} />
            {#if auth.session && !auth.banned}<a class="btn w-full" href={resolve('/submit') + '?name=' + encodeURIComponent(addon.name)}>{addon.versions.length ? 'Add another link' : 'Add a link'}</a>{/if}
            {#if auth.session && addon.shared && access.can_propose && !auth.isAdmin}<a class="btn w-full" href={resolve('/submit')+'?edit='+addon.slug}>Propose edits</a>{/if}
            {#if auth.session && pending && !auth.isAdmin}<div class="panel px-3 py-2 text-sm"><p>Your edit is waiting for admin review.</p><button class="btn mt-2" onclick={withdraw}>Withdraw proposal</button></div>{/if}
			{#snippet editControls()}
				<div class="grid grid-cols-2 gap-2">
					<a href={resolve(`/submit?edit=${addon.slug}`)} class="btn">Edit</a>
					<button class="btn btn-danger" onclick={remove}>Delete</button>
				</div>
			{/snippet}
			{#if !auth.isAdmin && canEdit(addon.owner)}
				{@render editControls()}
			{/if}

			<!-- For anyone who spots a dead link or something harmful. Reporting needs an
			     account, so a visitor is sent to log in first. -->
			{#if !auth.banned}
				<p class="pr-[calc(0.75rem+1px)] text-right text-sm">
					{#if auth.session}
						<button class="cursor-pointer text-muted hover:text-accent hover:underline" onclick={() => report?.open()}>
							Report this addon
						</button>
					{:else}
						<a href={loginHref(page.url)} class="text-muted hover:text-accent hover:underline">Log in to report this addon</a>
					{/if}
				</p>
			{/if}
			{#if auth.isAdmin}
				<section aria-label="Admin controls" class="mt-4 space-y-2 border-t border-border pt-3">
					<h2 class="label">Admin controls</h2>
					{#if addon.owner_name}
						<dl class="flex justify-between gap-4 text-sm"><dt class="text-muted">Posted by</dt><dd class="truncate"><UserLink name={addon.owner_name} /></dd></dl>
					{/if}
					{#if canEdit(addon.owner)}{@render editControls()}{/if}
					<a href={resolve(`/admin/log?addon=${addon.id}`)} class="btn w-full">History</a>
					<AddonPicker
						placeholder="Merge another addon’s links here…"
						exclude={(other) => other.id === addon.id}
						onpick={(other) => change(() => mergeAddons(other.id, addon.id))}
					/>
					{#each addon.versions as version (version.url)}
						<div class="space-y-1 border-t border-border pt-2" data-link-controls>
							<p class="break-all text-sm text-muted">{version.url}</p>
							<div class="flex flex-wrap gap-2">
								<button class="btn px-2 py-0.5 text-sm" onclick={() => change(() => pinLink(addon.id, addon.pinned_link === version.url ? null : version.url))}>{addon.pinned_link === version.url ? 'Unpin' : 'Pin'}</button>
								{#if addon.versions.length > 1}<a class="btn px-2 py-0.5 text-sm" href={resolve('/submit') + '?split=' + addon.id + '&link=' + encodeURIComponent(version.url)}>Separate addon</a>{/if}
							</div>
						</div>
					{/each}
				</section>
			{/if}
			{#if error}<p class="text-danger">{error}</p>{/if}
		</aside>
		<ReportDialog bind:this={report} {addon} />
	</article>
{:else if store.loaded && lookedUp === page.params.slug}
	<div class="py-16 text-center">
		<h1 class="text-2xl font-bold">Addon not found</h1>
		<p class="mt-2 text-muted">It may have been renamed or removed.</p>
		<a href={resolve('/')} class="btn mt-6">Browse all addons</a>
	</div>
{:else}
	<p class="py-12 text-center text-muted">Loading…</p>
{/if}
