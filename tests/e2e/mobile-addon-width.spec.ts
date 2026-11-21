import { test, expect } from './test';

test('long addon names fit mobile catalogue and detail pages without sideways scrolling', async ({ page }) => {
	const name = 'VeryLongAddonNameWithoutAnySpaces'.repeat(2).slice(0, 60);
	const addon = { id: 99001, slug: 'long-mobile-addon', name, description: 'An addon with a long name.', category: 'UI & Appearance', author: 'Example', versions: [{ url: 'https://github.com/example/LongAddon', note: '' }], repo_url: 'https://github.com/example/LongAddon', images: [], aliases: [], source: '', group_id: null, is_main: true, shared: false, pinned_link: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', code_update: null, link_code_updates: {} };
	await page.route('**/rest/v1/addons?*', route => route.fulfill({ json: [addon] }));
	for (const width of [320, 390]) {
		await page.setViewportSize({ width, height: 844 });
		await page.goto('/');
		await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
		await page.getByRole('link', { name, exact: true }).click();
		const heading = page.getByRole('heading', { level: 1, name, exact: true });
		await expect(heading).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
		expect(await heading.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
	}
});

test('mirrors have their own collapsed row below the source metadata', async ({ page }) => {
	const source = 'https://github.com/example/FirstDownload';
	const other = 'https://github.com/example/SecondDownload';
	const mirror = 'https://octowow.st/git/example/FirstDownload';
	const addon = {
		id: 99002, slug: 'mirror-layout-addon', name: 'Mirror layout addon', description: 'An addon with two downloads.',
		category: 'UI & Appearance', author: 'Example', versions: [source, other].map(url => ({ url, note: '' })),
		repo_url: source, images: [], aliases: [], source: '', is_main: true, shared: true,
		created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z'
	};
	await page.setViewportSize({ width: 320, height: 844 });
	await page.route('**/rest/v1/addons?*', route => route.fulfill({ json: [addon] }));
	const response = Promise.withResolvers<void>();
	await page.route('**/rest/v1/rpc/addon_mirrors', async route => {
		await response.promise;
		await route.fulfill({ json: [{ url: mirror, source }] });
	});
	await page.goto('/addon/mirror-layout-addon');
	const next = page.getByRole('link', { name: other, exact: true });
	await expect(next).toBeVisible();
	response.resolve();
	const toggle = page.getByText('Mirrors (1)', { exact: true });
	await expect(toggle).toBeVisible();
	const firstDownload = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: source, exact: true }) });
	const author = await firstDownload.getByText('Author', { exact: true }).boundingBox();
	expect((await toggle.boundingBox())!.y).toBeGreaterThan(author!.y + author!.height);
	await expect(page.getByRole('link', { name: mirror, exact: true })).toBeHidden();
	await toggle.click();
	await expect(page.getByRole('link', { name: mirror, exact: true })).toBeVisible();
});
