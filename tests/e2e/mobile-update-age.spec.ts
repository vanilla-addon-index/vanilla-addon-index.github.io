import { expect, test } from './test.ts';

test.use({ isMobile: true, hasTouch: true });

test('mobile catalogue controls fit and the slider works with a finger-sized touch target', async ({ page, context }) => {
	const year = new Date().getFullYear();
	const rows = ['Recent', 'Older', 'Client'].map((name, i) => ({
		id: 99200 + i, slug: `mobile-age-${name.toLowerCase()}`, name: `Mobile ${name}`,
		description: 'Mobile catalogue example.', category: i === 2 ? 'Util' : 'Combat',
		entry_type: i === 2 ? 'dll' : 'addon', author: '', versions: [], images: [], aliases: [],
		group_id: null, is_main: true, source: '',
		created_at: `${year}-01-01T00:00:00Z`, updated_at: `${year}-01-01T00:00:00Z`,
		code_update: { date: `${year - (i === 1 ? 15 : 0)}-01-01T00:00:00Z`, url: '' }
	}));
	await page.route('**/rest/v1/addons?*', route => route.fulfill({ json: rows }));
	const touch = await context.newCDPSession(page);
	for (const width of [320, 390, 430, 812]) {
		await page.setViewportSize({ width, height: width === 812 ? 375 : 844 });
		await page.goto('/');
		const slider = page.getByRole('slider', { name: 'Maximum update age' });
		const allYears = await slider.getAttribute('max');
		await slider.fill(allYears!);
		const search = page.getByRole('searchbox', { name: 'Search addons' });
		await search.fill('Recent');
		await expect(page.getByRole('link', { name: 'Mobile Recent', exact: true })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Mobile Older', exact: true })).toHaveCount(0);
		await search.fill('');
		await page.getByRole('combobox', { name: 'Sort by' }).selectOption('code');
		const bounds = (await slider.boundingBox())!;
		expect(bounds.height).toBeGreaterThanOrEqual(44);
		const box = (await slider.locator('..').boundingBox())!;
		expect((await page.getByRole('combobox', { name: 'Sort by' }).boundingBox())!.width).toBe(box.width);
		// Drag from near the top of the target, away from the visible thin track.
		await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bounds.x + bounds.width - 6, y: bounds.y + 5 }] });
		await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: bounds.x + 6, y: bounds.y + 7 }] });
		const tooltip = slider.locator('..').locator('.fixed');
		await expect(tooltip).toBeVisible();
		await expect(page.getByRole('link', { name: 'Mobile Older', exact: true })).toHaveCount(0);
		const tip = (await tooltip.boundingBox())!;
		expect(tip.x).toBeGreaterThanOrEqual(0);
		expect(tip.x + tip.width).toBeLessThanOrEqual(width);
		expect(tip.y).toBeGreaterThanOrEqual(0);
		expect(tip.y + tip.height).toBeLessThanOrEqual(width === 812 ? 375 : 844);
		await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await expect(tooltip).toHaveCount(0);
		await slider.fill(allYears!);
		await expect(page.getByRole('link', { name: 'Mobile Older', exact: true })).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	}
});
