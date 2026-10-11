<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { createAddon, slugify, store, suggestGroup, updateAddon } from '#lib/addons.svelte.ts';
	import { auth, canEdit } from '#lib/auth.svelte.ts';
	import AddonCard from '#lib/components/AddonCard.svelte';
	import AddonPicker from '#lib/components/AddonPicker.svelte';
	import { CATEGORIES, MAX_IMAGES, MAX_VERSIONS, SITE_NAME } from '#lib/config.ts';
	import { linkKey } from '#lib/links.ts';
	import { isGithubRepo, readmeImages } from '#lib/github.ts';
	import type { Addon, AddonInput } from '#lib/types.ts';

	const SUMMARY_MAX = 160;
	// Must match the check on addons.description in supabase/schema.sql.
	const DESCRIPTION_MIN = 15;

	const editSlug = page.url.searchParams.get('edit');
	const editing = $derived(editSlug ? store.addons.find((a) => a.slug === editSlug) : undefined);

	let form = $state<AddonInput>({
		name: '',
		summary: '',
		description: '',
		category: '',
		author: '',
		versions: [{ url: '', note: '' }],
		images: []
	});
	let error = $state('');
	let saving = $state(false);
	let filled = false;

	// The addon list may arrive after this page mounts, so fill the form once it is there.
	$effect(() => {
		if (!editing || filled) return;
		filled = true;
		const { name, summary, description, category, author, versions, images } = editing;
		form = {
			name,
			summary,
			description,
			category,
			author,
			versions: versions.map((v) => ({ ...v })),
			images: [...images]
		};
	});

	const mainLink = $derived(form.versions[0].url);

	// The addon the poster says this one is a version of. It is only a suggestion: an
	// admin decides whether the two are grouped.
	let versionOf = $state<Addon>();

	function removeVersion(index: number) {
		form.versions = form.versions.filter((_, i) => i !== index);
	}

	// Position 0 is the main link, so moving the second entry up makes it the main one.
	function moveVersion(index: number, by: -1 | 1) {
		const next = [...form.versions];
		[next[index], next[index + by]] = [next[index + by], next[index]];
		form.versions = next;
	}

	// A link that is already listed under another addon, checked as you type.
	const clash = $derived.by(() => {
		// Once posted, the new addon is in the list and would count as a clash with itself.
		if (saving) return undefined;
		const keys = form.versions.filter((v) => v.url.trim()).map((v) => linkKey(v.url));
		return store.addons.find(
			(a) => a.id !== editing?.id && a.versions.some((v) => keys.includes(linkKey(v.url)))
		);
	});

	let imageLink = $state('');
	let imageNote = $state('');
	let fetching = $state(false);
	let checking = $state(false);
	// Images the poster removed stay removed when the README is read again.
	const removed = new Set<string>();

	function addImages(urls: string[]) {
		const fresh = urls.filter((u) => !form.images.includes(u) && !removed.has(u));
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
		if (!isGithubRepo(mainLink) || fetching) return;
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
		if (!auth.ready || (editSlug && !store.loaded)) return 'Loading…';
		if (!auth.session) return 'You need to log in to post or edit addons.';
		if (editSlug && !editing) return 'That addon does not exist.';
		if (editing && !canEdit(editing.owner)) return 'Only the person who posted this addon can edit it.';
		return '';
	});

	async function save(event: SubmitEvent) {
		event.preventDefault();
		error = '';
		// A pasted screenshot link that was never added with the button is added now.
		// It stays in the field when it is rejected, and the note under it says why.
		if (imageLink.trim() && form.images.length < MAX_IMAGES) {
			await addImageLink();
			if (imageLink.trim()) return;
		}
		const input = {
			...form,
			// Empty rows in the "other versions" list are dropped.
			versions: form.versions
				.map((v) => ({ ...v, url: v.url.trim(), note: v.note.trim() }))
				.filter((v, index) => index === 0 || v.url)
		};
		if (descriptionLength < DESCRIPTION_MIN && !auth.isAdmin) {
			return (error = `The description needs at least ${DESCRIPTION_MIN} characters.`);
		}
		// The browser already insists on one; this covers a browser that does not.
		if (!input.category) return (error = 'Pick a category.');
		if (!editing && !slugify(input.name)) return (error = 'The name needs at least one letter or digit.');
		saving = true;
		try {
			const addon = editing ? await updateAddon(editing.id, input) : await createAddon(input);
			// The addon is saved either way; a suggestion that fails is not worth losing it over.
			if (versionOf) await suggestGroup(addon.id, versionOf.id).catch(() => {});
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
			<a href={resolve('/login')} class="btn btn-primary mt-4">Log in</a>
		{/if}
	</div>
{:else}
	<div class="grid items-start gap-4 md:grid-cols-[13rem_minmax(0,1fr)]">
		<aside class="panel">
			<div class="border-b border-border px-3 py-3">
				<h1 class="text-2xl leading-tight font-bold">{editing ? 'Edit addon' : 'Submit addon'}</h1>
				<p class="text-muted">{editing ? editing.name : 'Add one to the index'}</p>
			</div>
			<ul class="space-y-2 px-3 py-3 text-sm text-muted">
				<li>Name, link, category and description are <span class="text-accent">required</span>.</li>
				<li>Everything else is optional and helps players find the addon.</li>
				<li>You can edit or delete your entry at any time.</li>
			</ul>
		</aside>

		<form onsubmit={save}>
			<h2 class="section-title text-accent">Required</h2>
			<p class="mb-2 text-muted">The four things every entry needs.</p>
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
							class="input"
							type="url"
							required
							pattern="https://.*"
							placeholder="https://github.com/author/addon"
							bind:value={form.versions[0].url}
							onchange={fetchReadmeImages}
						/>
					</div>
					<div>
						<label class="field-label" for="category">Category</label>
						<select id="category" class="input" required bind:value={form.category}>
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
						<span class={['text-sm', descriptionLength >= DESCRIPTION_MIN ? 'text-accent' : 'text-muted']}>
							{Math.min(descriptionLength, DESCRIPTION_MIN)} / {DESCRIPTION_MIN} characters{auth.isAdmin ? ' (optional for admins)' : ''}
						</span>
					</div>
					<textarea
						id="description"
						class="input min-h-40"
						required={!auth.isAdmin}
						maxlength="5000"
						placeholder="What it does, main features, slash commands, installation notes…"
						bind:value={form.description}
					></textarea>
				</div>
			</div>

			<h2 class="section-title mt-8">Optional</h2>
			<p class="mb-2 text-muted">Leave any of these empty.</p>
			<div class="panel space-y-4 p-4">
				<div>
					<div class="flex items-baseline justify-between">
						<label class="field-label" for="summary">Summary</label>
						<span class="text-sm text-muted">{form.summary.length} / {SUMMARY_MAX}</span>
					</div>
					<input
						id="summary"
						class="input"
						maxlength={SUMMARY_MAX}
						placeholder="One sentence on what it does"
						bind:value={form.summary}
					/>
				</div>
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
								<button
									type="button"
									class="btn"
									aria-label="Move mirror {index} up"
									onclick={() => moveVersion(index, -1)}
								>
									↑
								</button>
								<button
									type="button"
									class="btn"
									aria-label="Move mirror {index} down"
									disabled={index === form.versions.length - 1}
									onclick={() => moveVersion(index, 1)}
								>
									↓
								</button>
								<button type="button" class="btn btn-danger" onclick={() => removeVersion(index)}>
									Remove
								</button>
							</div>
						{/if}
					{/each}
					<p class="hint">
						Other links saved on this addon. Remove any that point to a different version: post that
						one as its own addon instead.
					</p>
				</div>
				{/if}
				<div>
					<span class="field-label">Version of an existing addon</span>
					{#if versionOf}
						<p class="flex flex-wrap items-baseline gap-2">
							<span class="chip text-fg">{versionOf.name}</span>
							<button type="button" class="cursor-pointer text-sm text-muted hover:text-danger" onclick={() => (versionOf = undefined)}>
								Remove
							</button>
						</p>
					{:else}
						<AddonPicker
							placeholder="Search for the addon this is a version of"
							exclude={(other) => other.id === editing?.id || (editing?.group_id != null && other.group_id === editing.group_id)}
							onpick={(other) => (versionOf = other)}
						/>
					{/if}
					<p class="hint">
						Optional. If this is a fork or another version of an addon that is already listed, an admin
						will review the suggestion and may group the two.
					</p>
				</div>
				<div>
					<div class="flex items-baseline justify-between">
						<label class="field-label" for="image">Screenshots</label>
						<span class="text-sm text-muted">{form.images.length} / {MAX_IMAGES}</span>
					</div>
					{#if form.images.length}
						<ul class="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
							{#each form.images as image (image)}
								<li class="relative border border-border">
									<img
										src={image}
										alt=""
										loading="lazy"
										referrerpolicy="no-referrer"
										class="aspect-video w-full object-contain"
									/>
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
								'Images from a GitHub README are added automatically. You can also paste a link to an image.'}
					</p>
				</div>
			</div>

			<h2 class="section-title mt-8">Preview</h2>
			<p class="mb-2 text-muted">How it will look in the list.</p>
			<div class="panel">
				<AddonCard
					preview
					addon={{
						slug: '',
						name: form.name,
						summary: form.summary,
						description: form.description,
						category: form.category,
						repo_url: mainLink,
						versions: form.versions
					}}
				/>
			</div>

			{#if error}<p class="mt-4 text-danger">{error}</p>{/if}

			<div class="mt-4 flex gap-2">
				<button class="btn btn-primary" disabled={saving}>
					{saving ? 'Saving…' : editing ? 'Save changes' : 'Post addon'}
				</button>
				<a href={editing ? resolve('/addon/[slug]', { slug: editing.slug }) : resolve('/')} class="btn">
					Cancel
				</a>
			</div>
		</form>
	</div>
{/if}
