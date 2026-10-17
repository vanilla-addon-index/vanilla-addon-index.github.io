<script lang="ts">
	import ResponsiveSidebar from '#lib/components/ResponsiveSidebar.svelte';
	import { commitCategoryOnFocus } from '#lib/category-select.ts';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { createAddon, fetchAddon, slugify, store, plainName, updateAddon } from '#lib/addons.svelte.ts';
	import { auth, canEdit } from '#lib/auth.svelte.ts';
	import AddonCard from '#lib/components/AddonCard.svelte';
	import { CATEGORIES, MAX_IMAGES, MAX_VERSIONS, SITE_NAME } from '#lib/config.ts';
	import { hostAllowed, hostNames } from '#lib/hosts.ts';
	import { linkKey } from '#lib/links.ts';
	import { loginHref } from '#lib/return.ts';
	import { isGithubRepo, readmeImages } from '#lib/github.ts';
	import { contributionAccess, contentOf, ownPendingEdit, proposeEdit, withdrawEdit, displayEditValue, FIELD_LABELS, type EditRequest, type EditField } from '#lib/edit-reviews.svelte.ts';
	import type { Addon, AddonInput } from '#lib/types.ts';

	// Must match the checks on addons.description in the schema migration and the import migration.
	const DESCRIPTION_MIN = 15;
	const DESCRIPTION_MAX = 5000;
	let fields = $state<HTMLDivElement>();
	function jump(id: string) {
		const target = fields?.querySelector<HTMLElement>(`#${id}`);
		if (!fields || !target) return;
		if (getComputedStyle(fields).overflowY === 'auto') {
			fields.scrollTo({ top: target.getBoundingClientRect().top - fields.getBoundingClientRect().top + fields.scrollTop });
		} else target.scrollIntoView({ block: 'start' });
	}

	const editSlug = page.url.searchParams.get('edit');
	const splitId = Number(page.url.searchParams.get('split'));
	const splitLink = page.url.searchParams.get('link') ?? '';
	const splitting = $derived(auth.isAdmin && splitId > 0 && splitLink ? { target: splitId, link: splitLink } : undefined);
	const editing = $derived(editSlug ? store.addons.find((a) => a.slug === editSlug) : undefined);

	let form = $state<AddonInput>({
		name: page.url.searchParams.get('name') ?? '',
		description: '',
		category: '',
		author: '',
		versions: [{ url: '', note: '' }],
		images: []
	});
	let error = $state('');
	let saving = $state(false);
	let filled = false;
	let canPropose = $state(false), reviewReady = $state(false), pending = $state<EditRequest | null>(null);
	let proposalBase = $state<AddonInput>();
	let accessAsked = '';
	const proposing = $derived(!!editing?.shared && !auth.isAdmin);
	$effect(() => {
		if (!editing?.shared || !auth.session) return;
		const key = editing.id + ':' + auth.session.user.id;
		if (accessAsked === key) return;
		accessAsked = key; canPropose = false; reviewReady = false; pending = null; filled = false;
		const user = auth.session.user.id;
		Promise.all([contributionAccess(editing.id), ownPendingEdit(editing.id)]).then(([access, request]) => {
			if (auth.session?.user.id !== user || accessAsked !== key) return;
			canPropose = access.can_propose; pending = request; reviewReady = true;
		}).catch(e => { error = e.message; reviewReady = true; });
	});
	async function withdraw() {
		if (!pending) return;
		try { await withdrawEdit(pending.id); pending = null; } catch(e) { error = (e as Error).message; }
	}
	// The addon's "updated" stamp when the form was filled; saving checks it has not moved.
	let since = '';

	// The list this browser holds can be a visit old, or a day old when it is the snapshot.
	// The form is filled from the addon as it is now: asked for once it is known who is
	// logged in, since a visitor is not told who posted it.
	let asked = false;
	let fresh = $state(!editSlug);
	$effect(() => {
		if (!editSlug || asked || !auth.ready) return;
		asked = true;
		fetchAddon(editSlug).finally(() => (fresh = true));
	});

	$effect(() => {
		if (!editing || filled || !fresh || (proposing && !reviewReady)) return;
		filled = true;
		since = editing.updated_at;
		proposalBase = contentOf(editing);
		const cleanPending = pending && Object.keys(pending.base).every(field => JSON.stringify(pending!.base[field as EditField]) === JSON.stringify(proposalBase![field as EditField]));
		const { name, description, category, author, versions, images } = { ...editing, ...(cleanPending ? pending?.changes : {}) };
		form = {
			name,
			description,
			category,
			author,
			versions: versions.length ? versions.map((v) => ({ ...v })) : [{url:'',note:''}],
			images: [...images]
		};
	});

	let splitFilled = false;
	$effect(() => {
		if (!splitting || splitFilled) return;
		const original = store.addons.find((a) => a.id === splitting.target);
		if (!original) return;
		splitFilled = true;
		form = { name: original.name, description: original.description, category: original.category, author: original.author, versions: [{url: splitting.link, note: ''}], images: [...original.images] };
	});

	const mainLink = $derived(form.versions[0]?.url ?? '');
	const matched = $derived(!editing && !splitting && plainName(form.name) ? store.addons.find((a) => plainName(a.name) === plainName(form.name)) : undefined);

	function removeVersion(index: number) {
		form.versions = form.versions.filter((_, i) => i !== index);
	}

	// A link that is already listed under another addon, checked as you type.
	const clash = $derived.by(() => {
		// Once posted, the new addon is in the list and would count as a clash with itself.
		if (saving) return undefined;
		const keys = form.versions.filter((v) => v.url.trim()).map((v) => linkKey(v.url));
		return store.addons.find(
			(a) => a.id !== editing?.id && a.id !== splitting?.target && a.versions.some((v) => keys.includes(linkKey(v.url)))
		);
	});

	let imageLink = $state('');
	let imageNote = $state('');
	let fetching = $state(false);
	let checking = $state(false);
	// Images the poster removed stay removed when the README is read again.
	const removed = new Set<string>();
	// Screenshots already on the addon whose link no longer shows a picture.
	let dead = $state<Record<string, boolean>>({});

	// A member's link and screenshots must be on a site known for hosting code or pictures;
	// an admin is not held to that, and what an addon already has stays. The database
	// decides; see the allowed hosts migration.
	const mayUse = (url: string, kind: 'link' | 'image') =>
		auth.isAdmin ||
		hostAllowed(url, kind) ||
		(kind === 'link' ? editing?.versions.some((v) => v.url === url) : editing?.images.includes(url)) === true;

	function addImages(urls: string[]) {
		const fresh = urls.filter((u) => !form.images.includes(u) && !removed.has(u) && mayUse(u, 'image'));
		form.images = [...form.images, ...fresh].slice(0, MAX_IMAGES);
		return fresh.length;
	}

	function removeImage(url: string) {
		removed.add(url);
		form.images = form.images.filter((u) => u !== url);
	}

	const loadsAsImage = (url: string) =>
		new Promise<boolean>((done) => {
			const probe = new Image();
			probe.referrerPolicy = 'no-referrer';
			probe.onload = () => done(true);
			probe.onerror = () => done(false);
			probe.src = url;
		});

	async function addImageLink() {
		let url = imageLink.trim();
		if (checking || !url) return;
		if (!/^https:\/\/\S+$/.test(url)) return (imageNote = 'Image links must start with https://');
		// Imgur's page for a single image has a direct address built from the same id.
		const imgur = /^https:\/\/(?:www\.)?imgur\.com\/(\w+)$/.exec(url);
		if (imgur) url = `https://i.imgur.com/${imgur[1]}.jpg`;
		if (!mayUse(url, 'image')) return (imageNote = `That link is on a site screenshots cannot be kept on. These can: ${hostNames('image')}.`);

		checking = true;
		const ok = await loadsAsImage(url);
		checking = false;
		if (!ok) {
			return (imageNote =
				'That link opens a web page or album, not an image. Right-click the image, choose "Copy image address" and paste that.');
		}
		removed.delete(url);
		addImages([url]);
		imageLink = '';
		imageNote = '';
	}

	async function fetchReadmeImages() {
		if (matched || !isGithubRepo(mainLink) || fetching) return;
		fetching = true;
		imageNote = '';
		try {
			const found = await readmeImages(mainLink);
			const added = addImages(found);
			imageNote = !found.length
				? 'No images found in the README.'
				: added
					? `Added ${added} from the README. Remove any you do not want.`
					: '';
		} catch {
			imageNote = 'Could not read the README from GitHub. Try again in a moment.';
		} finally {
			fetching = false;
		}
	}

	const descriptionLength = $derived(form.description.trim().length);

	const blocked = $derived.by(() => {
		if (!auth.ready || (editSlug && (!store.loaded || !fresh))) return 'Loading…';
		if (!auth.session) return 'You need to log in to post or edit addons.';
		if (editSlug && !editing) return 'That addon does not exist.';
		if (proposing && !reviewReady) return 'Loading contributor access…';
		if (editing && !canEdit(editing.owner) && !(proposing && canPropose)) return editing.shared ? 'Only the original owner and contributors can propose edits to this shared page.' : 'Only the person who posted this addon can edit it.';
		return '';
	});

	async function save(event: SubmitEvent) {
		event.preventDefault();
		error = '';
		// A pasted screenshot link that was never added with the button is added now.
		// It stays in the field when it is rejected, and the note under it says why.
		if (!matched && imageLink.trim() && form.images.length < MAX_IMAGES) {
			await addImageLink();
			if (imageLink.trim()) return;
		}
		const input = {
			...form,
			// Empty rows in the "other versions" list are dropped.
			versions: form.versions
				.map((v) => ({ ...v, url: v.url.trim(), note: v.note.trim() }))
				.filter((v, index) => v.url || (index === 0 && !editing?.shared))
		};
		if (!matched && descriptionLength < DESCRIPTION_MIN && !auth.isAdmin && (!editing?.shared || form.description !== editing.description)) {
			return (error = `The description needs at least ${DESCRIPTION_MIN} characters.`);
		}
		if (input.versions.some((v) => v.url && !mayUse(v.url, 'link'))) {
			return (error = `The link must be on one of these sites: ${hostNames('link')}. For an addon kept anywhere else, ask an admin to list it.`);
		}
		// The browser already insists on one; this covers a browser that does not.
		if (!matched && !input.category) return (error = 'Pick a category.');
		if (!editing && !slugify(input.name)) return (error = 'The name needs at least one letter or digit.');
		saving = true;
		try {
			if (proposing && editing && proposalBase) {
				await proposeEdit(editing.id, input, proposalBase);
				await goto(resolve('/addon/[slug]', {slug:editing.slug}) + '?proposed=1');
				return;
			}
			const addon = editing ? await updateAddon(editing.id, input, since) : await createAddon(matched ? { ...input, versions: [input.versions[0]] } : input, splitting);
			// "saving" stays on until the addon's page has replaced this one, so the form does
			// not flick back to its idle state on the way out.
			await goto(resolve('/addon/[slug]', { slug: addon.slug }));
		} catch (e) {
			error = (e as Error).message;
			saving = false;
		}
	}
