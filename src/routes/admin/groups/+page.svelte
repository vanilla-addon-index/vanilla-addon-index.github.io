<script lang="ts">
	import { resolve } from '$app/paths';
	import { decideSuggestion, dismissPair, loadForks, loadSuggestions, type Suggestion } from '#lib/admin.ts';
	import { groupAddons, plainName, setMain, store, ungroupAddon } from '#lib/addons.svelte.ts';
	import UserLink from '#lib/components/UserLink.svelte';
	import { SITE_NAME } from '#lib/config.ts';
	import { linkKey, linkOwner } from '#lib/links.ts';
	import type { Addon } from '#lib/types.ts';

	let suggestions = $state<Suggestion[]>([]);
	let forks = $state(new Map<string, string>());
	let loaded = $state(false);
	let query = $state('');
	let notice = $state('');
	let error = $state('');

	async function load() {
		try {
			[suggestions, forks] = await Promise.all([loadSuggestions(), loadForks()]);
			loaded = true;
		} catch (e) {
			error = (e as Error).message;
		}
	}
	load();

	const byId = $derived(new Map(store.addons.map((a) => [a.id, a])));
	const pairKey = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;
	const together = (a: Addon, b: Addon) => a.group_id !== null && a.group_id === b.group_id;

	interface Proposal {
		// The addon that would join, and the addon whose group it would join.
		addon: Addon;
		target: Addon;
		why: string;
		// Set for a suggestion a user made; the others are spotted by the site.
		suggestion?: Suggestion;
	}

	const proposals = $derived.by(() => {
		const list: Proposal[] = [];
		// Pairs that were already decided, or are already waiting, are not offered again.
		const known = new Set(suggestions.map((s) => pairKey(s.addon_id, s.target_id)));

		for (const s of suggestions) {
			const addon = byId.get(s.addon_id);
			const target = byId.get(s.target_id);
			if (s.status === 'pending' && addon && target && !together(addon, target)) {
				list.push({ addon, target, why: 'Suggested by', suggestion: s });
			}
		}

		const offer = (addon: Addon, target: Addon, why: string) => {
			const key = pairKey(addon.id, target.id);
			if (addon.id === target.id || known.has(key) || together(addon, target)) return;
			known.add(key);
			list.push({ addon, target, why });
		};

		// Same name: each joins the one that was posted first.
		const named = Map.groupBy(store.addons, (a) => plainName(a.name));
		for (const same of named.values()) {
			const [first, ...rest] = same.toSorted((a, b) => a.created_at.localeCompare(b.created_at));
			for (const other of rest) offer(other, first, 'Same name');
		}

		// A fork joins the repository it was forked from.
		const byKey = new Map(store.addons.flatMap((a) => a.versions.map((v) => [linkKey(v.url), a] as const)));
		for (const a of store.addons) {
			const parent = byKey.get(forks.get(linkKey(a.repo_url)) ?? '');
			if (parent) offer(a, parent, 'A fork of it on GitHub');
		}
		return list;
	});

	const groups = $derived.by(() => {
		const wanted = plainName(query);
		return [...Map.groupBy(store.addons.filter((a) => a.group_id !== null), (a) => a.group_id).values()]
			.map((members) => members.toSorted((a, b) => Number(b.is_main) - Number(a.is_main) || a.name.localeCompare(b.name)))
			.filter((members) => !wanted || members.some((m) => plainName(m.name).includes(wanted)))
			.sort((a, b) => a[0].name.localeCompare(b[0].name));
	});

	const label = (a: Addon) => `${a.name} (${linkOwner(a.repo_url)})`;
	const blurb = (a: Addon) => a.summary || a.description.trim().split('\n')[0] || 'No description.';

	async function run(work: () => Promise<unknown>, done: string, reload = false) {
		error = '';
		try {
			await work();
			if (reload) suggestions = await loadSuggestions();
			notice = done;
		} catch (e) {
			error = (e as Error).message;
		}
	}

	const accept = (p: Proposal) =>
		run(
			async () => {
				if (p.suggestion) await decideSuggestion(p.suggestion.id, true);
				else await groupAddons([p.target.id, p.addon.id]);
			},
			`Grouped "${label(p.addon)}" with "${label(p.target)}".`,
			true
		);

	const turnDown = (p: Proposal) =>
		run(
			() => (p.suggestion ? decideSuggestion(p.suggestion.id, false) : dismissPair(p.addon.id, p.target.id)),
			'Rejected. That pair will not be suggested again.',
			true
		);
