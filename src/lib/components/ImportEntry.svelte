<script lang="ts">
	import { commitCategoryOnFocus } from '#lib/category-select.ts';
	import WikiArticleFallback from './WikiArticleFallback.svelte';
	import AddonPicker from './AddonPicker.svelte';
	import ReviewQueueRow from './ReviewQueueRow.svelte';
	import type { ReviewNote } from '#lib/import-review.ts';
	import { store, plainName } from '#lib/addons.svelte.ts';
	import { CATEGORIES, MAX_IMAGES } from '#lib/config.ts';
	import { approve, approveInto, loadQueue, publishEdited, reject, type QueueItem } from '#lib/imports.svelte.ts';
	import { decideAddonMirror } from '#lib/admin.ts';
	import { entryHref } from '#lib/entry-href.ts';
	import { linkAuthor } from '#lib/links.ts';
	import { hostAllowed } from '#lib/hosts.ts';
	import { readmeRepository, repositoryImages } from '#lib/repository-images.ts';
	import type { Addon } from '#lib/types.ts';

	type Props = {
		item: QueueItem;
		// Position in the list, for the keyboard shortcuts.
		index: number;
		selected: boolean;
		verdict: 'fine' | 'duplicate' | 'problem' | 'incomplete' | 'wiki' | 'dead';
		// The one-line suggestion, then what it is based on.
		advice: string;
		notes: ReviewNote[];
		// A live addon this entry probably belongs to.
		match?: Addon;
		forkMatch?: Addon;
		onselect: () => void;
		// Runs an action for the page, which shows what it returns, or why it failed.
		run: (action: () => Promise<string>) => Promise<void>;
	};
	let { item, index, selected, verdict, advice, notes, match, forkMatch, onselect, run }: Props = $props();
	const reviewId = $props.id();
	const mirrorAddon = $derived(store.addons.find(addon => addon.id === item.mirror_addon_id));
	let attachingMirror = $state(false);
	async function attachMirror() {
		if (!item.mirror_source || !item.mirror_addon_id || attachingMirror) return;
		attachingMirror = true;
		try {
			await run(async () => {
				await decideAddonMirror(item.mirror_addon_id!, item.url, item.mirror_source!, 'mirror', item.id);
				await loadQueue();
				return '';
			});
		} finally { attachingMirror = false; }
	}

	let readmeImages = $state<string[]>([]);
	let readmeRequest: Promise<void> | undefined;
	function findReadmeImages() {
		if (verdict === 'wiki' || item.readme_checked_at || item.images.length >= MAX_IMAGES || !readmeRepository(item.url)) return;
		return readmeRequest ??= repositoryImages(item.url, AbortSignal.timeout(5000))
			.then((found) => { readmeImages = found.filter((url) => url.length <= 500 && hostAllowed(url, 'image')); })
			.catch(() => { readmeRequest = undefined; });
	}
	$effect(() => {
		if (selected) void findReadmeImages();
	});

	// New pages always start without a category, including older queued guesses.
	const original = $derived({
		name: item.name.slice(0, 60),
		category: '',
		entry_type: (item.entry_type ?? 'addon') as 'addon' | 'dll',
		author: linkAuthor(item.url),
		description: item.description,
		images: [...new Set([...item.images, ...readmeImages])].slice(0, MAX_IMAGES)
	});
	type Draft = typeof original;
	// Only what the admin changed. It lasts while the entry is on the page.
	let edits = $state<Partial<Draft>>({});
	const draft = $derived({ ...original, ...edits });
	const nameMatch = $derived(store.addons.find((a) => plainName(a.name) === plainName(draft.name)));
	const destination = $derived(nameMatch ?? forkMatch);
	const addedPictures = $derived(destination ? Math.max(0, new Set([...destination.images, ...draft.images]).size - destination.images.length) : 0);
	const pictureSlots = $derived(destination ? Math.max(0, MAX_IMAGES - destination.images.length) : 0);
	const edited = $derived(Object.keys(edits).length > 0);
	const categoryChosen = $derived(draft.entry_type === 'dll' || (CATEGORIES as readonly string[]).includes(draft.category));
	const descriptionProvided = $derived(!!draft.description.trim());
	const newPageRequirements = $derived([
		!draft.name.trim() && 'enter a name',
		!categoryChosen && 'choose a category',
		!descriptionProvided && 'add a description'
	].filter(Boolean));
	const reviewStatuses = $derived.by(() => {
		const badges: { text: string; attention: boolean }[] = [];
		if (item.problem) badges.push({ text: 'Publish failed', attention: true });
		if (!item.url.trim()) badges.push({ text: 'Missing link', attention: true });
		if ((item.same_name_count ?? 0) > 1) badges.push({ text: 'Duplicate name in queue', attention: true });

		if (verdict === 'wiki') {
			badges.push({ text: 'Wiki article', attention: false });
			return badges;
		}

		if (item.mirror_source) {
			badges.push(item.mirror_addon_id
				? { text: 'Confirmed mirror', attention: false }
				: { text: item.mirror_source_unavailable ? 'Mirror source unavailable' : 'Check mirror source', attention: true });
		}
		if (advice.startsWith('Already live')) badges.push({ text: 'Already live', attention: true });
		else if (destination) badges.push({ text: 'Existing addon', attention: false });
		else if (match || verdict === 'duplicate') badges.push({ text: 'Possible version', attention: false });

		if (!destination && !item.mirror_addon_id) {
			if (!draft.name.trim()) badges.push({ text: 'Needs name', attention: true });
			if (!categoryChosen) badges.push({ text: 'Needs category', attention: true });
			if (!descriptionProvided) badges.push({ text: 'Needs description', attention: true });
			if (!draft.author.trim()) badges.push({ text: 'Missing author', attention: true });
		}
		return badges.length ? badges : [{ text: 'Ready', attention: false }];
	});
	const statusLabels = new Set(['Missing', 'Queue', 'Publish failed']);
	const facts = $derived(notes.filter(note => !statusLabels.has(note.label) && note.value !== 'Unknown'));
	const statusMessages = $derived.by(() => {
		const messages: string[] = [];
		// Relationships are already shown with the facts and approval actions.
		if (!['Ready', 'Incomplete', 'Add to existing page', 'Fork · existing page', 'Similar name · check match', 'Possible version'].includes(advice)) messages.push(advice);
		if (item.problem) messages.push(`Publish failed: ${item.problem}`);
		if (destination && addedPictures > 0) messages.push(pictureSlots ? `+${Math.min(addedPictures, pictureSlots)} pictures` : 'Gallery full');
		return messages.filter(Boolean);
	});
	let saving = $state(false);
	let mergeOpen = $state(false);
	const merge = (mergeTarget: Addon) => run(async () => {
		if (saving || verdict === 'wiki') return '';
		saving = true;
		try {
			await findReadmeImages();
			await publishEdited(item, {
				name: mergeTarget.name,
				description: draft.description.trim(),
				category: mergeTarget.category,
				entry_type: mergeTarget.entry_type ?? 'addon',
				author: mergeTarget.author,
				versions: [{ url: item.url, note: '' }],
				images: draft.images
			}, mergeTarget);
			return '';
		} finally { saving = false; }
	});

	const field = <K extends keyof Draft>(key: K) => ({
		get value() {
			return draft[key];
		},
		set value(next: Draft[K]) {
			edits[key] = next;
		}
	});
	const name = field('name');
	const category = {
		get value() { return entryType.value === 'dll' ? '' : nameMatch?.category ?? draft.category; },
		set value(next: string) { edits.category = next; }
	};
	const entryType = {
		get value() { return nameMatch?.entry_type ?? draft.entry_type; },
		set value(next: 'addon' | 'dll') { edits.entry_type = next; }
	};
	const author = field('author');
	const description = field('description');

	// An untouched entry is published by the database in one step and leaves the list at
	// once. An edited one is posted the way the submit form does, then marked as imported.
	const publish = (into?: Addon | null) =>
		run(async () => {
			if (saving) return '';
			if (verdict === 'wiki') throw new Error('Find the download links before approving this wiki article.');
			into = into === undefined ? destination : into;
			if (!into && !categoryChosen) throw new Error('Choose a category before approving this import.');
			if (!into && !descriptionProvided) throw new Error('Add a description before approving this import.');
			saving = true;
			try {
				await findReadmeImages();
				if (edited || readmeImages.length || destination || draft.category !== item.category || draft.entry_type === 'dll') {
					await publishEdited(
						item,
						{
							name: draft.name.trim(),
							description: draft.description.trim(),
							category: into?.category ?? (draft.entry_type === 'dll' ? 'DLL' : draft.category),
							entry_type: into?.entry_type ?? draft.entry_type,
							author: draft.author.trim(),
							versions: [{ url: item.url, note: '' }],
							images: draft.images
						},
						into ?? undefined
					);
					return '';
				}
				if (into) {
					await approveInto(item, into);
					return '';
				}
				return (await approve([item.id])) ? '' : `"${item.name}" could not be published; the reason is on the entry.`;
			} finally {
				saving = false;
			}
		});

	const turnDown = () =>
		run(async () => {
			await reject([item.id]);
			return '';
		});

	// Ctrl+Enter approves from inside a field, where the single-letter shortcuts are off.
	function keys(event: KeyboardEvent) {
		if (event.target instanceof HTMLElement && event.target.closest('[role="combobox"]')) return;
		if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			publish();
		}
	}

	const fieldStyle = 'input min-w-0 text-sm disabled:opacity-60';
