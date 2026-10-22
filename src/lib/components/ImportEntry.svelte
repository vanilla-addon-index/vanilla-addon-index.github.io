<script lang="ts">
	import { commitCategoryOnFocus } from '#lib/category-select.ts';
	import WikiArticleFallback from './WikiArticleFallback.svelte';
	import type { ReviewNote } from '#lib/import-review.ts';
	import { store, plainName } from '#lib/addons.svelte.ts';
	import { CATEGORIES, MAX_IMAGES } from '#lib/config.ts';
	import { approve, approveInto, publishEdited, reject, type QueueItem } from '#lib/imports.svelte.ts';
	import { linkAuthor } from '#lib/links.ts';
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

	// New pages always start without a category, including older queued guesses.
	const original = $derived({
		name: item.name.slice(0, 60),
		category: '',
		author: linkAuthor(item.url),
		description: item.description,
		images: item.images.slice(0, MAX_IMAGES)
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
	const categoryChosen = $derived((CATEGORIES as readonly string[]).includes(draft.category));
	const statusLabels = new Set(['Missing', 'Queue', 'Publish failed']);
	const facts = $derived(notes.filter(note => !statusLabels.has(note.label)));
	const statusMessages = $derived.by(() => {
		const messages: string[] = [];
		// Relationships are already shown with the facts and approval actions.
		if (!['Ready', 'Incomplete', 'Add to existing page', 'Fork · existing page', 'Similar name · check match', 'Possible version'].includes(advice)) messages.push(advice);
		if (!destination && !categoryChosen) messages.push(match ? 'Choose a category to approve separately' : 'Choose a category');
		if (forkMatch && !nameMatch) messages.push(`Uses ${forkMatch.category} when added to ${forkMatch.name}`);
		for (const note of notes.filter(note => statusLabels.has(note.label))) {
			const value = note.label === 'Missing' ? note.value.split(', ').filter(value =>
				value === 'description' ? !draft.description.trim() : value === 'author' ? !draft.author.trim() : value !== 'category'
			).join(', ') : note.value;
			if (value) messages.push(note.label === 'Queue' ? value : `${note.label}: ${value}`);
		}
		if (destination && addedPictures > 0) messages.push(pictureSlots ? `+${Math.min(addedPictures, pictureSlots)} pictures` : 'Gallery full');
		return messages.filter(Boolean);
	});
	let saving = $state(false);

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
		get value() { return nameMatch?.category ?? draft.category; },
		set value(next: string) { edits.category = next; }
	};
	const author = field('author');
	const description = field('description');

	// An untouched entry is published by the database in one step and leaves the list at
	// once. An edited one is posted the way the submit form does, then marked as imported.
	const publish = (into?: Addon | null) =>
		run(async () => {
			if (verdict === 'wiki') throw new Error('Find the download links before approving this wiki article.');
			into = into === undefined ? destination : into;
			if (!into && !categoryChosen) throw new Error('Choose a category before approving this import.');
			if (edited || destination || draft.category !== item.category) {
				saving = true;
				try {
					await publishEdited(
						item,
						{
							name: draft.name.trim(),
							description: draft.description.trim(),
							category: into?.category ?? draft.category,
							author: draft.author.trim(),
							versions: [{ url: item.url, note: '' }],
							images: draft.images
						},
						into ?? undefined
					);
				} finally {
					saving = false;
				}
				return '';
			}
			if (into) {
				await approveInto(item, into);
				return '';
			}
			return (await approve([item.id])) ? '' : `"${item.name}" could not be published; the reason is on the entry.`;
		});

	const turnDown = () =>
		run(async () => {
			await reject([item.id]);
			return '';
		});

	// Ctrl+Enter approves from inside a field, where the single-letter shortcuts are off.
	function keys(event: KeyboardEvent) {
		if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			publish();
		}
	}

	const quiet = 'disabled:opacity-40 input border-transparent bg-transparent px-1.5 py-0.5 hover:border-border';
</script>