</script>

<svelte:head>
	<title>Groups · {SITE_NAME}</title>
</svelte:head>

{#snippet entry(addon: Addon, role: string)}
	<div class="min-w-0 border border-border p-2">
		<p class="label mb-0">{role}</p>
		<a href={resolve('/addon/[slug]', { slug: addon.slug })} class="font-bold hover:text-accent">{addon.name}</a>
		<a
			href={addon.repo_url}
			target="_blank"
			rel="noopener nofollow"
			class="block truncate text-sm text-accent/80 hover:text-accent hover:underline"
		>
			{addon.repo_url}
		</a>
		<p class="line-clamp-2 text-sm break-words text-muted">{blurb(addon)}</p>
	</div>
{/snippet}

<p class={['min-h-[1lh] truncate', error ? 'text-danger' : 'text-accent']} aria-live="polite">
	{error || notice}
</p>

<h2 class="label mt-2">Suggestions · {proposals.length}</h2>
<div class="panel">
	{#if !loaded || !store.loaded}
		<p class="px-3 py-8 text-center text-muted">Loading suggestions…</p>
	{:else if !proposals.length}
		<p class="px-3 py-8 text-center text-muted">
			Nothing to review. Suggestions come from posters, from addons that share a name, and from forks on GitHub.
		</p>
	{:else}
		{#each proposals as proposal (`${proposal.addon.id}:${proposal.target.id}`)}
			<div class="border-b border-border px-3 py-2 last:border-b-0">
				<p class={['text-sm', proposal.suggestion ? 'text-accent' : 'text-muted']}>
					{proposal.why}
					{#if proposal.suggestion}<UserLink name={proposal.suggestion.suggested_by_name} fallback="a user" />{/if}
				</p>
				<div class="mt-1 grid gap-2 sm:grid-cols-2">
					{@render entry(proposal.target, proposal.target.group_id === null ? 'Would be the main version' : 'Its group')}
					{@render entry(proposal.addon, 'Would join as another version')}
				</div>
				<div class="mt-1.5 flex flex-wrap gap-2">
					<button class="btn btn-primary py-1" onclick={() => accept(proposal)}>Group them</button>
					<button class="btn btn-danger py-1" onclick={() => turnDown(proposal)}>Reject</button>
				</div>
			</div>
		{/each}
	{/if}
</div>

<div class="mt-5 flex flex-wrap items-end justify-between gap-2">
	<h2 class="label mb-0">Groups · {groups.length}</h2>
	<input
		class="input w-full sm:w-64"
		type="search"
		placeholder="Search groups"
		aria-label="Search groups"
		bind:value={query}
	/>
</div>
<div class="panel mt-2">
	{#each groups as members (members[0].group_id)}
		<div class="border-b border-border px-3 py-2 last:border-b-0">
			{#each members as member (member.id)}
				<div class={['flex flex-wrap items-baseline gap-x-3 gap-y-1 py-0.5', !member.is_main && 'pl-5 opacity-80']}>
					<a
						href={resolve('/addon/[slug]', { slug: member.slug })}
						class={['min-w-0 truncate hover:text-accent', member.is_main && 'font-bold']}
					>
						{member.name}
					</a>
					<span class="text-sm text-muted">{linkOwner(member.repo_url)}</span>
					{#if member.is_main}<span class="text-sm text-accent">Main</span>{/if}
					<span class="ml-auto flex gap-2">
						{#if !member.is_main}
							<button
								class="btn px-2 py-0.5 text-sm"
								onclick={() => run(() => setMain(member.id), `"${label(member)}" is now the main version.`)}
							>
								Make main
							</button>
						{/if}
						<button
							class="btn px-2 py-0.5 text-sm"
							onclick={() => run(() => ungroupAddon(member.id), `Removed "${label(member)}" from its group.`)}
						>
							Remove from group
						</button>
					</span>
				</div>
			{/each}
		</div>
	{:else}
		<p class="px-3 py-8 text-center text-muted">
			{query ? 'No group matches.' : 'There are no groups yet.'}
		</p>
	{/each}
</div>
