<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		deleteAddon,
		fetchAddon,
		findAddon,
		groupAddons,
		groupOf,
		setMain,
		store,
		suggestionsFor,
		ungroupAddon,
		type OwnSuggestion
	} from '#lib/addons.svelte.ts';
	import { auth, canEdit } from '#lib/auth.svelte.ts';
	import AddonPicker from '#lib/components/AddonPicker.svelte';
	import UserLink from '#lib/components/UserLink.svelte';
	import { SITE_NAME } from '#lib/config.ts';
	import { ask } from '#lib/confirm.svelte.ts';
	import { linkOwner } from '#lib/links.ts';
	import { addonTitle } from '#lib/seo.ts';
	import type { Addon } from '#lib/types.ts';
	import { WIKI, WIKI_PAGE } from '#lib/wiki.ts';

	const found = $derived(findAddon(page.params.slug));
	// While a delete is under way the addon is already gone from the list; the copy
	// taken just before keeps the page as it was until the next page replaces it.
	let kept = $state.raw<Addon>();
	let leaving = $state(false);
	const addon = $derived(leaving ? kept : found);
	const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });

	let error = $state('');

	// An addon the list does not have may have been posted since the daily snapshot was
	// taken: the database is asked for just that one before the page says "not found".
	let lookedUp = $state('');
	$effect(() => {
		const slug = page.params.slug;
		if (!slug || found || leaving || !store.loaded || lookedUp === slug) return;
		fetchAddon(slug).finally(() => (lookedUp = slug));
	});

	// The other versions of this addon, when it is in a group. Main version first.
	const group = $derived(addon ? groupOf(addon) : []);

	// What the poster suggested this addon is a version of, still waiting or turned down.
	// An accepted suggestion needs no note: the two are grouped, which the Versions list shows.
	let suggestions = $state<OwnSuggestion[]>([]);
	const addonId = $derived(addon?.id);
	$effect(() => {
		suggestions = [];
		const id = addonId;
		// Only someone logged in can have made one.
		if (id === undefined || !auth.session) return;
		suggestionsFor(id).then((list) => {
			if (id === addonId) suggestions = list.filter((s) => s.status !== 'accepted');
		});
	});

	// Group changes are small and reversible, so they happen at once, with no prompt.
	async function change(work: () => Promise<void>) {
		error = '';
		try {
			await work();
		} catch (e) {
			error = (e as Error).message;
		}
	}

	let viewer = $state<HTMLDialogElement>();
	// Index of the screenshot shown full size, -1 when the viewer is closed.
	let viewing = $state(-1);

	function view(index: number) {
		viewing = index;
		viewer?.showModal();
	}

	function step(event: KeyboardEvent) {
		const move = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
		const count = addon?.images.length ?? 0;
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

{#snippet fact(label: string, value: string)}
	<div class="flex justify-between gap-4 border-b border-border px-3 py-1.5 last:border-b-0">
		<dt class="text-muted">{label}</dt>
		<dd class="truncate">{value}</dd>
	</div>
{/snippet}

{#if addon}
	<a href={resolve('/')} class="text-muted hover:text-accent">← All addons</a>

	<article class="mt-3 grid items-start gap-4 md:grid-cols-[minmax(0,1fr)_16rem]">
		<div class="panel p-4">
			<h1 class="text-3xl font-bold">{addon.name}</h1>

			<div class="mt-3 flex flex-wrap gap-1.5">
				<a href={resolve(`/?cat=${encodeURIComponent(addon.category)}`)} class="chip">
					{addon.category}
				</a>
			</div>

			{#if addon.description}
				<p class="mt-4 leading-relaxed break-words whitespace-pre-line">{addon.description}</p>
			{/if}

			{#if addon.images.length}
				<!-- Five across, the most an addon can have, so the row always fits the panel. -->
				<ul class="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-5">
					{#each addon.images as image, index (image)}
						<li>
							<button
								class="block w-full cursor-zoom-in transition-opacity duration-100 hover:opacity-80"
								aria-label="View screenshot {index + 1} of {addon.name} full size"
								onclick={() => view(index)}
							>
								<!-- Linked images can disappear from their host; a broken one is hidden. -->
								<img
									src={image}
									alt=""
									loading="lazy"
									referrerpolicy="no-referrer"
									class="aspect-video w-full object-contain"
									onerror={(e) => (e.currentTarget as HTMLElement).closest('li')?.remove()}
								/>
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
			{#if addon.images[viewing]}
				<img
					src={addon.images[viewing]}
					alt="Screenshot {viewing + 1} of {addon.name}"
					referrerpolicy="no-referrer"
					class="max-h-[94vh] max-w-[94vw] object-contain"
				/>
			{/if}
		</dialog>

		<aside class="space-y-2">
			<div class="panel">
				<h2 class="label mb-0 px-3 pt-2">{addon.versions.length > 1 ? 'Links' : 'Link'}</h2>
				<!-- The main link first, then mirrors of the same code on other hosts. -->
				<ol>
					{#each addon.versions as version (version.url)}
						<li class="border-b border-border px-3 py-1.5 last:border-b-0">
							<a
								href={version.url}
								target="_blank"
								rel="noopener nofollow"
								class="break-all text-accent hover:underline"
							>
								{version.url}
							</a>
							{#if version.note}<p class="text-sm">{version.note}</p>{/if}
						</li>
					{/each}
				</ol>
			</div>

			{#if group.length > 1}
				<div class="panel">
					<h2 class="label mb-0 px-3 pt-2">Versions</h2>
					<!-- Every version of this addon. The first is the one most people should use. -->
					<ol>
						{#each group as member (member.id)}
							{@const here = member.id === addon.id}
							<li class={['border-b border-border px-3 py-1.5 last:border-b-0', !member.is_main && !here && 'opacity-70']}>
								<div class="flex items-baseline gap-2">
									{#if here}
										<span class="min-w-0 flex-1 truncate font-bold">{member.name}</span>
									{:else}
										<a
											href={resolve('/addon/[slug]', { slug: member.slug })}
											class="min-w-0 flex-1 truncate hover:text-accent"
										>
											{member.name}
										</a>
									{/if}
									{#if member.is_main}<span class="shrink-0 text-sm text-accent">Main</span>{/if}
								</div>
								<p class="truncate text-sm text-muted">
									{linkOwner(member.repo_url)}{here ? ' · you are here' : ''}
								</p>
								{#if auth.isAdmin}
									<div class="mt-1 flex flex-wrap gap-2">
										{#if !member.is_main}
											<button class="btn px-2 py-0.5 text-sm" onclick={() => change(() => setMain(member.id))}>
												Make main
											</button>
										{/if}
										<button class="btn px-2 py-0.5 text-sm" onclick={() => change(() => ungroupAddon(member.id))}>
											Remove from group
										</button>
									</div>
								{/if}
							</li>
						{/each}
					</ol>
				</div>
			{/if}

			<dl class="panel">
				{#if addon.author}{@render fact('Author', addon.author)}{/if}
				<!-- Who added the entry is for admins: to visitors the author is the name that matters. -->
				{#if auth.isAdmin && addon.owner_name}
					<div class="flex justify-between gap-4 border-b border-border px-3 py-1.5 last:border-b-0">
						<dt class="text-muted">Posted by</dt>
						<dd class="truncate"><UserLink name={addon.owner_name} /></dd>
					</div>
				{/if}
				{@render fact('Added', date(addon.created_at))}
				{@render fact('Updated', date(addon.updated_at))}
			</dl>
			{#if addon.source}
				<!-- Wiki text is CC BY-SA, which asks for this credit. -->
				<p class="text-sm text-muted">
					Imported from the
					<a
						href="{WIKI}/wiki/{WIKI_PAGE}"
						target="_blank"
						rel="noopener"
						class="underline hover:text-accent">{addon.source}</a
					>, CC BY-SA.
				</p>
			{/if}

			{#each suggestions as suggestion (suggestion.target_id)}
				{@const target = store.addons.find((a) => a.id === suggestion.target_id)}
				{#if target}
					<p class="panel px-3 py-2 text-sm">
						Suggested as a version of
						<a href={resolve('/addon/[slug]', { slug: target.slug })} class="text-accent hover:underline"
							>{target.name}</a
						>.
						<span class="text-muted">
							{suggestion.status === 'pending'
								? 'Waiting for an admin to review it.'
								: 'An admin decided to keep them separate.'}
						</span>
					</p>
				{/if}
			{/each}

			{#if canEdit(addon.owner)}
				<div class="grid grid-cols-2 gap-2">
					<a href={resolve(`/submit?edit=${addon.slug}`)} class="btn">Edit</a>
					<button class="btn btn-danger" onclick={remove}>Delete</button>
				</div>
			{/if}
			{#if auth.isAdmin}
				<!-- The addon found here joins this one's group; this one's main version stays main. -->
				<AddonPicker
					placeholder="Group with another addon…"
					exclude={(other) => group.some((member) => member.id === other.id)}
					onpick={(other) => change(() => groupAddons([addon.id, other.id]))}
				/>
			{/if}
			{#if error}<p class="text-danger">{error}</p>{/if}
		</aside>
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
