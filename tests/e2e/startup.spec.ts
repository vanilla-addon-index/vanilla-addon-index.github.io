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
