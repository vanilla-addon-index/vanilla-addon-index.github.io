import { gzipSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { PUBLIC_ADDON_COLUMNS } from '../../src/lib/config.ts';
import { addons, imports, mirror, newAddon, ORIGIN, published, SNAPSHOT_DATE, SUPABASE } from './fixture.mjs';

const catalogue = '/addons.json';
const addonApi = '/rest/v1/addons';
const importApi = '/rest/v1/pending_imports';
const snapshotBudget = 185_000;
const homeBudget = { scripts: 26, js: 120_000, html: 12_000, snapshot: snapshotBudget, api: 1_500 };
const outline = addons.map(({ id, updated_at, group_id, is_main }) => ({
	id, updated_at, group_id, is_main, owner: null, approved_by: null, profiles: null
}));

async function measure(page: Page, reply: (url: URL) => unknown = () => undefined) {
	const staticRequests: string[] = [];
	const apiRequests: URL[] = [];
	const unexpected: string[] = [];
	const assets: { path: string; bytes: number; document: boolean }[] = [];
	const apiResponses: { path: string; bytes: number }[] = [];
	page.on('response', response => {
		const url = new URL(response.url());
		if (url.origin !== ORIGIN || !response.ok()) return;
		assets.push({
			path: url.pathname, bytes: Number(response.headers()['content-length']),
			document: response.request().resourceType() === 'document'
		});
	});
	await page.route('**/*', async route => {
		const url = new URL(route.request().url());
		if (url.origin === ORIGIN) {
			staticRequests.push(url.pathname);
			return route.continue();
		}
		if (url.origin !== SUPABASE) {
			// Analytics and external media are outside the site's payload budget.
			if (url.pathname.startsWith('/rest/v1/') || url.hostname.endsWith('.supabase.co')) unexpected.push(url.href);
			return route.abort('blockedbyclient');
		}
		apiRequests.push(url);
		const fixture = await reply(url);
		if (fixture === undefined) {
			unexpected.push(url.href);
			return route.abort('blockedbyclient');
		}
		const body = JSON.stringify(fixture);
		apiResponses.push({ path: url.pathname, bytes: gzipSync(body).length });
		return route.fulfill({
			body, headers: {
				'content-type': 'application/json',
				'access-control-allow-origin': '*'
			}
		});
	});
	return {
		apiRequests, apiResponses, staticRequests, assets, unexpected,
		clear() {
			for (const list of [staticRequests, apiRequests, apiResponses, assets, unexpected]) list.length = 0;
		}
	};
}

type Traffic = Awaited<ReturnType<typeof measure>>;
const totalBytes = (assets: { bytes: number }[]) => assets.reduce((sum, asset) => sum + asset.bytes, 0);
const search = (page: Page) => page.getByRole('searchbox', { name: 'Search addons', exact: true });
const showCatalogue = (page: Page, count = addons.length) =>
	expect(search(page)).toHaveAttribute('placeholder', new RegExp(`^Search ${count} addons by`));

function budget(traffic: Traffic, limits: { scripts: number; js: number; html: number; snapshot: number; api: number }) {
	const js = traffic.assets.filter(item => item.path.endsWith('.js'));
	const html = totalBytes(traffic.assets.filter(item => item.document));
	const snapshot = totalBytes(traffic.assets.filter(item => item.path === catalogue));
	const api = totalBytes(traffic.apiResponses);
	const fonts = traffic.assets.filter(item => item.path.endsWith('.woff2'));
	const css = totalBytes(traffic.assets.filter(item => item.path.endsWith('.css')));
	const other = totalBytes(traffic.assets.filter(item =>
		!item.document && item.path !== catalogue && !/\.(js|css|woff2)$/.test(item.path)));
	expect(traffic.unexpected, 'unmatched requests were blocked').toEqual([]);
	expect(js.length, 'script requests').toBeGreaterThan(0);
	expect(js.length, 'script requests').toBeLessThanOrEqual(limits.scripts);
	expect(totalBytes(js), 'gzipped JavaScript bytes').toBeLessThanOrEqual(limits.js);
	expect(html, 'gzipped HTML bytes').toBeGreaterThan(0);
	expect(html, 'gzipped HTML bytes').toBeLessThanOrEqual(limits.html);
	expect(css, 'gzipped CSS bytes').toBeLessThanOrEqual(12_500);
	expect(fonts.length, 'font requests').toBeLessThanOrEqual(4);
	expect(totalBytes(fonts), 'font bytes').toBeLessThanOrEqual(170_000);
	expect(other, 'other first-party bytes').toBeLessThanOrEqual(16_000);
	expect(snapshot, 'gzipped snapshot bytes').toBeLessThanOrEqual(limits.snapshot);
	expect(api, 'gzipped Supabase bytes').toBeLessThanOrEqual(limits.api);
	console.log(`${js.length} scripts, ${totalBytes(js)} JS bytes, ${css} CSS bytes, ${html} HTML bytes, ` +
		`${snapshot} snapshot bytes, ${api} Supabase bytes (gzip), ${fonts.length} fonts / ${totalBytes(fonts)} bytes, ${other} other bytes`);
}

test('the cold homepage renders the published catalogue while its one delta request waits', async ({ page }) => {
	let release!: () => void;
	const held = new Promise<void>(resolve => { release = resolve; });
	const traffic = await measure(page, async url => {
		if (url.pathname !== addonApi) return;
		await held;
		return [newAddon];
	});
	try {
		await page.goto('/', { waitUntil: 'domcontentloaded' });
		await expect.poll(() => traffic.apiRequests.length).toBe(1);
		await showCatalogue(page);
		await expect(page.getByRole('link', { name: published.name, exact: true })).toBeVisible();
	} finally {
		release();
	}
	await showCatalogue(page, addons.length + 1);
	await page.waitForLoadState('networkidle');
	expect(traffic.apiRequests.map(url => url.pathname)).toEqual([addonApi]);
	expect(traffic.apiRequests[0].searchParams.get('updated_at')).toBe(`gt.${SNAPSHOT_DATE}`);
	expect(traffic.apiRequests[0].searchParams.get('select')).toBe(PUBLIC_ADDON_COLUMNS);
	expect(traffic.staticRequests.filter(path => path === catalogue)).toHaveLength(1);
	budget(traffic, homeBudget);
});

test('a published addon link includes its mirrors and skips the catalogue and Supabase', async ({ page }) => {
	const traffic = await measure(page);
	await page.goto(`/addon/${published.slug}`);
	await expect(page.getByRole('heading', { name: published.name, exact: true })).toBeVisible();
	await page.getByText('Mirrors (1)', { exact: true }).click();
	await expect(page.getByRole('link', { name: mirror.url, exact: true })).toBeVisible();
	await page.waitForLoadState('networkidle');
	expect(traffic.apiRequests).toHaveLength(0);
	expect(traffic.staticRequests).not.toContain(catalogue);
	budget(traffic, { scripts: 34, js: 136_000, html: 5_000, snapshot: 0, api: 0 });
});

test('reloading a recently visited homepage skips the Supabase delta and unchanged cache write', async ({ page }) => {
	await page.addInitScript(() => {
		const write = Storage.prototype.setItem;
		Storage.prototype.setItem = function (key, value) {
			if (key === 'addons-v3') performance.mark('catalogue-written');
			return write.call(this, key, value);
		};
	});
	const writes = () => page.evaluate(() => performance.getEntriesByName('catalogue-written').length);
	const traffic = await measure(page, url => url.pathname === addonApi ? [] : undefined);
	await page.goto('/');
	await showCatalogue(page);
	await expect.poll(writes).toBe(1);
	await page.waitForLoadState('networkidle');
	expect(traffic.apiRequests.map(url => url.pathname)).toEqual([addonApi]);

	traffic.clear();
	await page.reload();
	await showCatalogue(page);
	await page.waitForLoadState('networkidle');
	expect(traffic.apiRequests).toHaveLength(0);
	expect(traffic.staticRequests.filter(path => path === catalogue)).toHaveLength(1);
	expect(await writes()).toBe(0);
	budget(traffic, { ...homeBudget, api: 0 });
});

test('opening and paging the admin import queue uses bounded reads', async ({ page }) => {
	await page.addInitScript(project => {
		const id = '90000000-0000-4000-8000-000000000000';
		localStorage.setItem('profile-v2', JSON.stringify({
			id, username: 'Fixture Admin', isAdmin: true, isOwner: false, banned: false
		}));
		localStorage.setItem(`sb-${project}-auth-token`, JSON.stringify({
			user: { id }, access_token: 'fixture-token', refresh_token: 'fixture-refresh',
			expires_at: Math.floor(Date.now() / 1000) + 3600
		}));
	}, new URL(SUPABASE).hostname.split('.')[0]);
	const traffic = await measure(page, url => {
		const params = url.searchParams;
		switch (url.pathname) {
			case '/rest/v1/profiles': return { username: 'Fixture Admin' };
			case '/rest/v1/rpc/my_role': return { admin: true };
			case '/rest/v1/rpc/admin_badge_counts': return { imports: imports.length, reports: 0, edits: 0 };
			case '/rest/v1/rpc/import_review_counts':
				return {
					pending: imports.length, waiting: imports.length, incomplete: imports.length,
					fine: 0, duplicate: 0, wiki: 0, mirrors: 0, rejected: 0, dead: 0, approved: 0, submitted: 0, discord: 0
				};
			case addonApi: {
				const start = Number(params.get('offset'));
				const limit = Math.min(1000, Number(params.get('limit') ?? '1000'));
				return outline.slice(start, start + limit);
			}
			case importApi: {
				const after = Number(params.get('or')?.match(/id\.gt\.(\d+)/)?.[1] ?? 0);
				const limit = Math.min(1000, Number(params.get('limit') ?? '1000'));
				return imports.filter(item => item.id > after).slice(0, limit);
			}
		}
	});
	await page.goto('/admin/import');
	const entries = page.locator('[data-entry]');
	await expect(entries).toHaveCount(50);
	await page.waitForLoadState('networkidle');
	const expected = [addonApi, addonApi, importApi, '/rest/v1/profiles',
		'/rest/v1/rpc/my_role', '/rest/v1/rpc/admin_badge_counts', '/rest/v1/rpc/import_review_counts'];
	expect(traffic.apiRequests.map(url => url.pathname).sort()).toEqual(expected.sort());
	const addonReads = traffic.apiRequests.filter(url => url.pathname === addonApi);
	expect(addonReads.map(url => Number(url.searchParams.get('offset')))).toEqual([0, 1000]);
	for (const url of addonReads) {
		expect(url.searchParams.get('select')).toBe('id,updated_at,group_id,is_main,owner,approved_by,profiles:profiles!addons_owner_fkey(username)');
	}
	expect(traffic.staticRequests.filter(path => path === catalogue)).toHaveLength(1);
	budget(traffic, { scripts: 35, js: 148_000, html: 4_000, snapshot: snapshotBudget, api: 12_000 });

	const before = traffic.apiRequests.length;
	await page.getByRole('button', { name: 'Show more imports' }).click();
	await expect(entries).toHaveCount(100);
	await expect(entries.nth(50).getByLabel('Name')).toHaveValue(imports[50].name);
	await page.waitForLoadState('networkidle');
	expect(traffic.apiRequests.slice(before).map(url => url.pathname)).toEqual([importApi]);
	const pages = traffic.apiRequests.filter(url => url.pathname === importApi);
	expect(pages.map(url => url.searchParams.get('limit'))).toEqual(['51', '51']);
	expect(pages.map(url => url.searchParams.get('offset'))).toEqual([null, null]);
	expect(pages[1].searchParams.get('or')).toContain('id.gt.50');
	for (const response of traffic.apiResponses.filter(item => item.path === importApi)) {
		expect(response.bytes, 'gzipped bytes per import page').toBeLessThanOrEqual(7_000);
	}
	expect(traffic.unexpected).toEqual([]);
});
