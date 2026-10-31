<script lang="ts">
 import type { Addon } from '#lib/types.ts';
 import type { LogEntry } from '#lib/admin.ts';
 let {entry, addons}: {entry:LogEntry;addons:Addon[]}=$props();
 const before=$derived(entry.details?.groups_before);
 const after=$derived(entry.details?.groups_after);
 const ids=$derived(new Set([...(before??[]),...(after??[])].map(row=>(row as {id:number}).id)));
 const gids=$derived(new Set(addons.filter(a=>ids.has(a.id)).map(a=>a.group_id).filter(id=>id!==null)));
 const current=$derived(addons.filter(a=>ids.has(a.id)||gids.has(a.group_id!)));
 function describe(rows:unknown[]) {
  const groups=new Map<string,string[]>();
  for(const row of rows) {
   const r=row as {id:number;group_id:number|null;is_main:boolean};
   const name=addons.find(a=>a.id===r.id)?.name??'Unavailable addon';
   const key=r.group_id===null?`alone-${r.id}`:String(r.group_id);
   groups.set(key,[...(groups.get(key)??[]),`${name}${r.is_main?' (main version)':r.group_id===null?' (ungrouped)':''}`]);
  }
  return [...groups.values()].map(members=>members.join(' · '));
 }
</script>
<p class="mt-2 text-muted">Addon names are shown as they are now.</p>
<div class="mt-2 grid gap-2 xl:grid-cols-3">
 {#each [{label:'Before this change',rows:before},{label:'After this change',rows:after},{label:'Current grouping',rows:current}] as column (column.label)}
 <div class="min-w-0 border border-border p-3"><h3 class="label">{column.label}</h3>
 {#if column.rows}{#each describe(column.rows) as group,index (index)}<p class="mt-1 break-words">{group}</p>{:else}<p>No grouping.</p>{/each}{:else}<p class="text-muted">Not recorded for this entry.</p>{/if}
 </div>{/each}
</div>
