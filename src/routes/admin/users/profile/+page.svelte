<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		ACTION_TEXT,
		listUsers,
		loadLogAbout,
		loginsOf,
		setBanned,
		type LogEntry,
		type UserRow
	} from '#lib/admin.ts';
	import { loadAddons, store } from '#lib/addons.svelte.ts';
	import { auth } from '#lib/auth.svelte.ts';
	import AddonCard from '#lib/components/AddonCard.svelte';
	import { SITE_NAME } from '#lib/config.ts';
	import { ask } from '#lib/confirm.svelte.ts';

	const ROLES: Record<UserRow['role'], string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

	const name = $derived(page.url.searchParams.get('name') ?? '');
	let user = $state<UserRow>();
	let activity = $state<LogEntry[]>([]);
	let loaded = $state(false);
	let notice = $state('');
	let error = $state('');

	async function load(username: string) {
		loaded = false;
		error = notice = '';
		try {
			// The search matches part of a name; the profile is the exact one.
			user = (await listUsers(username)).find((u) => u.username.toLowerCase() === username.toLowerCase());
			activity = user ? await loadLogAbout(user) : [];
		} catch (e) {
			error = (e as Error).message;
		}
		loaded = true;
	}
	// Runs again when a link on this page leads to another account.
	$effect(() => {
		load(name);
	});

	const posted = $derived(store.addons.filter((a) => a.owner === user?.id));
	const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
	const when = (iso: string) =>
		new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

	// Admins may ban members. Only the owner may suspend an admin, and nobody the owner.
	const mayBan = $derived(
		user !== undefined &&
			user.id !== auth.session?.user.id &&
			user.role !== 'owner' &&
			(user.role === 'member' || auth.isOwner)
	);
	const verb = $derived(user?.role === 'admin' ? 'Suspend' : 'Ban');

	async function ban(value: boolean, trash = false) {
		if (!user) return;
		const question = !value
			? {
					title: `Lift the ban on ${user.username}?`,
					body: 'They will be able to post and edit again.',
					action: 'Lift the ban'
				}
			: {
					title: `${verb} ${user.username}?`,
					body: trash
						? `They can still browse but not post or edit, and the ${user.addons} ${user.addons === 1 ? 'addon' : 'addons'} they posted ${user.addons === 1 ? 'goes' : 'go'} to the trash.`
						: 'They can still browse but not post or edit.',
					action: trash ? `${verb} and trash` : verb,
					danger: true
				};
		if (!(await ask(question))) return;
		try {
			await setBanned(user.id, value, trash);
			await Promise.all([load(user.username), trash ? loadAddons() : null]);
			notice = value ? `${user?.username} is banned.` : `${user?.username} can post again.`;
		} catch (e) {
			error = (e as Error).message;
		}
	}
</script>

<svelte:head>
	<title>{name} · {SITE_NAME}</title>
</svelte:head>

{#snippet fact(label: string, value: string)}
	<div class="flex justify-between gap-4 border-b border-border px-3 py-1.5 last:border-b-0">
		<dt class="text-muted">{label}</dt>
		<dd class="truncate">{value}</dd>
	</div>
{/snippet}

<a href={resolve('/admin/users')} class="text-muted hover:text-accent">← All accounts</a>

<p class={['mt-2 min-h-[1lh] truncate', error ? 'text-danger' : 'text-accent']} aria-live="polite">
	{error || notice}
</p>

{#if !loaded && !user}
	<p class="py-12 text-center text-muted">Loading…</p>
{:else if !user}
	<div class="panel mx-auto mt-4 max-w-sm p-5 text-center">
		<p class="text-muted">There is no account named "{name}".</p>
	</div>
{:else}
	<div class="mt-1 grid items-start gap-4 md:grid-cols-[13rem_minmax(0,1fr)]">
		<aside class="space-y-2">
			<div class="panel">
				<div class="border-b border-border px-3 py-3">
					<h1 class="truncate text-2xl leading-tight font-bold">{user.username}</h1>
					<p class={user.role === 'member' ? 'text-muted' : 'text-accent'}>{ROLES[user.role]}</p>
					{#if user.banned}
						<p class="text-danger">{user.role === 'admin' ? 'Suspended' : 'Banned'}</p>
					{/if}
				</div>
				<dl>
					{@render fact('Addons posted', String(user.addons))}
					{@render fact('Joined', date(user.joined))}
					{#if loginsOf(user)}{@render fact('Logs in with', loginsOf(user))}{/if}
				</dl>
			</div>
			{#if mayBan}
				{#if user.banned}
					<button class="btn w-full" onclick={() => ban(false)}>Lift the ban</button>
				{:else}
					<button class="btn btn-danger w-full" onclick={() => ban(true)}>{verb}</button>
					{#if user.addons}
						<button class="btn btn-danger w-full" onclick={() => ban(true, true)}>
							{verb} and trash their addons
						</button>
					{/if}
				{/if}
			{/if}
		</aside>

		<section>
			<h2 class="label">Addons posted · {posted.length}</h2>
			<div class="panel">
				{#each posted as addon (addon.id)}
					<AddonCard {addon} />
				{:else}
					<p class="px-3 py-6 text-center text-muted">Nothing live. Deleted addons are in the Trash.</p>
				{/each}
			</div>

			<h2 class="label mt-5">Recent activity</h2>
			<div class="panel">
				{#each activity as entry (entry.id)}
					<div class="flex flex-wrap items-baseline gap-x-3 border-b border-border px-3 py-1.5 last:border-b-0">
						<p class="min-w-0 flex-1 break-words">
							<!-- Lines about this account, such as a ban, were done by someone else. -->
							<span class="font-bold">{entry.actor_name ?? 'The system'}</span>
							<span class="text-muted">{ACTION_TEXT[entry.action] ?? entry.action}</span>
							{entry.action === 'user.autosuspend' ? entry.details?.reason : entry.subject}
						</p>
						<span class="shrink-0 text-sm text-muted">{when(entry.at)}</span>
					</div>
				{:else}
					<p class="px-3 py-6 text-center text-muted">Nothing logged for this account.</p>
				{/each}
			</div>
			{#if activity.length}
				<p class="hint">The latest {activity.length} lines. The Log tab has everything.</p>
			{/if}
		</section>
	</div>
{/if}
