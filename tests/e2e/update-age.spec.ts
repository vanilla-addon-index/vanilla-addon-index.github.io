import { expect, test } from './test.ts';

test('visitors can filter update ages, keep unknown dates, and remember or reset their choice', async ({ page }) => {
	// The retired account checkbox must not silently enable the new slider.
	await page.addInitScript(() => localStorage.setItem('vanilla-addon-index:hide-older', 'true'));
	const year = new Date().getFullYear();
	const allYears = year - 2004 + 2;
	const addons = ['Recent', 'Older', 'Unknown'].map((name, i) => ({
		id: 99100 + i, slug: `age-${name.toLowerCase()}`, name: `Age ${name}`,
		description: 'Update age filter example.', category: 'UI & Appearance', author: 'Example',
		versions: [{ url: `https://github.com/example/${name}`, note: '' }],
		images: [], aliases: [], source: '', group_id: null, is_main: true, shared: false,
		created_at: `${year}-01-01T00:00:00Z`, updated_at: `${year}-01-01T00:00:00Z`,
		code_update: i === 2 ? null : { date: `${year - (i === 0 ? 1 : 8)}-01-01T00:00:00Z`, url: `https://github.com/example/${name}/commits` }
	}));
	await page.route('**/rest/v1/addons?*', route => route.fulfill({ json: addons }));
	await page.goto('/');
	await expect(page.getByRole('link', { name: 'Log in', exact: true })).toBeVisible();
	const older = page.getByRole('link', { name: 'Age Older', exact: true });
	await expect(older).toBeVisible();
	const slider = page.getByRole('slider', { name: 'Maximum update age' });
	await expect(slider).toHaveValue(String(allYears));
	await slider.fill(String(allYears - 1));
	await expect(slider).toHaveAttribute('aria-valuetext', /Updated in 2004 or later/);
	await expect(page.getByRole('searchbox', { name: 'Search addons' })).toHaveAttribute('placeholder', /^Search 3 addons/);
	await page.getByRole('slider').fill('8');
	await expect(older).toHaveCount(0);
	await expect(page.getByRole('searchbox', { name: 'Search addons' })).toHaveAttribute('placeholder', /^Search 2 addons/);
	await expect(page.getByRole('link', { name: 'Age Recent', exact: true })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Age Unknown', exact: true })).toBeVisible();
	await page.reload();
	await expect(slider).toHaveValue('8');
	await expect(older).toHaveCount(0);
	const handle = await slider.boundingBox();
	await page.mouse.move(handle!.x + 5.5 + (handle!.width - 11) * 7 / (allYears - 1), handle!.y + handle!.height / 2);
	await page.mouse.down();
	await page.getByRole('slider').fill('10');
	// The readout updates immediately and the list previews while still held down.
	await expect(slider).toHaveAttribute('aria-valuetext', new RegExp(String(year - 9)));
	await expect(older).toBeVisible();
	expect(await page.evaluate(() => localStorage.getItem('vanilla-addon-index:max-update-age'))).toBe('8');
	// Release applies the final value without waiting for the next preview.
	await slider.fill('6');
	await page.mouse.up();
	await expect(older).toHaveCount(0);
	expect(await page.evaluate(() => localStorage.getItem('vanilla-addon-index:max-update-age'))).toBe('6');
	for (const width of [320, 390, 768, 1440]) {
		await page.setViewportSize({ width, height: 900 });
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		await expect(page.getByRole('slider')).toBeInViewport();
	}
	await slider.fill(String(allYears));
	await page.reload();
	await expect(slider).toHaveValue(String(allYears));
	await expect(older).toBeVisible();
});
