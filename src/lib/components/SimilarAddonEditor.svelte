<script lang="ts">
 import { tick } from 'svelte';
 import { updateAddon } from '#lib/addons.svelte.ts';
 import type { Addon } from '#lib/types.ts';
 let { addon }: { addon: Addon } = $props();
 let open = $state(false), value = $state(''), since = $state('');
 let busy = $state(false), error = $state(''), message = $state('');
 let input = $state<HTMLInputElement>();
 async function show() {
  value = addon.similar_addons ?? '';
  since = addon.updated_at;
  error = ''; message = ''; open = true;
  await tick(); input?.focus();
 }
 async function save(event: SubmitEvent) {
  event.preventDefault(); busy = true; error = ''; message = '';
  try {
   const saved = await updateAddon(addon.id, { similar_addons: value }, since);
   open = false;
   message = saved.similar_addons ? 'Similar addons saved.' : 'Similar addons removed.';
  } catch (e) { error = (e as Error).message; }
  finally { busy = false; }
 }
</script>

{#if open}
 <form class="panel space-y-2 p-3" onsubmit={save}>
  <label for="admin-similar-addons" class="block">Similar addons</label>
  <input bind:this={input} id="admin-similar-addons" class="input" maxlength="500" placeholder="e.g. MPOWA, WeakAuras" bind:value={value} disabled={busy} aria-describedby="admin-similar-help" />
  <p id="admin-similar-help" class="text-sm text-muted">Separate addon names with commas. These names help visitors find alternatives in search. Leave empty to remove.</p>
  {#if error}<p class="text-sm text-danger" role="alert">{error}</p>{/if}
  <div class="flex gap-2">
   <button class="btn btn-primary" disabled={busy}>{busy ? 'Saving...' : 'Save similar addons'}</button>
   <button class="btn" type="button" disabled={busy} onclick={() => { open = false; error = ''; }}>Cancel</button>
  </div>
 </form>
{:else}
 <button class="btn w-full" onclick={show}>{addon.similar_addons ? 'Edit similar addons' : 'Add similar addons'}</button>
{/if}
{#if message}<p class="text-sm text-accent" role="status">{message}</p>{/if}