</script>

{#snippet rejectAction()}
	<button data-act="reject" class="btn btn-danger py-1" disabled={saving} onclick={turnDown}>Reject</button>
{/snippet}

<ReviewQueueRow
	title={draft.name || item.name}
	subtitle={(item.source ?? 'Turtle WoW Wiki') + (draft.author ? ' · ' + draft.author : '')}
	{index}
	{selected}
	{onselect}
	onreviewkey={keys}
>
	{#snippet badges()}
		{#each reviewStatuses as status (status.text)}
			<span class={['admin-badge', status.attention ? 'border-accent/30 text-accent' : status.text === 'Ready' ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' : 'border-border text-muted']}>{status.text}</span>
		{/each}
	{/snippet}

	{#if verdict === 'wiki'}
		<WikiArticleFallback {item} {rejectAction} />
	{:else}
		<div class="min-w-0 @container">
			{#if statusMessages.length}
				<div role="note" aria-label="Import status" class="mb-2 text-sm text-accent">
					{#each statusMessages as message, index}
						{#if index}<span class="px-2 text-muted" aria-hidden="true">·</span>{/if}<span>{message}</span>
					{/each}
				</div>
			{/if}

			<div class="grid gap-2 @sm:grid-cols-2 @xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
				<label class="min-w-0 @sm:col-span-2 @xl:col-span-1">
					<span class="mb-1 block text-xs font-semibold text-muted">Name</span>
					<input data-act="name" class={fieldStyle} maxlength="60" aria-label="Name" bind:value={name.value} />
				</label>
				<label class="min-w-0">
					<span class="mb-1 block text-xs font-semibold text-muted">Category</span>
					<select use:commitCategoryOnFocus class={[fieldStyle, !destination && !categoryChosen && 'border-accent/60']} aria-label="Category" aria-required={!destination && entryType.value !== 'dll'} disabled={!!nameMatch || entryType.value === 'dll'} bind:value={category.value}>
						<option value="" disabled>{entryType.value === 'dll' ? 'Not used for DLL mods' : forkMatch ? 'Category for a new page…' : 'Choose a category…'}</option>
						{#each CATEGORIES as c (c)}
							<option value={c}>{c}</option>
						{/each}
					</select>
				</label>
				<label class="min-w-0">
					<span class="mb-1 block text-xs font-semibold text-muted">Author</span>
					<input class={fieldStyle} maxlength="60" aria-label="Author" disabled={!!nameMatch} bind:value={author.value} />
				</label>
			</div>
			<label class="mt-2 block">
				<span class="mb-1 block text-xs font-semibold text-muted">Description</span>
				<textarea class={[fieldStyle, 'block max-h-32 [field-sizing:content]', !destination && !descriptionProvided && 'border-accent/60']}
					rows="1" maxlength="5000" placeholder="No description from the source."
					aria-label="Description" aria-required={!destination} disabled={!!nameMatch} bind:value={description.value}></textarea>
			</label>
		</div>

		<footer class="mt-3 border-t border-border pt-2">
			<div class="flex flex-wrap items-center gap-2">
				<select aria-label="Publish to" class="input w-28 py-1 text-sm disabled:opacity-40" disabled={saving || !!nameMatch} bind:value={entryType.value}>
					<option value="addon">Addons</option><option value="dll">DLL</option>
				</select>
				<button data-act="approve" class={['btn py-1', !item.mirror_addon_id && 'btn-primary']} disabled={saving || attachingMirror || (!destination && (!categoryChosen || !descriptionProvided))} onclick={() => publish()}>
					{saving ? 'Publishing…' : item.mirror_addon_id ? 'Approve as version' : destination ? 'Add link to ' + destination.name : 'Approve'}
				</button>
				{#if match && !destination}
					<button data-act="version" class="btn py-1" disabled={saving} onclick={() => publish(match)}>
						Add link to {match.name}
					</button>
				{/if}
				{#if destination}
					<button
						type="button"
						class="btn py-1"
						disabled={saving || attachingMirror || !!nameMatch || newPageRequirements.length > 0}
						title={nameMatch ? 'A page with this name already exists.' : newPageRequirements.length ? 'To publish a new page, ' + newPageRequirements.join(' and ') + '.' : undefined}
						onclick={() => publish(null)}
					>Publish as new page</button>
				{/if}
				{@render rejectAction()}
				<div class="flex min-w-0 max-w-full items-center gap-2">
					<button
						type="button"
						class={['btn shrink-0 py-1', mergeOpen && 'border-accent/30 bg-raised']}
						aria-expanded={mergeOpen}
						aria-controls={reviewId + '-merge'}
						disabled={saving}
						onclick={() => (mergeOpen = !mergeOpen)}
					>Merge</button>
					<fieldset id={reviewId + '-merge'} hidden={!mergeOpen} class="m-0 w-72 min-w-0 border-0 p-0" disabled={saving}>
						<AddonPicker placeholder="Merge into existing addon…" onpick={merge} />
					</fieldset>
				</div>

				{#if edited}
					<button class="cursor-pointer text-sm text-muted hover:text-accent" onclick={() => (edits = {})}>
						Undo my changes
					</button>
				{/if}
			</div>
		</footer>

		<section aria-label="Repository details" class="mt-2 min-w-0 border-t border-border pt-2">
			<div class="space-y-2">
				{#if item.mirror_source}
					<div class="space-y-1 border-l-2 border-accent pl-2 text-sm">
						<p>Mirror of <a href={item.mirror_source} target="_blank" rel="noopener noreferrer" class="break-all text-accent hover:underline">{item.mirror_source}</a></p>
						{#if item.mirror_addon_id}
							{#if mirrorAddon}<p>Published on <a href={entryHref(mirrorAddon)} class="text-accent hover:underline">{mirrorAddon.name}</a></p>{/if}
							<button class="btn btn-primary" disabled={attachingMirror} onclick={attachMirror}>Attach as mirror</button>
						{:else}
							<p class="text-muted">{item.mirror_source_unavailable ? 'Source unavailable' : 'Exact source not listed'}</p>
						{/if}
					</div>
				{/if}
				{#if item.wiki_source}
					<p class="text-sm text-muted"><a href={item.wiki_source} target="_blank" rel="noopener noreferrer" class="underline">Wiki source</a>{item.wiki_recommended ? ' · Wiki recommended · pins on approval' : ''}</p>
				{/if}
				<div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
					<p class="font-semibold text-muted">Repository</p>
					<a href={item.url} target="_blank" rel="noopener nofollow" class="[overflow-wrap:anywhere] text-accent hover:underline">{item.url}</a>
				</div>
				{#if draft.images.length}
					<ul class="mt-1 flex flex-wrap gap-1.5">
						{#each draft.images as image (image)}
							<li class="relative border border-border">
								<a href={image} target="_blank" rel="noopener nofollow">
									<img src={image} alt="" loading="lazy" referrerpolicy="no-referrer" class="h-14 w-24 object-contain" />
								</a>
								<button
									class="absolute top-0 right-0 cursor-pointer bg-bg px-1.5 text-sm leading-5 text-muted hover:text-danger"
									aria-label="Remove this screenshot"
									onclick={() => (edits.images = draft.images.filter((i) => i !== image))}
								>
									×
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
			{#if facts.length}
				<dl class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
					{#each facts as note (note.label)}
						<div class="flex min-w-0 gap-1.5">
							<dt class="shrink-0 text-muted">{note.label}</dt>
							<dd class="break-words text-fg [overflow-wrap:anywhere]">
								{#if note.href}
									<a href={note.href} target="_blank" rel="noopener noreferrer" class="underline decoration-current/50 underline-offset-2 hover:decoration-current">{note.value}</a>
								{:else}{note.value}{/if}
							</dd>
						</div>
					{/each}
				</dl>
			{/if}
		</section>
	{/if}
</ReviewQueueRow>