<!-- Every field of the entry is there to be changed in place before approving; a field
     shows its border when pointed at or typed in. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
	data-entry={index}
	class={[
		'border-b border-l-2 border-border px-1.5 py-1.5 last:border-b-0',
		selected ? 'border-l-accent bg-raised' : 'border-l-transparent'
	]}
	onclick={onselect}
	onkeydown={keys}
>
	<div class="flex flex-wrap gap-x-1">
		<input
			data-act="name"
			class={[quiet, 'min-w-40 flex-1 font-bold']}
			maxlength="60"
			aria-label="Name"
			bind:value={name.value}
		/>
		<select use:commitCategoryOnFocus class={[quiet, 'w-44 flex-none text-sm text-muted']} aria-label="Category" disabled={!!nameMatch} bind:value={category.value}>
			<option value="" disabled>{forkMatch ? 'Category if separate…' : 'Choose a category…'}</option>
			{#each CATEGORIES as c (c)}
				<option value={c}>{c}</option>
			{/each}
		</select>
		<input
			class={[quiet, 'w-40 flex-none text-sm text-muted']}
			maxlength="60"
			placeholder="Author"
			aria-label="Author" disabled={!!nameMatch}
			bind:value={author.value}
		/>
	</div>
	<textarea
		class={[quiet, 'block min-h-[1lh] [field-sizing:content] text-muted']}
		rows="2"
		maxlength="5000"
		placeholder="No description from the source."
		aria-label="Description" disabled={!!nameMatch}
		bind:value={description.value}
	></textarea>

	<div class="px-1.5">
		<p class="text-sm text-muted">Source: {item.source ?? 'Turtle WoW Wiki'}</p>
		{#if item.wiki_source}
			<p class="text-sm text-muted"><a href={item.wiki_source} target="_blank" rel="noopener noreferrer" class="underline">Wiki source</a>{item.wiki_recommended ? ' · Wiki recommended · pins on approval' : ''}</p>
		{/if}
		<a
			href={item.url}
			target="_blank"
			rel="noopener nofollow"
			class="break-all text-accent/80 hover:text-accent hover:underline"
		>
			{item.url}
		</a>
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

	<!-- Set apart from the fields above: this part is the site's reading of the entry, not
	     something that gets published. -->
	<footer class="-mx-1.5 mt-2 -mb-1.5 border-t border-border bg-black/30 px-3 py-1.5">
		{#if statusMessages.length}
			<div role="note" aria-label="Import status" class="mb-2 border-l-2 border-border bg-raised/50 px-2 py-1 text-sm text-muted">
				{#each statusMessages as message, index}
					{#if index}<span class="px-2" aria-hidden="true">·</span>{/if}<span>{message}</span>
				{/each}
			</div>
		{/if}
		<dl class="mt-1 grid grid-cols-2 gap-x-5 gap-y-0.5 text-sm sm:flex sm:flex-wrap sm:gap-x-5">
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
		<div class="mt-1.5 flex flex-wrap items-center gap-2">
			{#if verdict !== 'wiki'}
			<button data-act="approve" class="btn btn-primary py-1" disabled={saving || (!destination && !categoryChosen)} onclick={() => publish()}>
				{saving ? 'Publishing…' : destination ? 'Add link to ' + destination.name : 'Approve'}
			</button>
			{#if match && !destination}
				<button data-act="version" class="btn py-1" disabled={saving} onclick={() => publish(match)}>
					Add link to {match.name}
				</button>
			{/if}
			{#if forkMatch && !nameMatch}
				<button class="btn py-1" disabled={saving || !categoryChosen} onclick={() => publish(null)}>Approve separately</button>
			{/if}
			{/if}
			<button data-act="reject" class="btn btn-danger py-1" disabled={saving} onclick={turnDown}>Reject</button>
			{#if edited}
				<button class="cursor-pointer text-sm text-muted hover:text-accent" onclick={() => (edits = {})}>
					Undo my changes
				</button>
			{/if}
		</div>
		{#if verdict === 'wiki'}<WikiArticleFallback {item} />{/if}
	</footer>
</div>
