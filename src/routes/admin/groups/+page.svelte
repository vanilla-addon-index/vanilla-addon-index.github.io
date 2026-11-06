<script lang="ts">
	import { entryHref } from '#lib/entry-href.ts';
	import AdminToolbar from '#lib/components/AdminToolbar.svelte';
	import AdminSidebarContent from '#lib/components/AdminSidebarContent.svelte';
	import AdminNavigation from '#lib/components/AdminNavigation.svelte';
 import { store, plainName } from '#lib/addons.svelte.ts';
 import { SITE_NAME } from '#lib/config.ts';
 let query = $state('');
 let entryType = $state('');
 const pages = $derived(store.addons.filter(a => a.shared && (!entryType || (a.entry_type ?? 'addon') === entryType) && plainName(a.name).includes(plainName(query))).toSorted((a,b)=>a.name.localeCompare(b.name)));
</script>
<svelte:head><title>Grouped addons · {SITE_NAME}</title></svelte:head>
<AdminSidebarContent>
	<div class="panel p-3"><h1 class="text-2xl font-bold">Grouped addons</h1><p class="text-muted">Manage pages with grouped addon links.</p></div>
	<dl class="panel p-3"><div class="flex justify-between gap-2"><dt class="text-muted">Matching pages</dt><dd>{pages.length}</dd></div></dl>
	<p class="panel p-3 text-sm text-muted">Matching names add links to one page automatically. Open a page to pin its leading link, remove a bad link through Edit, or separate an unrelated addon.</p>
</AdminSidebarContent>
<AdminToolbar>
<input class="input" aria-label="Search grouped addons" placeholder="Search grouped addons…" bind:value={query} />
<select class="input" aria-label="Type" bind:value={entryType}><option value="">All types</option><option value="addon">Addons</option><option value="dll">DLL mods</option></select>
<AdminNavigation />
</AdminToolbar>
<div class="panel">
 {#each pages as addon (addon.id)}
  <a class="flex justify-between border-b border-border px-3 py-2 last:border-b-0 hover:text-accent" href={entryHref(addon)}><span>{addon.name}{#if addon.entry_type === 'dll'} <span class="text-xs text-accent">DLL mod</span>{/if}</span><span class="text-muted">{addon.versions.length} links{addon.pinned_link ? ' · pinned' : ''}</span></a>
 {:else}<p class="p-4 text-muted">No grouped addons found.</p>{/each}
</div>
