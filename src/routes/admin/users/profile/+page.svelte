<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		ACTION_TEXT,
		ROLLBACK_TEXT,
		listUsers,
		loadLogAbout,
		loginsOf,
		rollbackAccount,
		setAdmin,
		setBanned,
		type LogEntry,
		type Rollback,
		type UserRow
	} from '#lib/admin.ts';
	import { loadAddons, ownedBy } from '#lib/addons.svelte.ts';
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
		plan = undefined;
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

	// Imports the account approved as an admin are listed apart from what it posted itself.
	const owned = $derived(ownedBy(user?.id));
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

	// Rolling back: everything the account did in a stretch of time, undone in one go. It
	// is shown first, and only happens once that list has been confirmed.
	const PERIODS = {
		'1': 'the last hour',
		'24': 'the last 24 hours',
		'168': 'the last 7 days',
		'720': 'the last 30 days',
		'0': 'all the time it has existed'
	} as const;
	type Period = keyof typeof PERIODS;
	let period = $state<Period>('24');
	// What a rollback would do, for the stretch of time it was asked about.
	let plan = $state<Rollback & { since: Date; period: Period }>();
	let working = $state(false);
	const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

	async function previewRollback() {
		if (!user) return;
		working = true;
		error = notice = '';
		try {
			const since = period === '0' ? new Date(0) : new Date(Date.now() - Number(period) * 3_600_000);
			plan = { ...(await rollbackAccount(user.id, since, true)), since, period };
		} catch (e) {
			error = (e as Error).message;
		}
		working = false;
	}

	async function runRollback() {
		if (!user || !plan) return;
		const confirmed = await ask({
			title: `Roll back ${plural(plan.steps.length, 'change')} by ${user.username}?`,
			body: 'Each one is logged under your name and can be undone from the log like any other change.',
			action: 'Roll back',
			danger: true
		});
		if (!confirmed) return;
		working = true;
		try {
			const done = await rollbackAccount(user.id, plan.since, false);
			await Promise.all([loadAddons(), load(user.username)]);
			notice =
				`Rolled back ${plural(done.steps.length, 'change')} by ${user.username}.` +
				(done.skipped.length ? ` ${plural(done.skipped.length, 'step')} could not be undone; see the log.` : '');
		} catch (e) {
			error = (e as Error).message;
		}
		working = false;
	}

	// The owner appoints the admins, and nobody else does.
	async function appoint(value: boolean) {
		if (!user) return;
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
		try {
			await setAdmin(user.id, value);
			await load(user.username);
			notice = value ? `${user?.username} is an admin.` : `${user?.username} is no longer an admin.`;
		} catch (e) {
			error = (e as Error).message;
		}
	}

	async function ban(value: boolean) {
		if (!user) return;
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
		try {
			await setBanned(user.id, value);
			await load(user.username);
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
					{@render fact('Addons posted', String(owned.posted.length))}
					{#if owned.imported.length}{@render fact('Imports approved', String(owned.imported.length))}{/if}
					{@render fact('Joined', date(user.joined))}
					{#if loginsOf(user)}{@render fact('Logs in with', loginsOf(user))}{/if}
				</dl>
			</div>
			{#if mayBan}
				{#if auth.isOwner}
					<button class="btn w-full" onclick={() => appoint(user?.role !== 'admin')}>
						{user.role === 'admin' ? 'Remove admin' : 'Make admin'}
					</button>
				{/if}
				{#if user.banned}
					<button class="btn w-full" onclick={() => ban(false)}>Lift the ban</button>
				{:else}
					<button class="btn btn-danger w-full" onclick={() => ban(true)}>{verb}</button>
				{/if}
				<div class="panel p-3">
					<h2 class="label">Roll back</h2>
					<label class="text-sm text-muted" for="period">Undo everything this account did in</label>
					<select id="period" class="input mt-1" bind:value={period}>
						{#each Object.entries(PERIODS) as [value, label] (value)}
							<option {value}>{label}</option>
						{/each}
					</select>
					<button class="btn mt-2 w-full" disabled={working} onclick={previewRollback}>
						{working ? 'Working…' : 'Show what would change'}
					</button>
				</div>
			{/if}
		</aside>

		<section>
			{#if plan}
				<div class="panel mb-5 border-accent/30">
					<div class="border-b border-border px-3 py-2">
						<h2 class="font-bold">Rolling back {user.username}, {PERIODS[plan.period]}</h2>
						<p class="text-sm text-muted">
							{plan.steps.length
								? 'Nothing has changed yet. This is what would happen, newest first.'
								: 'There is nothing to roll back in that time.'}
						</p>
					</div>
					{#each plan.steps as step, index (index)}
						<p class="border-b border-border px-3 py-1.5 break-words">
							<span class="text-muted">{ROLLBACK_TEXT[step.kind]}</span>
							{step.subject}
							{#if step.others}
								<span class="text-sm text-danger">
									· also undoes {plural(step.others, 'later edit')} by someone else
								</span>
							{/if}
						</p>
					{/each}
					{#each plan.skipped as miss, index (index)}
						<p class="border-b border-border px-3 py-1.5 text-sm break-words text-danger">
							Cannot undo "{ACTION_TEXT[miss.action] ?? miss.action} {miss.subject}": {miss.why}
						</p>
					{/each}
					<div class="flex flex-wrap gap-2 px-3 py-2">
						{#if plan.steps.length}
							<button class="btn btn-danger" disabled={working} onclick={runRollback}>
								Roll back {plural(plan.steps.length, 'change')}
							</button>
						{/if}
						<button class="btn" onclick={() => (plan = undefined)}>Close</button>
					</div>
				</div>
			{/if}
			<h2 class="label">Addons posted · {owned.posted.length}</h2>
			<div class="panel">
				{#each owned.posted as addon (addon.id)}
					<AddonCard {addon} />
				{:else}
					<p class="px-3 py-6 text-center text-muted">Nothing live. Deleted addons are in the Trash.</p>
				{/each}
			</div>

			{#if owned.imported.length}
				<!-- Closed until asked for: an admin can have approved hundreds. -->
				<details class="group mt-5">
					<summary class="label cursor-pointer hover:text-fg">
						<span class="inline-block transition-transform group-open:rotate-90">▸</span>
						Imports approved · {owned.imported.length}
					</summary>
					<div class="panel">
						{#each owned.imported as addon (addon.id)}
							<AddonCard {addon} />
						{/each}
					</div>
				</details>
			{/if}

			<div class="mt-5 flex items-baseline justify-between">
				<h2 class="label">Recent activity</h2>
				<a
					href={resolve(`/admin/log?by=${encodeURIComponent(user.username)}`)}
					class="text-sm text-muted hover:text-accent hover:underline"
				>
					Everything they did, in the log
				</a>
			</div>
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
