<script lang="ts">
	import { LOCAL_ACCOUNTS, LOCAL_PASSWORD, type LocalAccount } from '#lib/local-accounts.ts';
	import { supabase } from '#lib/supabase.ts';

	let { onerror }: { onerror: (message: string) => void } = $props();

	async function login(account: LocalAccount) {
		if (!supabase) return;
		const { error } = await supabase.auth.signInWithPassword({ email: account.email, password: LOCAL_PASSWORD });
		if (error) onerror(error.message);
	}
</script>

<!-- One click per kind of account. Only ever loaded by `npm run dev:local`, against the
     copy of the backend on this computer: the real site is built without this file. -->
<p class="label">Local test accounts</p>
{#each LOCAL_ACCOUNTS as account (account.username)}
	<button class="btn w-full py-2" onclick={() => login(account)}>Log in as {account.label}</button>
{/each}
