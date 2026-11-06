<script lang="ts">
 import type { EntryType } from '#lib/types.ts';
 let { value, onchange }: { value: EntryType; onchange: (value: EntryType) => void } = $props();
</script>
<div class="flex h-[calc(2.25rem+2px)] border border-border bg-bg p-1" role="group" aria-label="Collection">
 {#each [['addon', 'Addons'], ['dll', 'DLL']] as [type, label]}
  <button type="button" aria-pressed={value === type}
   class={['min-h-0 flex-1 px-2 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-accent', value === type ? 'bg-raised text-accent shadow-sm' : 'text-muted hover:text-fg']}
   onclick={() => onchange(type as EntryType)}>{label}</button>
 {/each}
</div>
