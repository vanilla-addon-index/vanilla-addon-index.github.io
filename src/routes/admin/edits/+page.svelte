<script lang="ts">
	import { untrack } from 'svelte';
	import { entryHref } from '#lib/entry-href.ts';
	import LinkReviews from '#lib/components/LinkReviews.svelte';
	import AdminToolbar from '#lib/components/AdminToolbar.svelte';
	import AdminSidebarContent from '#lib/components/AdminSidebarContent.svelte';
	import AdminNavigation from '#lib/components/AdminNavigation.svelte';
 import { store } from '#lib/addons.svelte.ts';
 import { FIELD_LABELS, displayEditValue as value, decideEdit, type EditField, type EditRequest } from '#lib/edit-reviews.svelte.ts';
 import type { LinkRequest } from '#lib/link-reviews.svelte.ts';
 import { createModerationQueue } from '#lib/moderation-queue.svelte.ts';
 import { adminBadgeCounts } from '#lib/admin-badges.svelte.ts';
 import { SITE_NAME } from '#lib/config.ts';
 let selected=$state<Record<number,EditField[]>>({});
 let busy=$state<number>(), error=$state('');
 let query=$state('');
 const nameOf=(id:number)=>store.addons.find(a=>a.id===id)?.name;
 const edits=createModerationQueue<EditRequest>('edits', r=>
  [nameOf(r.addon_id),r.proposer?.username,...Object.keys(r.changes).map(key=>FIELD_LABELS[key as EditField])].join(' '), rows=>{
  for(const r of rows) selected[r.id] ??= Object.keys(r.changes) as EditField[];
 });
 const links=createModerationQueue<LinkRequest>('links', r=>[nameOf(r.addon_id),r.url,r.proposer?.username].join(' '));
 $effect(()=>{
  const term=query.trim();
  const stopEdits=untrack(()=>edits.search(term));
  const stopLinks=untrack(()=>links.search(term));
  return ()=>{stopEdits?.();stopLinks?.();};
 });
 const current=(r:EditRequest,key:EditField)=>store.addons.find(a=>a.id===r.addon_id)?.[key];
 const conflict=(r:EditRequest,key:EditField)=>JSON.stringify(current(r,key))!==JSON.stringify(r.base[key]);
 async function decide(r:EditRequest,accept:boolean){
  error='';busy=r.id;
  try{await decideEdit(r.id,accept,selected[r.id]);edits.remove(r.id);delete selected[r.id];}
  catch(e){error=(e as Error).message;}finally{busy=undefined;}
 }
</script>
<svelte:head><title>Edit reviews · {SITE_NAME}</title></svelte:head>
<AdminToolbar>
 <input class="input w-full" type="search" aria-label="Search edit reviews" placeholder="Search edit reviews" bind:value={query} />
 <AdminNavigation />
</AdminToolbar>
<AdminSidebarContent>
	<div class="panel p-3"><h1 class="text-2xl font-bold">Edit reviews</h1><p class="text-muted">Review link suggestions and contributor proposals.</p></div>
	<dl class="panel p-3"><div class="flex justify-between gap-2"><dt class="text-muted">Waiting</dt><dd>{edits.loaded && links.loaded ? adminBadgeCounts().edits : '…'}</dd></div></dl>
	<p class="panel p-3 text-sm text-muted">Select the fields to accept. Conflicting fields need a revised proposal; accepting other fields preserves the current page.</p>
</AdminSidebarContent>
<LinkReviews queue={links} />
{#if error || edits.error}<p class="mb-3 text-danger" role="alert">{error || edits.error}</p>{/if}
{#if !edits.loaded && edits.loading}<p>Loading edit proposals…</p>
{:else if edits.loaded && links.loaded && !edits.rows.length && !links.rows.length && !edits.hasMore && !links.hasMore}
 <p class="panel p-4 text-muted">{query.trim() ? 'No edit reviews match your search.' : 'No edits are waiting for review.'}</p>
{:else}
 {#each edits.rows as request(request.id)}
  {@const addon=store.addons.find(a=>a.id===request.addon_id)}
  <section class="panel mb-4 p-4" aria-label={'Edit proposal for '+(addon?.name??'addon')}>
   <h2 class="font-bold">{#if addon}<a class="text-accent" href={entryHref(addon)}>{addon.name}</a>{:else}Addon no longer available{/if}</h2>
   <p class="mb-3 text-sm text-muted">Proposed by {request.proposer?.username??'a contributor'}</p>
   {#each Object.keys(request.changes) as field}
    {@const key=field as EditField}
    <div class="border-t border-border py-3">
     <label class="flex items-center gap-2"><input type="checkbox" value={key} bind:group={selected[request.id]} disabled={busy===request.id} />{FIELD_LABELS[key]}</label>
     {#if conflict(request,key)}<p class="text-danger">This field changed since the proposal. Leave it unselected and ask the contributor to revise it.</p>{/if}
     <div class="mt-2 grid gap-3 md:grid-cols-2">
      <div><h3 class="text-sm text-muted">Current</h3><p class="break-words whitespace-pre-wrap">{value(current(request,key))}</p></div>
      <div><h3 class="text-sm text-accent">Proposed</h3><p class="break-words whitespace-pre-wrap">{value(request.changes[key])}</p></div>
     </div>
    </div>
   {/each}
   <div class="mt-3 flex gap-2">
    <button class="btn btn-primary" disabled={busy===request.id||!selected[request.id]?.length||!addon} onclick={()=>decide(request,true)}>Accept selected fields</button>
    <button class="btn" disabled={busy===request.id} onclick={()=>decide(request,false)}>Reject proposal</button>
   </div>
  </section>
 {/each}
{/if}
{#if edits.hasMore || (!edits.loaded && edits.error)}
 <button class="btn mb-4 w-full" disabled={edits.loading} onclick={edits.loadMore}>
  {edits.loaded ? 'Show more edit proposals' : 'Retry loading edit proposals'}
 </button>
{/if}
