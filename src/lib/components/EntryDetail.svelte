<script lang="ts">
	import { untrack } from 'svelte';
	import { clientKind } from '#lib/client-kinds.ts';
	import { entryHref } from '#lib/entry-href.ts';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		currentCatalogueLoad,
		deleteAddon,
		ensureCatalogue,
		fetchAddon,
		findAddon,
		findCachedAddon,
		readPublishedAddon,
		pinLink, mergeAddons, separateAddon,
	} from '#lib/addons.svelte.ts';
	import { contributionAccess, ownPendingEdit, removeOwnLink, withdrawEdit, type ContributionAccess, type EditRequest } from '#lib/edit-reviews.svelte.ts';
	import { auth, canEdit } from '#lib/auth.svelte.ts';
	import AddAddonLink from '#lib/components/AddAddonLink.svelte';
	import SimilarAddonEditor from '#lib/components/SimilarAddonEditor.svelte';
	import AddonPicker from '#lib/components/AddonPicker.svelte';
	import FavoriteButton from '#lib/components/FavoriteButton.svelte';
	import ReportDialog from '#lib/components/ReportDialog.svelte';
	import ScreenshotGallery from '#lib/components/ScreenshotGallery.svelte';
	import UserLink from '#lib/components/UserLink.svelte';
	import { SITE_NAME } from '#lib/config.ts';
	import { ask } from '#lib/confirm.svelte.ts';
	import { linkAuthor } from '#lib/links.ts';
	import { repositoryRoot } from '#lib/mirrors.ts';
	import { listAddonMirrors, listInactiveMirrorDecisions, decideAddonMirror } from '#lib/admin.ts';
	import { loginHref } from '#lib/return.ts';
	import { addonTitle } from '#lib/seo.ts';
	import type { Addon, AddonMirror } from '#lib/types.ts';

	const published = readPublishedAddon();
	const slug = $derived(page.params.slug);
	const account = $derived(auth.session?.user.id);
	let checked = $state.raw<{ slug: string; canonical?: string; account?: string; missing?: boolean; cached?: Addon }>();
	const resolved = $derived(checked?.account === account && (checked?.slug === slug || checked?.canonical === slug) ? checked : undefined);
	const publishedHere = $derived(slug && (published?.slug === slug || published?.aliases.includes(slug)) ? published : undefined);
	const found = $derived(resolved?.missing ? undefined : findAddon(slug) ?? publishedHere ?? resolved?.cached);
	// Alias pages also exist in the static build; move the browser to the current address.
	$effect(() => {
		if (!resolved || !found || page.url.pathname === entryHref(found)) return;
		void goto(entryHref(found) + page.url.search + page.url.hash, { replace: true });
	});
	// While a delete is under way the addon is already gone from the list; the copy
	// taken just before keeps the page as it was until the next page replaces it.
	let kept = $state.raw<Addon>();
	let leaving = $state(false);
	const addon = $derived(leaving ? kept : found);
	const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' });

	let error = $state('');
	type AdminTool = 'downloads' | 'mirrors' | 'merge';
	type ToolStatus = { pending: true } | { pending: false; message: string; failed: boolean };
	let toolStatus = $state<Partial<Record<AdminTool, ToolStatus>>>({});
	$effect(() => {
		addon?.id;
		toolStatus = {};
		renameLink = ''; separateName = '';
	});

	async function runTool(tool: AdminTool, work: () => Promise<void>, message: string) {
		const id = addon?.id;
		if (id === undefined || toolStatus[tool]?.pending) return;
		toolStatus[tool] = { pending: true };
		try {
			await work();
			if (addon?.id === id) toolStatus[tool] = { pending: false, message, failed: false };
		} catch (e) {
			if (addon?.id === id) toolStatus[tool] = { pending: false, message: (e as Error).message, failed: true };
		}
	}

	let mirrorResult = $state.raw<{ id: number; user?: string; rows: AddonMirror[] }>();
	const publishedMirrors = $derived(addon?.published_mirrors);
	const mirrors = $derived(
		mirrorResult && mirrorResult.id === addon?.id && mirrorResult.user === account
			? mirrorResult.rows : publishedMirrors ?? []
	);
	const mirrorVersions = $derived(addon?.versions.map(version => version.url).sort().join('\n'));
	let inactiveMirrors = $state<{ url: string; decision: 'independent' | 'removed' }[]>([]);
	let mirrorUrl = $state('');
	let mirrorSource = $state('');
	const mirrorSources = $derived(addon?.versions.filter(version => repositoryRoot(version.url)) ?? []);
	let mirrorFormOpen = $state(false);
	let editingMirror = $state('');
	const savingMirror = $derived(!!toolStatus.mirrors?.pending);
	$effect(() => {
		const id = addon?.id;
		const user = account;
		if (!resolved || !id || mirrorVersions === undefined) return;
		if (!user && publishedMirrors !== undefined) return;
		let current = true;
		// Cached and live addon rows can arrive in quick succession. Keep the
		// current result visible while refreshing the same addon.
		listAddonMirrors(id).then(rows => { if (current) mirrorResult = { id, user, rows }; })
			.catch(e => { if (current) error = e.message; });
		return () => { current = false; };
	});
	$effect(() => {
		const id = addon?.id;
		inactiveMirrors = []; mirrorUrl = ''; mirrorSource = '';
		mirrorFormOpen = false; editingMirror = '';
		if (!resolved || !id || !auth.isAdmin || auth.banned) return;
		let current = true;
		listInactiveMirrorDecisions(id).then(rows => { if (current) inactiveMirrors = rows; })
			.catch(e => { if (current) error = e.message; });
		return () => { current = false; };
	});
	async function saveMirror(url: string, source: string | null, decision: 'mirror' | 'independent' | 'removed') {
		if (!addon || savingMirror) return;
		const { id, slug } = addon;
		const user = account;
		await runTool('mirrors', async () => {
			await decideAddonMirror(id, url, source, decision);
			await fetchAddon(slug);
			const [rows, decisions] = await Promise.all([listAddonMirrors(id), listInactiveMirrorDecisions(id)]);
			if (addon?.id === id && account === user) {
				mirrorResult = { id, user, rows };
				inactiveMirrors = decisions;
				mirrorUrl = ''; mirrorSource = '';
				mirrorFormOpen = false; editingMirror = '';
			}
		}, 'Mirror decision saved.');
	}
	const updatingDownloads = $derived(!!toolStatus.downloads?.pending);
	let renameLink = $state('');
	let separateName = $state('');
	async function separate(link: string, name?: string) {
		if (!addon || updatingDownloads) return;
		const { id } = addon;
		await runTool('downloads', async () => {
			try {
				await separateAddon(id, link, name);
				if (addon?.id === id) {
					renameLink = ''; separateName = '';
				}
			} catch (e) {
				if (addon?.id === id && (e as { code?: string }).code === 'PNA01') renameLink = link;
				throw e;
			}
		}, 'Link moved to its own addon page.');
	}

	function changePin(id: number, url: string, pinned: boolean) {
		return runTool('downloads', () => pinLink(id, pinned ? null : url),
			pinned ? 'Main download unpinned.' : 'Main download pinned.');
	}
	let report = $state<ReturnType<typeof ReportDialog>>();

	// Published pages can open without an addons query for visitors. An account needs
	// current ownership, and an unknown address may have been posted since publication.
	$effect(() => {
		const target = slug;
		const user = account;
		if (!auth.known || !target || leaving || untrack(() => resolved)) return;
		const existing = untrack(() => found);
		if (existing && !user) {
			checked = { slug: target, canonical: existing.slug };
			return;
		}
		const controller = new AbortController();
		const { signal } = controller;
		const catalogue = untrack(currentCatalogueLoad);
		async function check(target: string) {
			if (catalogue) {
				await catalogue;
				if (signal.aborted) return;
				const row = findAddon(target);
				if (row) {
					checked = { slug: target, canonical: row.slug, account: user };
					return;
				}
			}
			const row = await fetchAddon(target, signal).catch(() => undefined);
			if (signal.aborted) return;
			const cached = row === undefined && !existing ? findCachedAddon(target) : undefined;
			checked = {
				slug: target, account: user, missing: row === null,
				canonical: (row ?? existing ?? cached)?.slug, cached
			};
		}
		void untrack(() => check(target));
		return () => controller.abort();
	});

	let access=$state<ContributionAccess>({can_propose:false,links:[]}), pending=$state<EditRequest|null>(null);
	let accessKey='';
	async function refreshAccess() {
		if (!addon?.shared || !auth.session || auth.banned) return;
		const id=addon.id, user=auth.session.user.id;
		const [result,request]=await Promise.all([contributionAccess(id),ownPendingEdit(id)]);
		if(addon?.id===id && auth.session?.user.id===user && !auth.banned){access=result;pending=request;}
	}
	$effect(()=>{
		const key=(resolved ? addon?.id??'' : '')+':'+(auth.session?.user.id??'')+':'+!!auth.banned;
		if(accessKey===key)return;
		accessKey=key;access={can_propose:false,links:[]};pending=null;
		if (resolved) refreshAccess().catch(e=>error=e.message);
	});
	async function removeLink(link:string) {
		if(!addon)return;
		const confirmed=await ask({title:'Remove your link?',body:'The shared page stays available, even if this is its last link. An admin can undo the removal in History.',action:'Remove my link',danger:true});
		if(!confirmed)return;
		await change(async()=>{await removeOwnLink(addon.id,link);await refreshAccess();});
	}
	async function withdraw() {
		if(!pending)return;
		await change(async()=>{await withdrawEdit(pending!.id);pending=null;});
	}

	async function change(work: () => Promise<void>) {
		error = '';
		try {
			await work();
		} catch (e) {
			error = (e as Error).message;
		}
	}

	async function remove() {
		if (!addon) return;
		const confirmed = await ask({
			title: `Delete "${addon.name}"?`,
			body: 'It goes to the trash, where an admin can restore it for 90 days.',
			action: 'Delete',
			danger: true
		});
		if (!confirmed) return;
		kept = addon;
		leaving = true;
		try {
			await deleteAddon(addon.id);
			await goto(resolve('/'));
		} catch (e) {
			error = (e as Error).message;
			leaving = false;
		}
	}
