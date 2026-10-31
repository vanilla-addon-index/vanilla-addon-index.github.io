<script lang="ts">
 import { safeHistoryUrl, textParts } from '#lib/history.ts';
 let { field, value, against, mode = 'current' }: {field:string;value:unknown;against?:unknown;mode?:'before'|'after'|'current'}=$props();
 const links=$derived(Array.isArray(value)?value:[]);
</script>
{#if value === undefined}
 <p class="text-muted">Not recorded for this entry.</p>
{:else if field === 'versions'}
 <ul class="space-y-2">{#each links as link,index (index)}
  <li class="break-words">{#if safeHistoryUrl(link?.url)}<a class="text-accent underline" href={safeHistoryUrl(link.url)} target="_blank" rel="noopener noreferrer">{link.url}</a>{:else}<span>{String(link?.url??'Invalid link')}</span>{/if}
  {#if link?.note}<p class="whitespace-pre-wrap">{link.note}</p>{/if}</li>
 {:else}<li class="text-muted">No download links.</li>{/each}</ul>
{:else if field === 'unavailable_links'}
 <ul>{#each links as link,index (index)}<li class="break-words">{#if safeHistoryUrl(link)}<a href={safeHistoryUrl(link)} class="text-accent underline" target="_blank" rel="noopener noreferrer">{link}</a>{:else}{String(link)}{/if}</li>{:else}<li>No unavailable links.</li>{/each}</ul>
{:else if field === 'images'}
 <div class="flex flex-wrap gap-2">{#each links as url,index (index)}
  {#if safeHistoryUrl(url)}<a href={safeHistoryUrl(url)} target="_blank" rel="noopener noreferrer" class="max-w-full text-accent underline"><img class="h-24 max-w-full object-contain" src={safeHistoryUrl(url)} alt={`Screenshot ${index+1}`} loading="lazy" referrerpolicy="no-referrer" /><span class="block max-w-56 truncate text-xs">{url}</span></a>{:else}<span class="break-words">{String(url)}</span>{/if}
 {:else}<p class="text-muted">No screenshots.</p>{/each}</div>
{:else if typeof value === 'boolean'}
 <p>{value?'Yes':'No'}</p>
{:else if field === 'description' && typeof value === 'string' && typeof against === 'string' && mode !== 'current'}
 <p class="font-read leading-relaxed break-words whitespace-pre-wrap">{#each textParts(value,against) as part,index (index)}{#if part.changed && mode==='before'}<del class="bg-danger/10 decoration-danger">{part.text}</del>{:else if part.changed}<ins class="bg-accent/10 decoration-accent">{part.text}</ins>{:else}{part.text}{/if}{/each}</p>
{:else if field === 'pinned_link' && safeHistoryUrl(value)}
 <a href={safeHistoryUrl(value)} target="_blank" rel="noopener noreferrer" class="break-words text-accent underline">{String(value)}</a>
{:else}
 <p class="leading-relaxed break-words whitespace-pre-wrap">{value===null||value===''?'Not set':String(value)}</p>
{/if}
