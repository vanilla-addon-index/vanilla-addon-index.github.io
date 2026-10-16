<script lang="ts">
	import { suggestCategory } from '#lib/category-scoring.ts';
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
		verdict: 'fine' | 'duplicate' | 'problem' | 'incomplete';
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
	const categorySuggestion = $derived(suggestCategory(item.name, item.description));

	// What approving publishes when nothing is touched, the same as the database would.
	const original = $derived({
		name: item.name.slice(0, 60),
		category: categorySuggestion.confidence === 'Uncertain' ? '' : item.category,
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
	const category = field('category');
	const author = field('author');
	const description = field('description');

	// An untouched entry is published by the database in one step and leaves the list at
	// once. An edited one is posted the way the submit form does, then marked as imported.
	const publish = (into?: Addon | null) =>
		run(async () => {
			if (!categoryChosen) throw new Error('Choose a category before approving this import.');
			into = into === undefined ? destination : into;
			if (edited || destination) {
				saving = true;
				try {
					await publishEdited(
						item,
						{
							name: draft.name.trim(),
							description: draft.description.trim(),
							category: draft.category,
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
		<select class={[quiet, 'w-44 flex-none text-sm text-muted']} aria-label="Category" disabled={!!nameMatch && !!original.category} bind:value={category.value}>
			<option value="" disabled>Choose a category…</option>
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
		placeholder="No description on the wiki."
		aria-label="Description" disabled={!!nameMatch}
		bind:value={description.value}
	></textarea>

	<div class="px-1.5">
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
		<div class="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
			<span class={['font-bold', verdict === 'fine' ? 'text-fg' : verdict === 'problem' ? 'text-danger' : 'text-accent']}>{advice}</span>
			{#if destination}<span class="text-muted">{pictureSlots ? `+${Math.min(addedPictures, pictureSlots)} pictures` : 'Gallery full'}</span>{/if}
		</div>
		<dl class="mt-1 grid grid-cols-2 gap-x-5 gap-y-0.5 text-sm sm:flex sm:flex-wrap sm:gap-x-5">
			{#each notes as note (note.label)}
				<div class="flex min-w-0 gap-1.5">
					<dt class="shrink-0 text-muted">{note.label}</dt>
					<dd class={['break-words [overflow-wrap:anywhere]', note.tone === 'danger' ? 'text-danger' : note.tone === 'warning' ? 'text-accent' : 'text-fg']}>
						{#if note.href}
							<a href={note.href} target="_blank" rel="noopener noreferrer" class="underline decoration-current/50 underline-offset-2 hover:decoration-current">{note.value}</a>
						{:else}{note.value}{/if}
					</dd>
				</div>
			{/each}
		</dl>
		<details class="mt-1 text-sm text-muted">
			<summary class="cursor-pointer hover:text-fg">Category suggestion: {categorySuggestion.category} · {categorySuggestion.confidence}</summary>
			<p class="mt-1">A suggestion for review; your selected category is what gets published.</p>
			{#each categorySuggestion.matches.slice(0, 3) as candidate (candidate.category)}
				<p class="mt-1"><span class="text-fg">{candidate.category}:</span>
					{candidate.evidence.map(e => `${e.source}: “${e.text}”`).join('; ')}
				</p>
			{:else}<p class="mt-1">No category evidence found in the name or description.</p>{/each}
		</details>
		{#if !categoryChosen}<p class="mt-1 text-sm text-accent">Choose a category to enable approval.</p>{/if}
		<div class="mt-1.5 flex flex-wrap items-center gap-2">
			<button data-act="approve" class="btn btn-primary py-1" disabled={saving || !categoryChosen} onclick={() => publish()}>
				{saving ? 'Publishing…' : destination ? 'Add link to ' + destination.name : 'Approve'}
			</button>
			{#if match && !destination}
				<button data-act="version" class="btn py-1" disabled={saving || !categoryChosen} onclick={() => publish(match)}>
					Add link to {match.name}
				</button>
			{/if}
			{#if forkMatch && !nameMatch}
				<button class="btn py-1" disabled={saving || !categoryChosen} onclick={() => publish(null)}>Approve separately</button>
			{/if}
			<button data-act="reject" class="btn btn-danger py-1" disabled={saving} onclick={turnDown}>Reject</button>
			{#if edited}
				<button class="cursor-pointer text-sm text-muted hover:text-accent" onclick={() => (edits = {})}>
					Undo my changes
				</button>
			{/if}
		</div>
	</footer>
</div>
