<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { myAddons } from '#lib/addons.svelte.ts';
	import { auth } from '#lib/auth.svelte.ts';
	import AddonCard from '#lib/components/AddonCard.svelte';
	import { SITE_NAME } from '#lib/config.ts';
	import { supabase } from '#lib/supabase.ts';

	const PROVIDERS: Record<string, string> = { discord: 'Discord', github: 'GitHub' };

	const mine = $derived(myAddons());
	const user = $derived(auth.session?.user);
	const logins = $derived(
		(user?.app_metadata.providers as string[] | undefined)?.map((p) => PROVIDERS[p] ?? p).join(', ')
	);
	const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });

	async function signOut() {
		await goto(resolve('/'));
		await supabase?.auth.signOut();
	}
</script>

<svelte:head>
	<title>Account · {SITE_NAME}</title>
</svelte:head>

{#snippet fact(label: string, value: string)}
	<div class="flex justify-between gap-4 border-b border-border px-3 py-1.5 last:border-b-0">
		<dt class="text-muted">{label}</dt>
		<dd class="truncate">{value}</dd>
	</div>
{/snippet}

{#if !auth.ready}
	<p class="py-12 text-center text-muted">Loading…</p>
{:else if !user}
	<div class="panel mx-auto mt-8 max-w-sm p-5 text-center">
		<p class="text-muted">You are not logged in.</p>
		<a href={resolve('/login')} class="btn btn-primary mt-4">Log in</a>
	</div>
{:else}
	<div class="grid items-start gap-4 md:grid-cols-[13rem_minmax(0,1fr)]">
		<aside class="space-y-2">
			<div class="panel">
				<div class="border-b border-border px-3 py-3">
					<h1 class="truncate text-2xl leading-tight font-bold">{auth.username}</h1>
					<p class={auth.isAdmin ? 'text-accent' : 'text-muted'}>
						{auth.isAdmin ? 'Admin' : 'Member'}
					</p>
				</div>
				<dl>
					{@render fact('Addons posted', String(mine.length))}
					{#if logins}{@render fact('Linked account', logins)}{/if}
					{@render fact('Joined', date(user.created_at))}
				</dl>
			</div>
			<button class="btn w-full" onclick={signOut}>Log out</button>
		</aside>

		<section>
			<h2 class="label">Your addons</h2>
			<div class="panel">
				{#each mine as addon (addon.id)}
					<AddonCard {addon} />
				{:else}
					<p class="px-3 py-8 text-center text-muted">You have not posted anything yet.</p>
				{/each}
			</div>
		</section>
	</div>
{/if}
