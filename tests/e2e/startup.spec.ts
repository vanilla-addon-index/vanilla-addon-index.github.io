import { expect, test } from './test.ts';

test('the site background paints even while app scripts are still loading', async ({ page }) => {
	let release!: () => void;
	const scripts = new Promise<void>(resolve => release = resolve);
	await page.route('**/*', async route => {
		if (route.request().resourceType() === 'script') await scripts;
		await route.continue();
	});
	try {
		await page.goto('/', { waitUntil: 'commit' });
		await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
			.toBe('rgb(16, 12, 8)');
	} finally {
		release();
	}
	await expect(page.getByRole('group', { name: 'Collection' }).first()).toBeVisible();
	// An opaque root background covers the existing negative-z backdrop layer.
	await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor))
		.toBe('rgba(0, 0, 0, 0)');
});

test('blocking analytics does not prevent the front page from loading', async ({ page }) => {
	await page.route('https://static.cloudflareinsights.com/**', route => route.abort('blockedbyclient'));
	await page.goto('/');
	await expect(page.getByRole('group', { name: 'Collection' }).first()).toBeVisible();
	await expect(page.getByRole('searchbox', { name: 'Search addons', exact: true })).toBeVisible();
});

test('About skips the catalogue and a direct entry without published data asks for one row', async ({ page }) => {
	const addonsRequests: URL[] = [];
	let snapshots = 0;
	page.on('request', request => {
		const url = new URL(request.url());
		if (url.pathname === '/addons.json') snapshots++;
		if (url.pathname === '/rest/v1/addons') addonsRequests.push(url);
	});

	await page.goto('/about');
	await expect(page.getByRole('heading', { name: 'About', exact: true })).toBeVisible();
	expect(addonsRequests).toHaveLength(0);

	await page.goto('/addon/raidhelper');
	await expect(page.getByRole('heading', { name: 'RaidHelper', exact: true })).toBeVisible();
	expect(addonsRequests.map(url => url.searchParams.get('limit'))).toEqual(['1']);
	expect(addonsRequests[0].searchParams.get('or')).toContain('slug.eq.raidhelper');
	expect(snapshots).toBe(0);
});

test('an unchanged refresh skips cache serialization and writes, and the saved list works offline', async ({ page }) => {
	const row = {
		id: 98001, name: 'Cached Addon', slug: 'cached-addon', category: 'Combat',
		description: 'Available offline.', images: [], versions: [], updated_at: '2026-10-10T00:00:00Z'
	};
	await page.addInitScript((id) => {
		const stringify = JSON.stringify;
		JSON.stringify = function (value, ...args) {
			if (Array.isArray(value) && value[0]?.id === id) performance.mark('catalogue-serialized');
			return Reflect.apply(stringify, JSON, [value, ...args]);
		};
		const setItem = Storage.prototype.setItem;
		Storage.prototype.setItem = function (key, value) {
			if (key === 'addons-v3') performance.mark('catalogue-written');
			return setItem.call(this, key, value);
		};
	}, row.id);
	const api = '**/rest/v1/addons?*';
	await page.route(api, route => route.fulfill({ json: [row] }));
	const cacheWork = () => page.evaluate(() => ['catalogue-serialized', 'catalogue-written']
		.map(mark => performance.getEntriesByName(mark).length));

	await page.goto('/');
	await expect(page.getByRole('link', { name: row.name })).toBeVisible();
	await expect.poll(cacheWork).toEqual([1, 1]);

	const refreshed = page.waitForResponse(api);
	await page.reload();
	await (await refreshed).finished();
	await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	expect(await cacheWork()).toEqual([0, 0]);

	// Published address repairs can change a row without changing its timestamp.
	row.slug = 'cached-addon-repaired';
	await page.reload();
	await expect(page.getByRole('link', { name: row.name })).toHaveAttribute('href', '/addon/cached-addon-repaired');
	expect(await cacheWork()).toEqual([1, 1]);

	await page.route(api, route => route.abort());
	await page.route('**/addons.json', route => route.abort());
	await page.reload();
	await expect(page.getByRole('link', { name: row.name })).toHaveAttribute('href', '/addon/cached-addon-repaired');
});
