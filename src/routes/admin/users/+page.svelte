<script lang="ts">
	import { resolve } from '$app/paths';
	import AdminToolbar from '#lib/components/AdminToolbar.svelte';
	import AdminSidebarContent from '#lib/components/AdminSidebarContent.svelte';
	import AdminNavigation from '#lib/components/AdminNavigation.svelte';
	import ReviewQueueRow from '#lib/components/ReviewQueueRow.svelte';
	import { listUsers, listDeletedAccounts, type DeletedAccount, loginsOf, remembered, setAdmin, setBanned, type UserRow } from '#lib/admin.ts';
	import { ownedBy, ownedText } from '#lib/addons.svelte.ts';
	import { auth } from '#lib/auth.svelte.ts';
	import { SITE_NAME } from '#lib/config.ts';
	import { ask } from '#lib/confirm.svelte.ts';

	const ROLES: Record<UserRow['role'], string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

	let users = $state<UserRow[]>(remembered.users ?? []);
	let selectedId = $state<string>();
	let loaded = $state(Boolean(remembered.users));
	let query = $state('');
	let notice = $state('');
	let error = $state('');
	let working = $state(false);
	let deletedAccounts = $state<DeletedAccount[]>([]);
	let moreDeleted = $state(false);
	let loadingDeleted = $state(false);
	let deletedError = $state('');
	function toggleAccount(id: string) {
		selectedId = selectedId === id ? undefined : id;
	}

	async function loadDeleted(older = false) {
		loadingDeleted = true;
		deletedError = '';
		try {
			const rows = await listDeletedAccounts(null, older ? deletedAccounts.at(-1)?.id ?? null : null);
			if (!auth.isOwner) return;
			deletedAccounts = older ? [...deletedAccounts, ...rows] : rows;
			moreDeleted = rows.length === 200;
		} catch (e) { deletedError = (e as Error).message; }
		finally { loadingDeleted = false; }
	}
	$effect(() => {
		if (auth.isOwner) void loadDeleted();
		else deletedAccounts = [];
	});

	let searchId = 0;
	async function search(term = query.trim()) {
		const id = ++searchId;
		try {
			const matches = await listUsers(term);
			if (id !== searchId || term !== query.trim()) return;
			users = matches;
			error = '';
			// Only the unfiltered list is worth showing again later.
			if (!term) remembered.users = users;
			loaded = true;
		} catch (e) {
			if (id === searchId && term === query.trim()) error = (e as Error).message;
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

	async function changeAccount(question: Parameters<typeof ask>[0], apply: () => Promise<unknown>, message: string) {
		if (working) return;
		working = true;
		try {
			if (!(await ask(question))) return;
			error = notice = '';
			await apply();
			await search();
			notice = message;
		} catch (e) {
			error = (e as Error).message;
		} finally {
			working = false;
		}
	}

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
		await changeAccount(question, () => setAdmin(user.id, value),
			value ? `${user.username} is an admin.` : `${user.username} is no longer an admin.`);
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
		await changeAccount(question, () => setBanned(user.id, value),
			value ? `${user.username} is banned.` : `${user.username} can post again.`);
	}
</script>

<svelte:head>
	<title>Users · {SITE_NAME}</title>
</svelte:head>

<AdminSidebarContent>
	<div class="panel">
		<header class="border-b border-border px-3 py-2">
			<h1 class="text-2xl leading-tight font-bold">Users</h1>
			<p class="text-sm text-muted">Accounts and permissions.</p>
		</header>
		<dl class="space-y-1 px-3 py-2 text-sm">
			<div class="mb-1.5 flex justify-between gap-2 border-b border-border pb-1.5 font-semibold">
				<dt>Displayed accounts</dt><dd class="tabular-nums">{loaded ? users.length : '…'}</dd>
			</div>
			{#each Object.entries(ROLES) as [role, label] (role)}
				<div class="flex justify-between gap-2">
					<dt class="text-muted">{label}</dt><dd class="tabular-nums">{loaded ? users.filter(user => user.role === role).length : '…'}</dd>
				</div>
			{/each}
			<div class="flex justify-between gap-2">
				<dt class="text-muted">Banned / suspended</dt><dd class="tabular-nums">{loaded ? users.filter(user => user.banned).length : '…'}</dd>
			</div>
		</dl>
		{#if auth.isOwner}
			<div class="border-t border-border px-3 py-2 text-sm">
				<a href="#deleted-accounts" class="text-accent hover:underline">Deleted account recovery</a>
			</div>
		{/if}
	</div>
</AdminSidebarContent>

<AdminToolbar>
	<input class="input w-full" type="search" placeholder="Search by username" aria-label="Search accounts" bind:value={query} />
	<AdminNavigation />
</AdminToolbar>

<div aria-live="polite">
	{#if error || notice}
		<p class={['mb-2 break-words', error ? 'text-danger' : 'text-accent']}>{error || notice}</p>
	{/if}
</div>

<div class="panel">
	{#if !loaded}
		<p class="px-4 py-5 text-center text-muted">{error ? 'Unable to load accounts.' : 'Loading accounts…'}</p>
	{:else if !users.length}
		<div class="px-4 py-5 text-center">
			<h2 class="font-semibold">{query.trim() ? 'No account matches.' : 'No accounts to show.'}</h2>
			{#if query.trim()}<p class="mt-1 text-sm text-muted">Try a different username.</p>{/if}
		</div>
	{:else}
		{#each users as user (user.id)}
			{@const providers = loginsOf(user)}
			<ReviewQueueRow
				rowId={'user-' + user.id}
				title={user.username}
				subtitle={'Joined ' + date(user.joined)}
				selected={selectedId === user.id}
				collapsible
				onselect={() => toggleAccount(user.id)}
			>
				{#snippet badges()}
					<span class={['admin-badge', user.role === 'member' ? 'border-border text-muted' : 'border-accent/30 text-accent']}>{ROLES[user.role]}</span>
					{#if user.banned}<span class="admin-badge border-danger/35 text-danger">{user.role === 'admin' ? 'Suspended' : 'Banned'}</span>{/if}
				{/snippet}
				{#if selectedId === user.id}
					<div class="flex flex-wrap items-center gap-2" role="group" aria-label="Account actions">
						<a class="btn py-1" href={resolve(`/admin/users/profile?name=${encodeURIComponent(user.username)}`)}>Open profile</a>
						{#if mayBan(user)}
							{#if auth.isOwner}
								<button class="btn py-1" disabled={working} onclick={() => appoint(user, user.role !== 'admin')}>
									{user.role === 'admin' ? 'Remove admin' : 'Make admin'}
								</button>
							{/if}
							{#if user.banned}
								<button class="btn py-1" disabled={working} onclick={() => ban(user, false)}>Lift the ban</button>
							{:else}
								<button class="btn btn-danger py-1" disabled={working} onclick={() => ban(user, true)}>
									{user.role === 'admin' ? 'Suspend' : 'Ban'}
								</button>
							{/if}
						{/if}
					</div>
					<section class="mt-2 space-y-1 border-t border-border pt-2 text-sm" aria-label="Account details">
						<h3 class="font-semibold">Details</h3>
						{#if providers}<p class="text-muted">Sign-in providers <span class="ml-1 text-fg">{providers}</span></p>{/if}
						<p class="text-muted">{ownedText(ownedBy(user.id)).join(' · ')}</p>
					</section>
				{/if}
			</ReviewQueueRow>
		{/each}
	{/if}
</div>
{#if loaded && users.length === 200}
	<p class="mt-2 text-sm text-muted">Showing the first 200 accounts. Search to find others.</p>
{/if}

{#if auth.isOwner}
	<section id="deleted-accounts" class="panel mt-3" aria-label="Deleted account recovery">
		<header class="border-b border-border px-3 py-2">
			<h2 class="font-semibold">Deleted account recovery</h2>
			<p class="text-sm text-muted">Review and roll back activity from deleted accounts.</p>
		</header>
		{#if deletedError}
			<p class="px-3 py-2 text-sm text-danger" role="alert">{deletedError}</p>
		{:else if loadingDeleted && !deletedAccounts.length}
			<p class="px-3 py-2 text-sm text-muted">Loading deleted accounts…</p>
		{/if}
		{#each deletedAccounts as account (account.id)}
			<ReviewQueueRow
				rowId={'deleted-user-' + account.id}
				title={'Recovery record ' + account.id.slice(0, 8)}
				subtitle={'Deleted ' + date(account.deleted_at)}
				selected={selectedId === account.id}
				collapsible
				onselect={() => toggleAccount(account.id)}
			>
				{#snippet badges()}
					<span class="admin-badge border-danger/35 text-danger">Deleted</span>
					<span class="admin-badge border-border text-muted tabular-nums">{account.actions} {account.actions === 1 ? 'logged action' : 'logged actions'}</span>
				{/snippet}
				{#if selectedId === account.id}
					<div class="flex flex-wrap items-center gap-2" role="group" aria-label="Account actions">
						<a class="btn py-1" href={resolve(`/admin/users/profile?deleted=${account.id}`)}>Open recovery profile</a>
					</div>
					<section class="mt-2 space-y-1 border-t border-border pt-2 text-sm" aria-label="Account details">
						<h3 class="font-semibold">Details</h3>
						<p class="text-muted">Recovery ID <span class="ml-1 [overflow-wrap:anywhere] text-fg">{account.id}</span></p>
					</section>
				{/if}
			</ReviewQueueRow>
		{:else}
			{#if !loadingDeleted && !deletedError}<p class="px-3 py-2 text-sm text-muted">No deleted accounts recorded.</p>{/if}
		{/each}
		{#if moreDeleted || deletedError}
			<div class="border-t border-border p-2">
				<button class="btn w-full" disabled={loadingDeleted} onclick={() => loadDeleted(deletedAccounts.length > 0)}>
					{loadingDeleted ? 'Loading…' : deletedError ? 'Retry loading deleted accounts' : 'Load older deleted accounts'}
				</button>
			</div>
		{/if}
	</section>
{/if}