</script>

<svelte:head>
	<title>{editSlug ? 'Edit addon' : 'Submit addon'} · {SITE_NAME}</title>
</svelte:head>

{#if auth.banned}
	<!-- The notice at the top of every page already says why. -->
{:else if blocked}
	<div class="panel mx-auto mt-8 max-w-sm p-5 text-center">
		<p class="text-muted">{blocked}</p>
		{#if auth.ready && !auth.session}
			<a href={loginHref(page.url)} class="btn btn-primary mt-4">Log in</a>
		{/if}
	</div>
{:else}
	<div class="page-workspace">
		<aside class="page-sidebar">
			<ResponsiveSidebar label="Submission guidance">
			<div class="panel">
			<div class="border-b border-border px-3 py-3">
				<h1 class="text-2xl leading-tight font-bold">{editing ? 'Edit addon' : 'Submit addon'}</h1>
				<p class="text-muted">{editing ? editing.name : 'Add one to the index'}</p>
			</div>
			<ul class="space-y-2 px-3 py-3 text-sm text-muted">
				<li>Name, link, category and description are <span class="text-accent">required</span>.</li>
				<li>Everything else is optional and helps players find the addon.</li>
				<li>You can edit your own addon's details directly. If it becomes part of a grouped entry, you can propose changes for admin review and remove your own links.</li>
				{#if !auth.isAdmin}
					<li>The link must be on one of: {hostNames('link')}.</li>
				{/if}
				<li>
					By posting you agree to the
					<a href={resolve('/about#rules')} class="underline hover:text-accent">rules for posting</a>.
				</li>
			</ul>
			</div>
		</ResponsiveSidebar>
		</aside>

		<form onsubmit={save} class="min-w-0 md:flex md:h-full md:min-h-0 md:flex-col">
			<div class="shrink-0 pb-2">
				<p class="flex min-h-[calc(1lh+0.75rem+2px)] items-center border border-transparent py-1.5 text-muted">{editing ? 'Update the details and check the preview before saving.' : 'Add the details and check the preview before posting.'}</p>
				<nav class="section-navigation panel mt-2 flex px-1" aria-label="Form sections">
					{#each [{ id: 'required-details', label: 'Required details' }, { id: 'optional-details', label: 'Optional details' }, { id: 'addon-preview', label: 'Preview' }] as section}
						<button type="button" class="min-w-0 flex-1 cursor-pointer px-2 py-0.5 text-center text-sm font-bold text-muted hover:bg-raised hover:text-accent" onclick={() => jump(section.id)}>{section.label}</button>
					{/each}
				</nav>
			</div>
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<div class="min-w-0 md:min-h-0 md:flex-1 md:overflow-y-auto md:overscroll-contain" bind:this={fields} role="region" aria-label="Addon details" tabindex="0">
            {#if proposing}<p class="panel mb-4 p-3 text-accent">Your edits go to an admin for review. The live page stays unchanged until accepted.</p>{/if}
            {#if proposing && pending}
                <div class="panel mb-4 p-3">
                    <p>You have an edit waiting for review. Saving replaces that proposal.</p>
                    {#if editing && Object.keys(pending.base).some(field => JSON.stringify(pending!.base[field as EditField]) !== JSON.stringify(editing![field as EditField]))}<p class="mt-2 text-accent">The page changed since your proposal. The form shows current values; review your pending changes below before submitting a revision.</p>{/if}
                    <details><summary class="cursor-pointer text-accent">See your pending changes</summary>
                        {#each Object.keys(pending.changes) as field}<p class="mt-2 break-words whitespace-pre-wrap"><strong>{FIELD_LABELS[field as EditField]}</strong>: {displayEditValue(pending.changes[field as EditField])}</p>{/each}
                    </details>
                    <button type="button" class="btn mt-2" onclick={withdraw}>Withdraw proposal</button>
                </div>
            {/if}
			{#if matched}<p class="panel mb-4 p-3 text-accent">{matched.name} already exists. Only your link will be added; edits to the shared page are reviewed by admins.</p>{/if}
			<h2 id="required-details" class="section-title text-accent">Required</h2>
			<p class="mb-2 text-muted">{matched ? 'Add a repository link to the existing page.' : 'The four things every entry needs.'}</p>
			<div class="panel space-y-4 border-accent/30 p-4">
				<div class="grid gap-4 sm:grid-cols-2">
					<div>
						<label class="field-label" for="name">Name</label>
						<input
							id="name"
							class="input"
							required
							minlength="2"
							maxlength="60"
							placeholder="As players know it"
							bind:value={form.name}
						/>
					</div>
					<div>
						<label class="field-label" for="repo">Link to the addon</label>
						<input
							id="repo"
							readonly={!!splitting}
							class="input"
							type="url"
							required={!editing?.shared}
							pattern="https://.*"
							placeholder="https://github.com/author/addon"
							bind:value={form.versions[0].url}
							onchange={fetchReadmeImages}
						/>
					</div>
					<div>
						<label class="field-label" for="category">Category</label>
						<select use:commitCategoryOnFocus id="category" class="input disabled:opacity-40" disabled={!!matched} required bind:value={form.category}>
							<!-- Placeholder: shown until a category is picked, not offered in the list. -->
							<option value="" hidden>Pick the one that fits best</option>
							{#each CATEGORIES as c (c)}
								<option value={c}>{c}</option>
							{/each}
						</select>
					</div>
				</div>
				{#if clash}
					<p class="text-danger">
						This link is already listed as
						<a href={resolve('/addon/[slug]', { slug: clash.slug })} class="underline">{clash.name}</a>.
					</p>
				{/if}
				<div>
					<div class="flex items-baseline justify-between">
						<label class="field-label" for="description">Description</label>
						<!-- What is still missing while it is too short, then how much room is left. -->
						<span class="text-sm text-muted">
							{#if descriptionLength < DESCRIPTION_MIN && !auth.isAdmin}
								At least {DESCRIPTION_MIN} characters · {DESCRIPTION_MIN - descriptionLength} to go
							{:else}
								{descriptionLength} / {DESCRIPTION_MAX}{auth.isAdmin && !descriptionLength ? ' · optional for admins' : ''}
							{/if}
						</span>
					</div>
					<textarea
						id="description"
						disabled={!!matched}
						class="input min-h-40 disabled:opacity-40"
						required={!auth.isAdmin && (!proposing || form.description !== editing?.description)}
						maxlength={DESCRIPTION_MAX}
						placeholder="What it does, main features, slash commands, installation notes…"
						bind:value={form.description}
					></textarea>
				</div>
			</div>

			<h2 id="optional-details" class="section-title mt-8">Optional</h2>
			<p class="mb-2 text-muted">Leave any of these empty.</p>
			<fieldset disabled={!!matched} class="panel space-y-4 p-4 disabled:opacity-40">
				<div class="grid gap-4 sm:grid-cols-2">
					<div>
						<label class="field-label" for="author">Addon author</label>
						<input
							id="author"
							class="input"
							maxlength="60"
							placeholder="If that is not you"
							bind:value={form.author}
						/>
					</div>
				</div>
				{#if form.versions.length > 1}
				<div>
					<div class="flex items-baseline justify-between">
						<span class="field-label">Extra links</span>
						<span class="text-sm text-muted">{form.versions.length - 1} / {MAX_VERSIONS - 1}</span>
					</div>
					{#if form.versions.length > 1}
						<input
							class="input mb-2"
							maxlength="80"
							placeholder="Note for the main link, for example: actively maintained"
							aria-label="Note for the main link"
							bind:value={form.versions[0].note}
						/>
					{/if}
					{#each form.versions as _, index (index)}
						{#if index > 0}
							<div class="mb-2 flex flex-wrap gap-2">
								<input
									class="input min-w-48 flex-[2]"
									type="url"
									pattern="https://.*"
									placeholder="https://gitlab.com/author/addon"
									aria-label="Mirror link {index}"
									bind:value={form.versions[index].url}
								/>
								<input
									class="input min-w-32 flex-1"
									maxlength="80"
									placeholder="Note, for example: GitLab mirror"
									aria-label="Note for mirror {index}"
									bind:value={form.versions[index].note}
								/>
								<button type="button" class="btn btn-danger" onclick={() => removeVersion(index)}>
									Remove
								</button>
							</div>
						{/if}
					{/each}
					<p class="hint">
						Links are ordered by their latest code update. Use Pin or Separate addon on the addon page to manage them.
					</p>
				</div>
				{/if}
				<div>
					<div class="flex items-baseline justify-between">
						<label class="field-label" for="image">Screenshots</label>
						<span class="text-sm text-muted">{form.images.length} / {MAX_IMAGES}</span>
					</div>
					{#if form.images.length}
						<ul class="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
							{#each form.images as image (image)}
								<li class="relative border border-border">
									{#if dead[image]}
										<!-- Said in words, where the browser would draw its broken-picture mark. -->
										<p class="grid aspect-video place-items-center px-3 pt-6 text-center text-sm text-danger">
											This link no longer shows a picture. Visitors do not see it; remove it or replace it.
										</p>
									{:else}
										<img
											src={image}
											alt=""
											referrerpolicy="no-referrer"
											class="aspect-video w-full object-contain"
											onerror={() => (dead[image] = true)}
										/>
									{/if}
									<button
										type="button"
										class="btn absolute top-1 right-1 bg-bg px-2 py-0.5 text-sm hover:border-danger/50 hover:text-danger"
										onclick={() => removeImage(image)}
									>
										Remove
									</button>
								</li>
							{/each}
						</ul>
					{/if}
					<div class="flex gap-2">
						<input
							id="image"
							class="input"
							type="url"
							placeholder="https://…/screenshot.png"
							disabled={form.images.length >= MAX_IMAGES}
							bind:value={imageLink}
							onkeydown={(e) => {
								if (e.key !== 'Enter') return;
								e.preventDefault();
								addImageLink();
							}}
						/>
						<button
							type="button"
							class="btn shrink-0"
							disabled={checking || !imageLink.trim() || form.images.length >= MAX_IMAGES}
							onclick={addImageLink}
						>
							{checking ? 'Checking…' : 'Add'}
						</button>
					</div>
					<p class={['hint', imageNote.startsWith('That link') && 'text-danger']}>
						{fetching
							? 'Reading the README…'
							: imageNote ||
								(auth.isAdmin
									? 'Images from a GitHub README are added automatically. You can also paste a link to an image.'
									: `Images from a GitHub README are added automatically. You can also paste a link to an image kept on one of: ${hostNames('image')}.`)}
					</p>
				</div>
			</fieldset>

			<h2 id="addon-preview" class="section-title mt-8">Preview</h2>
			<p class="mb-2 text-muted">How it will look in the list.</p>
			<div class="panel addon-list">
				<AddonCard
					preview
					addon={{
						slug: '',
						name: form.name,
						description: matched?.description ?? form.description,
						category: matched?.category ?? form.category,
						repo_url: mainLink
					}}
				/>
			</div>

			</div>
			<div class="shrink-0 pt-2">
				<div aria-live="polite">{#if error}<p class="mb-2 text-danger">{error}</p>{/if}</div>
			<div class="flex gap-2">
				<button class="btn btn-primary" disabled={saving}>
					{saving ? 'Saving…' : proposing ? 'Submit for review' : editing ? 'Save changes' : matched ? 'Add link' : splitting ? 'Separate addon' : 'Post addon'}
				</button>
				<a href={editing ? resolve('/addon/[slug]', { slug: editing.slug }) : resolve('/')} class="btn">
					Cancel
				</a>
			</div>
			</div>
		</form>
	</div>
{/if}
