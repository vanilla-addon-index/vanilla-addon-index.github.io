<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { auth } from '#lib/auth.svelte.ts';
	import { OAUTH_PROVIDERS, PROVIDER_NAMES, SITE_NAME } from '#lib/config.ts';
	import { rememberReturn, takeReturn } from '#lib/return.ts';
	import { supabase } from '#lib/supabase.ts';

	let error = $state('');

	// The page the "Log in" link was clicked on, kept for after the login: see return.ts.
	rememberReturn(page.url.searchParams.get('next'));

	$effect(() => {
		// takeReturn only ever gives a page of this site.
		if (auth.session) goto(takeReturn() ?? resolve('/'), { replaceState: true });
	});

	async function login(provider: (typeof OAUTH_PROVIDERS)[number]) {
		if (!supabase) return;
		const { error: e } = await supabase.auth.signInWithOAuth({
			provider,
			options: { redirectTo: location.origin }
		});
		if (e) error = e.message;
	}

	// True only under `npm run dev:local`. Written out in full so that the build of the real
	// site can tell it is never true there, and leaves the test accounts out altogether.
	const local = import.meta.env.MODE === 'localdb';
</script>

<svelte:head>
	<title>Log in · {SITE_NAME}</title>
</svelte:head>

{#if auth.ready && !auth.session}
<div class="panel mx-auto mt-8 max-w-sm p-5">
	<h1 class="text-2xl font-bold">Log in</h1>

	{#if !supabase}
		<p class="mt-4 text-muted">Accounts are unavailable until the database is connected.</p>
	{:else}
		<p class="mt-2 text-muted">
			Log in to post addons and manage the ones you posted. Your account is created the first time
			you log in.
		</p>
		<div class="mt-5 space-y-2">
			{#if local}
				{#await import('#lib/components/LocalLogin.svelte') then { default: LocalLogin }}
					<LocalLogin onerror={(message) => (error = message)} />
				{/await}
			{:else}
				{#each OAUTH_PROVIDERS as provider (provider)}
					<button class="btn w-full py-2" onclick={() => login(provider)}>
						Continue with {PROVIDER_NAMES[provider]}
					</button>
				{/each}
			{/if}
		</div>
		{#if error}<p class="mt-4 text-danger">{error}</p>{/if}
		<p class="mt-5 text-sm text-muted">
			GitHub and Discord will ask to share your email address. The login service requires it; this
			site never displays it, publishes it or sends you email.
			<a href={resolve('/about#privacy')} class="underline hover:text-accent">What is stored</a>
		</p>
	{/if}
</div>
{/if}
