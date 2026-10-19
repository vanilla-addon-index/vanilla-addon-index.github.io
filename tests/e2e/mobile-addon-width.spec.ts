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