</script>

<svelte:head>
	<title>{addon ? addonTitle(addon) : SITE_NAME}</title>
</svelte:head>

{#if addon}
	<a href={resolve(addon.entry_type === 'dll' ? '/?type=dll' : '/')} class="text-muted hover:text-accent">← All {addon.entry_type === 'dll' ? 'DLL mods' : 'addons'}</a>

	<article class="mt-3 grid grid-cols-1 items-start gap-4 md:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_22rem]">
		<div class="panel min-w-0 p-4">
			<h1 class="text-3xl font-bold [overflow-wrap:anywhere]">{addon.name}</h1>

			{#if addon.entry_type === 'dll'}
				<div class="mt-3"><span class="chip">{clientKind(addon.category)}</span></div>
			{:else}
				<div class="mt-3 flex flex-wrap gap-1.5">
					<a href={resolve(`/?cat=${encodeURIComponent(addon.category)}`)} class="chip">
						{addon.category}
					</a>
				</div>
			{/if}

			{#if addon.description}
				<p class="mt-4 font-read text-[0.9rem] leading-relaxed break-words whitespace-pre-line">{addon.description}</p>
			{/if}

			{#if addon.images?.length}
				{#key JSON.stringify([addon.id, addon.images])}
					<ScreenshotGallery images={addon.images} name={addon.name} />
				{/key}
			{/if}
			{#if addon.similar_addons}
				<p class="mt-4 text-sm text-muted break-words">{addon.similar_addons}</p>
			{/if}
		</div>

		<aside class="min-w-0 space-y-2">
			<div class="panel">
				<!-- Pinned link first, otherwise newest known code update. -->
				{#if !addon.versions.length}<p class="px-3 py-3 text-muted">No download links currently listed.</p>{/if}
				<ol>
					{#each addon.versions as version (version.url)}
						{@const update = addon.link_code_updates?.[version.url] ?? (version.url === addon.repo_url ? addon.code_update : null)}
						{@const sourceMirrors = mirrors.filter(mirror => mirror.source === version.url)}
						<li class="border-b border-border px-3 py-3 last:border-b-0">
							<a
								href={version.url}
								target="_blank"
								rel="noopener nofollow"
								class="break-all text-accent hover:underline"
							>
								{version.url}
							</a>
							{#if addon.unavailable_links?.includes(version.url)}<p class="text-sm text-danger">Currently unavailable</p>{/if}
							{#if version.note}<p class="text-sm">{version.note}</p>{/if}
                            <dl class="mt-2 space-y-1 text-sm">
                                <div class="flex justify-between gap-4"><dt class="shrink-0 text-muted">Author</dt><dd class="min-w-0 break-words text-right">{(!addon.shared ? addon.author : '') || linkAuthor(version.url) || 'Unknown'}</dd></div>
								<div class="flex justify-between gap-4"><dt class="shrink-0 text-muted">Last update</dt><dd>
									{#if update}<a href={update.url} target="_blank" rel="noopener noreferrer" class="text-accent hover:underline" title="View commit history"><time datetime={update.date}>{date(update.date)}</time></a>
									{:else}<span class="text-muted">Unknown</span>{/if}
								</dd></div>
                            </dl>
                            {#if addon.pinned_link === version.url}<span class="text-sm text-accent">Pinned</span>{/if}
							{#if sourceMirrors.length}
								<details class="mt-2 text-sm text-muted">
									<summary class="cursor-pointer hover:text-accent">Mirrors ({sourceMirrors.length})</summary>
									<ul class="space-y-1 pl-4 pt-1">
										{#each sourceMirrors as mirror (mirror.url)}
											<li><a class="break-all text-accent hover:underline" href={mirror.url} target="_blank" rel="noopener nofollow">{mirror.url}</a></li>
										{/each}
									</ul>
								</details>
							{/if}
                            {#if auth.session && !auth.isAdmin && !auth.banned && access.links.includes(version.url)}<button class="btn mt-1 px-2 py-0.5 text-sm" onclick={()=>removeLink(version.url)}>Remove my link</button>{/if}
						</li>
					{/each}
					{#each mirrors.filter(mirror => !addon.versions.some(version => version.url === mirror.source)) as mirror (mirror.url)}
						<li class="px-3 py-3 text-sm"><a href={mirror.url} target="_blank" rel="noopener nofollow" class="break-all text-accent hover:underline">{mirror.url}</a>
							<span class="block text-muted">Mirror link</span></li>
					{/each}
				</ol>
			</div>

			<FavoriteButton addonId={addon.id} />
            {#if resolved && auth.session && !auth.banned}{#key addon.id + ':' + auth.session.user.id}<AddAddonLink addonId={addon.id} hasLinks={addon.versions.length > 0} />{/key}{/if}
            {#if auth.session && addon.shared && access.can_propose && !auth.isAdmin}<a class="btn w-full" href={resolve('/submit')+'?edit='+addon.slug}>Propose edits</a>{/if}
            {#if auth.session && pending && !auth.isAdmin}<div class="panel px-3 py-2 text-sm"><p>Your edit is waiting for admin review.</p><button class="btn mt-2" onclick={withdraw}>Withdraw proposal</button></div>{/if}
			{#snippet editControls()}
				<div class="grid grid-cols-2 gap-2">
					<a href={resolve(`/submit?edit=${addon.slug}`)} class="btn">Edit</a>
					<button class="btn btn-danger" onclick={remove}>Delete</button>
				</div>
			{/snippet}
			{#if resolved && !auth.isAdmin && canEdit(addon.owner)}
				{@render editControls()}
			{/if}

			<!-- For anyone who spots a dead link or something harmful. Reporting needs an
			     account, so a visitor is sent to log in first. -->
			{#if !auth.banned}
				<p class="pr-[calc(0.75rem+1px)] text-right text-sm">
					{#if auth.session}
						<button class="cursor-pointer text-muted hover:text-accent hover:underline" onclick={() => report?.open()}>
							Report this addon
						</button>
					{:else}
						<a href={loginHref(page.url)} class="text-muted hover:text-accent hover:underline">Log in to report this addon</a>
					{/if}
				</p>
			{/if}
			{#if resolved && auth.isAdmin}
				<section aria-label="Admin controls" class="panel admin-controls mt-4">
					<header class="admin-header space-y-3 p-4">
						<div>
							<h2 class="text-lg font-bold">Admin controls</h2>
							{#if addon.owner_name}
								<p class="text-sm text-muted [overflow-wrap:anywhere]">Posted by <UserLink name={addon.owner_name} class="text-fg" /></p>
							{/if}
						</div>
						<div class="flex gap-2">
							{#if canEdit(addon.owner)}<a href={resolve(`/submit?edit=${addon.slug}`)} class="btn btn-primary flex-1">Edit</a>{/if}
							<a href={resolve(`/admin/log?addon=${addon.id}`)} class="btn flex-1">History</a>
						</div>
					</header>

					{#snippet toolHeading(title: string, description: string, count?: string)}
						<span class="min-w-0">
							<span class="block font-semibold">{title}</span>
							<span class="block text-sm leading-snug text-muted">{description}</span>
						</span>
						{#if count}<span class="tool-badge justify-self-end">{count}</span>{/if}
						<span class="tool-chevron" aria-hidden="true"></span>
					{/snippet}

					{#snippet feedback(tool: AdminTool, pendingText: string)}
						{@const status = toolStatus[tool]}
						{#if status?.pending}
							<p class="text-sm text-muted" role="status">{pendingText}</p>
						{:else if status?.message}
							<p class={['tool-feedback', status.failed ? 'text-danger' : 'text-accent']} role={status.failed ? 'alert' : 'status'}>{status.message}</p>
						{/if}
					{/snippet}

					{#key addon.id}
						<details class="admin-tool" data-download-settings>
							<summary>{@render toolHeading('Download links', 'Pin a main link or split off a version', String(addon.versions.length))}</summary>
							<div class="tool-body">
								{#if !addon.versions.length}<p class="text-sm text-muted">No download links to manage.</p>{/if}
								{#each addon.versions as version (version.url)}
									{@const pinned = addon.pinned_link === version.url}
									<div class="tool-card" data-link-controls>
										<p class="tool-url">{version.url.replace(/^https?:\/\//, '')}</p>
										{#if pinned}<p class="text-xs font-semibold text-accent">Main download</p>{/if}
										<div class="flex flex-wrap gap-2">
											<button class="btn" disabled={updatingDownloads} onclick={() => changePin(addon.id, version.url, pinned)}>{pinned ? 'Unpin' : 'Pin'}</button>
											{#if addon.versions.length > 1}<button class="btn" disabled={updatingDownloads} onclick={() => { renameLink = ''; separateName = ''; void separate(version.url); }}>Separate addon</button>{/if}
										</div>
										{#if renameLink === version.url}
											<form class="space-y-2 pt-2" onsubmit={(event) => { event.preventDefault(); void separate(version.url, separateName); }}>
												<label class="field-label" for="separate-name">New addon name</label>
												<p class="text-sm text-muted">Matching names stay grouped. Give this addon a different name to separate it.</p>
												<input id="separate-name" class="input" bind:value={separateName} required minlength="2" maxlength="60" disabled={updatingDownloads} />
												<div class="flex flex-wrap gap-2">
													<button class="btn btn-primary" disabled={updatingDownloads}>Separate addon</button>
													<button type="button" class="btn" disabled={updatingDownloads} onclick={() => { renameLink = ''; separateName = ''; delete toolStatus.downloads; }}>Cancel</button>
												</div>
											</form>
										{/if}
									</div>
								{/each}
								{@render feedback('downloads', 'Updating download links…')}
							</div>
						</details>
						<details class="admin-tool" data-mirror-settings>
							<summary>{@render toolHeading('Mirrors', 'Manage copies of source downloads', mirrorResult?.id === addon.id && mirrorResult.user === account ? `${mirrors.length} active` : undefined)}</summary>
							<div class="tool-body">
								{#snippet mirrorSourceOptions()}
									<option value="">Choose a source</option>
									{#each mirrorSources as version (version.url)}
										<option value={version.url}>{version.url.replace(/^https?:\/\//, '')}</option>
									{/each}
								{/snippet}
								{#each mirrors as mirror (mirror.url)}
									<div class="tool-card">
										<p class="tool-url">{mirror.url.replace(/^https?:\/\//, '')}</p>
										{#if mirror.source}
											<p class="text-sm text-muted [overflow-wrap:anywhere]">Source: {mirror.source.replace(/^https?:\/\//, '')}</p>
										{:else}
											<p class="text-sm text-muted">No source assigned</p>
										{/if}
										<div class="flex flex-wrap gap-2">
											<button class="btn" disabled={savingMirror || !mirrorSources.length} aria-expanded={editingMirror === mirror.url}
												onclick={() => (editingMirror = editingMirror === mirror.url ? '' : mirror.url)}>Change source</button>
											<button class="btn" disabled={savingMirror} onclick={() => saveMirror(mirror.url, null, 'independent')}>List as version</button>
											<button class="btn" disabled={savingMirror} onclick={() => saveMirror(mirror.url, null, 'removed')}>Unlink mirror</button>
										</div>
										{#if editingMirror === mirror.url}
											<label class="field-label">Mirror source
												<select class="input w-full" value={mirror.source ?? ''} disabled={savingMirror}
													onchange={(event) => { if (event.currentTarget.value) void saveMirror(mirror.url, event.currentTarget.value, 'mirror'); }}>
													{@render mirrorSourceOptions()}
												</select>
											</label>
										{/if}
									</div>
								{/each}
								{#each inactiveMirrors as decision (decision.url)}
									<div class="tool-card">
										<p class="tool-url">{decision.url.replace(/^https?:\/\//, '')}</p>
										<p class="text-sm text-muted">{decision.decision === 'removed' ? 'Unlinked' : 'Listed as a version'}</p>
										<button class="btn" disabled={savingMirror || !mirrorSources.length}
											onclick={() => { mirrorUrl = decision.url; mirrorSource = ''; mirrorFormOpen = true; }}>Reattach as mirror</button>
									</div>
								{/each}
								{#if mirrorFormOpen}
									<form class="tool-card" onsubmit={(event) => { event.preventDefault(); void saveMirror(mirrorUrl, mirrorSource, 'mirror'); }}>
										<label class="field-label">Mirror repository URL <input type="url" class="input" bind:value={mirrorUrl} disabled={savingMirror} required /></label>
										<label class="field-label">Source repository
											<select class="input" bind:value={mirrorSource} disabled={savingMirror} required>
												{@render mirrorSourceOptions()}
											</select>
										</label>
										<div class="flex flex-wrap gap-2">
											<button class="btn btn-primary" disabled={savingMirror}>Attach mirror</button>
											<button type="button" class="btn" disabled={savingMirror}
												onclick={() => { mirrorFormOpen = false; mirrorUrl = ''; mirrorSource = ''; }}>Cancel</button>
										</div>
									</form>
								{:else if mirrorSources.length}
									<button class="btn w-full" disabled={savingMirror} onclick={() => (mirrorFormOpen = true)}>Attach mirror</button>
								{:else}
									<p class="text-sm text-muted">Add a source repository to this page before attaching a mirror.</p>
								{/if}
								{@render feedback('mirrors', 'Saving mirror decision…')}
							</div>
						</details>
						<details class="admin-tool">
							<summary>{@render toolHeading('Similar addons', 'Help visitors find alternatives in search', addon.similar_addons ? 'Set' : 'None')}</summary>
							<div class="tool-body">
								<SimilarAddonEditor {addon} />
							</div>
						</details>
						<details class="admin-tool" data-merge-settings ontoggle={(event) => {
							if (event.currentTarget.open) void ensureCatalogue();
						}}>
							<summary>{@render toolHeading('Merge another addon', 'Bring its download links onto this page')}</summary>
							<div class="tool-body">
								<p class="text-sm text-muted">Selecting an addon merges it immediately. Its old address will lead here.</p>
								<fieldset class="min-w-0" disabled={toolStatus.merge?.pending}>
									<AddonPicker
										placeholder="Merge another addon’s links here…"
										exclude={(other) => other.id === addon.id}
										onpick={(other) => runTool('merge', () => mergeAddons(other.id, addon.id), `Merged ${other.name} into this page.`)}
									/>
								</fieldset>
								{@render feedback('merge', 'Merging addon…')}
							</div>
						</details>
					{/key}
					{#if canEdit(addon.owner)}
						<div class="flex justify-end border-t border-border p-4">
							<button class="btn btn-danger shrink-0 text-danger" onclick={remove}>Delete</button>
						</div>
					{/if}
				</section>
			{/if}
			{#if error}<p role="alert" class="text-danger">{error}</p>{/if}
		</aside>
		<ReportDialog bind:this={report} {addon} />
	</article>
{:else if resolved}
	<div class="py-16 text-center">
		<h1 class="text-2xl font-bold">Addon not found</h1>
		<p class="mt-2 text-muted">It may have been renamed or removed.</p>
		<a href={resolve('/')} class="btn mt-6">Browse all addons</a>
	</div>
{:else}
	<p class="py-12 text-center text-muted">Loading…</p>
{/if}

<style>
	.admin-controls {
		border-color: color-mix(in srgb, var(--color-accent) 24%, var(--color-border));
		border-radius: 0.65rem;
	}

	.admin-header {
		border-radius: inherit;
		background: linear-gradient(120deg, color-mix(in srgb, var(--color-accent) 9%, transparent), transparent 85%);
	}

	.admin-controls :global(.btn),
	.admin-controls :global(.input) {
		min-height: 2.375rem;
		border-radius: 0.375rem;
		font-size: 0.875rem;
	}

	.admin-header :global(.btn) {
		font-size: inherit;
	}

	.admin-controls :global(.input) {
		margin-top: 0.25rem;
	}

	.admin-tool {
		border-top: 1px solid var(--color-border);
	}

	.admin-tool > summary {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto 0.75rem;
		align-items: center;
		gap: 0.625rem;
		padding: 0.75rem 1rem;
		cursor: pointer;
		list-style: none;
	}

	.admin-tool > summary::-webkit-details-marker {
		display: none;
	}

	.admin-tool > summary:hover,
	.admin-tool[open] > summary {
		background: var(--color-raised);
	}

	.admin-tool > summary:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: -2px;
	}

	.tool-badge {
		border: 1px solid var(--color-border);
		border-radius: 999px;
		padding: 0.0625rem 0.5rem;
		color: var(--color-muted);
		font-size: 0.75rem;
		font-variant-numeric: tabular-nums;
	}

	.tool-chevron {
		grid-column: 3;
		justify-self: center;
		width: 0.45rem;
		height: 0.45rem;
		margin-top: -0.2rem;
		border: solid var(--color-muted);
		border-width: 0 1.5px 1.5px 0;
		transform: rotate(45deg);
	}

	.admin-tool[open] .tool-chevron {
		margin-top: 0.2rem;
		transform: rotate(225deg);
	}

	.tool-body {
		display: grid;
		gap: 0.75rem;
		padding: 0.75rem 1rem 1rem;
	}

	.tool-card {
		min-width: 0;
		border: 1px solid var(--color-border);
		border-radius: 0.375rem;
		padding: 0.625rem;
		background: var(--color-surface);
	}

	.tool-card > * + * {
		margin-top: 0.5rem;
	}

	.tool-url,
	.tool-feedback {
		font-size: 0.875rem;
		overflow-wrap: anywhere;
	}

	.tool-url {
		font-weight: 500;
	}

	.tool-feedback {
		border-inline-start: 2px solid currentColor;
		padding-inline-start: 0.625rem;
	}
</style>
