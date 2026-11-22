<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';
	import { screenshotUrl } from '#lib/github.ts';
	import { hostAllowed } from '#lib/hosts.ts';

	let { images: savedImages, name }: { images: string[]; name: string } = $props();

	// Older entries can store both proxy and GitHub file URLs alongside direct image URLs.
	const images = $derived([...new Set(savedImages.map((image) => {
		const original = screenshotUrl(image);
		return hostAllowed(original, 'image') ? original : image;
	}))]);

	const status = new SvelteMap<string, 'loaded' | 'failed'>();
	const loaded = $derived(images.filter(image => status.get(image) === 'loaded'));
	let viewer = $state<HTMLDialogElement>();
	let viewing = $state<string>();

	function view(image: string) {
		viewing = image;
		viewer?.showModal();
	}

	function step(event: KeyboardEvent) {
		const move = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
		if (!move || !viewing || !loaded.length) return;
		event.preventDefault();
		viewing = loaded[(loaded.indexOf(viewing) + move + loaded.length) % loaded.length];
	}
</script>

<!-- Keep each slot in place as images settle, including when a host fails. -->
<ul class="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-5" aria-label="Screenshots" aria-hidden={!loaded.length}>
	{#each images as image, index (image)}
		{@const result = status.get(image)}
		<li class="relative aspect-video" aria-hidden={result !== 'loaded'}>
			<button
				class="absolute inset-0 block h-full w-full cursor-zoom-in transition-opacity duration-100 enabled:hover:opacity-80"
				class:bg-raised={!result}
				class:invisible={result === 'failed'}
				aria-label="View screenshot {index + 1} of {name} full size"
				disabled={result !== 'loaded'}
				onclick={() => view(image)}
			>
				<img
					src={image}
					alt=""
					loading="lazy"
					decoding="async"
					referrerpolicy="no-referrer"
					class="h-full w-full object-contain"
					class:opacity-0={result !== 'loaded'}
					onload={() => status.set(image, 'loaded')}
					onerror={() => status.set(image, 'failed')}
				/>
			</button>
		</li>
	{/each}
</ul>

<!-- Escape or a click closes the viewer. Arrow keys step through loaded images. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
	bind:this={viewer}
	aria-label="Screenshot viewer"
	class="m-auto max-h-[94vh] max-w-[94vw] cursor-zoom-out border border-border bg-bg p-0 backdrop:bg-black/85"
	onclick={() => viewer?.close()}
	onclose={() => (viewing = undefined)}
	onkeydown={step}
>
	{#if viewing}
		<img
			src={viewing}
			alt="Screenshot {images.indexOf(viewing) + 1} of {name}"
			referrerpolicy="no-referrer"
			class="max-h-[94vh] max-w-[94vw] object-contain"
		/>
	{/if}
</dialog>
