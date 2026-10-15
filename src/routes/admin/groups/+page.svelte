<script lang="ts">
 import { resolve } from '$app/paths';
 import { store, plainName } from '#lib/addons.svelte.ts';
 import { SITE_NAME } from '#lib/config.ts';
 let query = $state('');
 const pages = $derived(store.addons.filter(a => a.shared && plainName(a.name).includes(plainName(query))).toSorted((a,b)=>a.name.localeCompare(b.name)));
</script>
<svelte:head><title>Shared addons · {SITE_NAME}</title></svelte:head>
<h1 class="section-title">Shared addons</h1>
<p class="mb-3 text-muted">Matching names add links to one page automatically. Open a page to pin its leading link, remove a bad link through Edit, or separate an unrelated addon.</p>
<input class="input mb-3" aria-label="Search shared addons" placeholder="Search shared addons…" bind:value={query} />
<div class="panel">
 {#each pages as addon (addon.id)}
  <a class="flex justify-between border-b border-border px-3 py-2 last:border-b-0 hover:text-accent" href={resolve('/addon/[slug]', {slug:addon.slug})}><span>{addon.name}</span><span class="text-muted">{addon.versions.length} links{addon.pinned_link ? ' · pinned' : ''}</span></a>
 {:else}<p class="p-4 text-muted">No shared addons found.</p>{/each}
</div>
