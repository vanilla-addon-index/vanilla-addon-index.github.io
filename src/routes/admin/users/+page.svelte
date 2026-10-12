<script lang="ts">
	import { listUsers, loginsOf, remembered, setAdmin, setBanned, type UserRow } from '#lib/admin.ts';
	import { ownedBy, ownedText } from '#lib/addons.svelte.ts';
	import { auth } from '#lib/auth.svelte.ts';
	import UserLink from '#lib/components/UserLink.svelte';
	import { SITE_NAME } from '#lib/config.ts';
	import { ask } from '#lib/confirm.svelte.ts';

	const ROLES: Record<UserRow['role'], string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

	let users = $state<UserRow[]>(remembered.users ?? []);
	let loaded = $state(Boolean(remembered.users));
	let query = $state('');
	let notice = $state('');
	let error = $state('');

	async function search() {
		try {
			users = await listUsers(query.trim());
			// Only the unfiltered list is worth showing again later.
			if (!query.trim()) remembered.users = users;
			loaded = true;
		} catch (e) {
			error = (e as Error).message;
		}
	}
	search();

	const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });

	// Admins may ban members. Only the owner may suspend an admin, and nobody the owner.
	const mayBan = (user: UserRow) =>
		user.id !== auth.session?.user.id && user.role !== 'owner' && (user.role === 'member' || auth.isOwner);

	// The owner appoints the admins, and nobody else does.
	async function appoint(user: UserRow, value: boolean) {
		const question = value
			? {
					title: `Make ${user.username} an admin?`,
					body: 'They will be able to edit and delete any addon, review imports and reports, and ban members. Everything they do is logged and can be undone, and you can take the role away again.',
					action: 'Make admin'
				}
			: {
					title: `Remove ${user.username} as an admin?`,
					body: 'They become an ordinary member again. What they did as an admin stays as it is.',
					action: 'Remove admin',
					danger: true
				};
		if (!(await ask(question))) return;
		error = notice = '';
		try {
			await setAdmin(user.id, value);
			await search();
			notice = value ? `${user.username} is an admin.` : `${user.username} is no longer an admin.`;
		} catch (e) {
			error = (e as Error).message;
		}
	}

	async function ban(user: UserRow, value: boolean) {
		const verb = user.role === 'admin' ? 'Suspend' : 'Ban';
		const question = !value
			? {
					title: `Lift the ban on ${user.username}?`,
					body: 'They will be able to post and edit again.',
					action: 'Lift the ban'
				}
			: {
					title: `${verb} ${user.username}?`,
					body: 'They can still browse but not post or edit. What they posted stays up; delete any of it yourself if it has to go.',
					action: verb,
					danger: true
				};
		if (!(await ask(question))) return;
		error = notice = '';
		try {
			await setBanned(user.id, value);
			await search();
			notice = value ? `${user.username} is banned.` : `${user.username} can post again.`;
		} catch (e) {
			error = (e as Error).message;
		}
	}
</script>

<svelte:head>
	<title>Users · {SITE_NAME}</title>
</svelte:head>

<form
	class="flex gap-2"
	onsubmit={(e) => {
		e.preventDefault();
		search();
	}}
>
	<input class="input" type="search" placeholder="Search by username" aria-label="Search accounts" bind:value={query} />
	<button class="btn shrink-0">Search</button>
</form>

<p class={['mt-2 min-h-[1lh] truncate', error ? 'text-danger' : 'text-accent']} aria-live="polite">
	{error || notice}
</p>

<div class="panel mt-1">
	{#if !loaded}
		<p class="px-3 py-8 text-center text-muted">Loading accounts…</p>
	{:else if !users.length}
		<p class="px-3 py-8 text-center text-muted">No account matches.</p>
	{:else}
		{#each users as user (user.id)}
			<div class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-3 py-2 last:border-b-0">
				<div class="min-w-0 flex-1">
					<p class="truncate">
						<UserLink name={user.username} class="font-bold" />
						<span class={user.role === 'member' ? 'text-muted' : 'text-accent'}>{ROLES[user.role]}</span>
						{#if user.banned}<span class="text-danger">{user.role === 'admin' ? 'Suspended' : 'Banned'}</span>{/if}
					</p>
					<p class="text-sm text-muted">
						{#if loginsOf(user)}{loginsOf(user)} · {/if}Joined {date(user.joined)} · {ownedText(ownedBy(user.id)).join(' · ')}
					</p>
				</div>
				{#if mayBan(user)}
					<div class="flex flex-wrap gap-2">
						{#if auth.isOwner}
							<button class="btn py-1" onclick={() => appoint(user, user.role !== 'admin')}>
								{user.role === 'admin' ? 'Remove admin' : 'Make admin'}
							</button>
						{/if}
						{#if user.banned}
							<button class="btn py-1" onclick={() => ban(user, false)}>Lift the ban</button>
						{:else}
							<button class="btn btn-danger py-1" onclick={() => ban(user, true)}>
								{user.role === 'admin' ? 'Suspend' : 'Ban'}
							</button>
						{/if}
					</div>
				{/if}
			</div>
		{/each}
	{/if}
</div>
{#if loaded && users.length === 200}
	<p class="hint">Showing the first 200 accounts. Search to find others.</p>
{/if}
