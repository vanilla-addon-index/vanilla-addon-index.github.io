<script lang="ts">
 import type { LogEntry, RecoveryComparison } from '#lib/admin.ts';
 import { fieldLabel, changeSummary, visibleHistoryFields } from '#lib/history.ts';
 import HistoryValue from './HistoryValue.svelte';
 let { entry, comparison }: {entry:LogEntry;comparison?:RecoveryComparison}=$props();
 const fields=$derived(visibleHistoryFields(entry.details?.changed??[]));
 const before=$derived(entry.details?.before??{});
 const after=$derived(entry.details?.after);
 const when=(at:string)=>new Date(at).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});
</script>
<p class="my-2 text-sm text-muted">{changeSummary(fields,before,after)}</p>
{#if comparison?.later.length}
 <details class="my-2 text-sm"><summary class="cursor-pointer text-muted">Later changes · latest {comparison.later.length}</summary>
 {#each comparison.later as change,index (index)}<p class="mt-1">{change.actor??'Deleted account'} · {when(change.at)} · {(change.fields??[]).map(fieldLabel).join(', ')}</p>{/each}</details>
{/if}
{#each fields as field (field)}
 <section class="my-3" aria-label={`${fieldLabel(field)} comparison`}>
 <h3 class="font-bold">{fieldLabel(field)} {#if comparison?.conflicts.includes(field)}<span class="text-sm text-danger">· Conflicts with later changes</span>{/if}</h3>
 <div class="mt-1 grid gap-2 xl:grid-cols-3">
 {#each ['before','after','current'] as mode (mode)}
  <div class={['min-w-0 border border-border p-3',mode==='current'&&comparison?.conflicts.includes(field)&&'border-danger/50']}>
   <h4 class="label">{mode==='before'?'Before this edit':mode==='after'?'After this edit':'Current content'}</h4>
   <HistoryValue {field} value={mode==='before'?before[field]:mode==='after'?after?.[field]:comparison?.current[field]} against={mode==='before'?after?.[field]:before[field]} mode={mode as 'before'|'after'|'current'} />
  </div>
 {/each}
 </div></section>
{/each}
<details class="my-2 text-sm"><summary class="cursor-pointer text-muted">Technical details</summary><pre class="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(entry.details,null,2)}</pre></details>
