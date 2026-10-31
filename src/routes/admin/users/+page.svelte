<script lang="ts">
	import { resolve } from '$app/paths';
	import AdminToolbar from '#lib/components/AdminToolbar.svelte';
	import AdminSidebarContent from '#lib/components/AdminSidebarContent.svelte';
	import AdminNavigation from '#lib/components/AdminNavigation.svelte';
	import { listUsers, listDeletedAccounts, type DeletedAccount, loginsOf, remembered, setAdmin, setBanned, type UserRow } from '#lib/admin.ts';
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
	let deletedAccounts = $state<DeletedAccount[]>([]);
	let moreDeleted = $state(false);
	let loadingDeleted = $state(false);
	async function loadDeleted(older = false) {
		loadingDeleted = true;
		try {
			const rows = await listDeletedAccounts(null, older ? deletedAccounts.at(-1)?.id ?? null : null);
			if (!auth.isOwner) return;
			deletedAccounts = older ? [...deletedAccounts, ...rows] : rows;
			moreDeleted = rows.length === 200;
		} catch (e) { error = (e as Error).message; }
		finally { loadingDeleted = false; }
	}
	$effect(() => {
		if (auth.isOwner) void loadDeleted();
		else deletedAccounts = [];
	});

	async function search(term = query.trim()) {
		try {
			const matches = await listUsers(term);
			if (term !== query.trim()) return;
			users = matches;
			error = '';
			// Only the unfiltered list is worth showing again later.
			if (!term) remembered.users = users;
			loaded = true;
		} catch (e) {
			if (term === query.trim()) error = (e as Error).message;
		}
	}
	$effect(() => {
		const term = query.trim();
		const typing = setTimeout(() => search(term), 300);
		return () => clearTimeout(typing);
	});

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

<AdminToolbar>
<AdminSidebarContent>
	<div class="panel p-3"><h1 class="text-2xl font-bold">Users</h1><p class="text-muted">Accounts and permissions.</p></div>
	<div class="panel p-3">
		<h2 class="label">Displayed accounts</h2>
		<dl class="space-y-2 text-sm">
			{#each Object.entries(ROLES) as [role,label]}
				<div class="flex justify-between gap-2"><dt class="text-muted">{label}</dt><dd>{loaded ? users.filter(user => user.role === role).length : '…'}</dd></div>
			{/each}
			<div class="flex justify-between gap-2"><dt class="text-muted">Banned / suspended</dt><dd>{loaded ? users.filter(user => user.banned).length : '…'}</dd></div>
		</dl>
	</div>
	<p class="panel p-3 text-sm text-muted">Search by username. Open a profile to review contributions and recovery options. Only the owner can change admin roles.</p>
</AdminSidebarContent>
<input class="input w-full" type="search" placeholder="Search by username" aria-label="Search accounts" bind:value={query} />
<AdminNavigation />
</AdminToolbar>

<div aria-live="polite">
{#if error || notice}
<p class={['mb-2 truncate', error ? 'text-danger' : 'text-accent']}>
	{error || notice}
</p>
{/if}
</div>

<div class="panel">
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

{#if auth.isOwner}
 <section class="panel mt-5 p-3" aria-label="Deleted account recovery">
  <h2 class="font-bold">Deleted account recovery</h2>
  <p class="text-sm text-muted">Review and roll back activity after an account leaves. Login details and usernames are removed.</p>
  {#each deletedAccounts as account (account.id)}
   <a class="mt-2 block text-accent hover:underline" href={resolve(`/admin/users/profile?deleted=${account.id}`)}>
    Deleted {new Date(account.deleted_at).toLocaleString()} · {account.actions} logged actions · {account.id.slice(0, 8)}
   </a>
  {:else}<p class="mt-2 text-sm text-muted">No deleted accounts recorded.</p>{/each}
  {#if moreDeleted}<button class="btn mt-3" disabled={loadingDeleted} onclick={() => loadDeleted(true)}>{loadingDeleted ? 'Loading…' : 'Load older deleted accounts'}</button>{/if}
 </section>
{/if}
