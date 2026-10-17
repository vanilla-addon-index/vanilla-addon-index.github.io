<script lang="ts">
	import AdminToolbar from '#lib/components/AdminToolbar.svelte';
	import AdminSidebarContent from '#lib/components/AdminSidebarContent.svelte';
	import AdminNavigation from '#lib/components/AdminNavigation.svelte';
 import { resolve } from '$app/paths';
 import { store } from '#lib/addons.svelte.ts';
 import { FIELD_LABELS, displayEditValue as value, loadEditReviews, decideEdit, type EditField, type EditRequest } from '#lib/edit-reviews.svelte.ts';
 import { SITE_NAME } from '#lib/config.ts';
 let requests=$state<EditRequest[]>([]);
 let selected=$state<Record<number,EditField[]>>({});
 let loaded=$state(false), busy=$state<number>(), error=$state('');
 let query=$state('');
 const matching=$derived(requests.filter(r=>[store.addons.find(a=>a.id===r.addon_id)?.name,r.proposer?.username,...Object.keys(r.changes).map(key=>FIELD_LABELS[key as EditField])].join(' ').toLowerCase().includes(query.trim().toLowerCase())));
 loadEditReviews().then(rows=>{requests=rows; for(const r of rows) selected[r.id]=Object.keys(r.changes) as EditField[]; loaded=true;}).catch(e=>error=e.message);
 const current=(r:EditRequest,key:EditField)=>store.addons.find(a=>a.id===r.addon_id)?.[key];
 const conflict=(r:EditRequest,key:EditField)=>JSON.stringify(current(r,key))!==JSON.stringify(r.base[key]);
 async function decide(r:EditRequest,accept:boolean){
  error='';busy=r.id;
  try{await decideEdit(r.id,accept,selected[r.id]);requests=requests.filter(a=>a.id!==r.id);}
  catch(e){error=(e as Error).message;}finally{busy=undefined;}
 }
</script>
<svelte:head><title>Edit reviews · {SITE_NAME}</title></svelte:head>
<AdminToolbar>
 <input class="input w-full" type="search" aria-label="Search edit reviews" placeholder="Search edit reviews" bind:value={query} />
 <AdminNavigation />
</AdminToolbar>
<AdminSidebarContent>
	<div class="panel p-3"><h1 class="text-2xl font-bold">Edit reviews</h1><p class="text-muted">Review contributor proposals.</p></div>
	<dl class="panel p-3"><div class="flex justify-between gap-2"><dt class="text-muted">Waiting</dt><dd>{loaded ? requests.length : '…'}</dd></div></dl>
	<p class="panel p-3 text-sm text-muted">Select the fields to accept. Conflicting fields need a revised proposal; accepting other fields preserves the current page.</p>
</AdminSidebarContent>
{#if error}<p class="mb-3 text-danger" role="alert">{error}</p>{/if}
{#if !loaded}<p>Loading edit proposals…</p>
{:else if !requests.length}<p class="panel p-4 text-muted">No edits are waiting for review.</p>
{:else if !matching.length}<p class="panel p-4 text-muted">No edit reviews match your search.</p>
{:else}
 {#each matching as request(request.id)}
  {@const addon=store.addons.find(a=>a.id===request.addon_id)}
  <section class="panel mb-4 p-4" aria-label={'Edit proposal for '+(addon?.name??'addon')}>
   <h2 class="font-bold">{#if addon}<a class="text-accent" href={resolve('/addon/[slug]',{slug:addon.slug})}>{addon.name}</a>{:else}Addon no longer available{/if}</h2>
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
