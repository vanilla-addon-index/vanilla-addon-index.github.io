<script lang="ts">
 import { tick } from 'svelte';
 import { updateAddon } from '#lib/addons.svelte.ts';
 import type { Addon } from '#lib/types.ts';
 let { addon }: { addon: Addon } = $props();
 let open = $state(false), value = $state(''), since = $state('');
 let busy = $state(false), error = $state(''), message = $state('');
 let input = $state<HTMLInputElement>();
 let trigger = $state<HTMLButtonElement>();
 async function close() {
  open = false;
  error = '';
  await tick();
  trigger?.focus();
 }
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
   message = saved.similar_addons ? 'Similar addons saved.' : 'Similar addons removed.';
   await close();
  } catch (e) { error = (e as Error).message; }
  finally { busy = false; }
 }
</script>

{#if open}
 <form class="space-y-2" onsubmit={save}>
  <label for="admin-similar-addons" class="block">Similar addons</label>
  <input bind:this={input} id="admin-similar-addons" class="input" maxlength="500" placeholder="e.g. MPOWA, WeakAuras" bind:value={value} disabled={busy} aria-describedby="admin-similar-help" />
  <p id="admin-similar-help" class="text-sm text-muted">Separate names with commas. Clear the field to remove them.</p>
  {#if error}<p class="text-sm text-danger" role="alert">{error}</p>{/if}
  <div class="flex flex-wrap gap-2">
   <button class="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save similar addons'}</button>
   <button class="btn" type="button" disabled={busy} onclick={close}>Cancel</button>
  </div>
 </form>
{:else}
 {#if addon.similar_addons}<p class="text-sm text-muted [overflow-wrap:anywhere]">{addon.similar_addons}</p>{/if}
 <button bind:this={trigger} class="btn w-full" onclick={show}>{addon.similar_addons ? 'Edit similar addons' : 'Add similar addons'}</button>
{/if}
{#if message}<p class="text-sm text-accent" role="status">{message}</p>{/if}
