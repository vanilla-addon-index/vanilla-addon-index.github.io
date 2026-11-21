import { expect, test } from './test.ts';

for (const locale of ['en-US', 'da-DK']) {
	test.describe(locale, () => {
		test.use({ locale, timezoneId: 'America/Los_Angeles', viewport: { width: 320, height: 844 } });

		test('shows the latest known code update once per group', async ({ page }) => {
			const groupDate = '2025-11-22';
			const detailDate = '2025-11-21';
			const source = 'https://github.com/example/original';
			const secondary = 'https://github.com/example/secondary';
			const pinnedUpdate = { date: '2023-01-01T00:00:00Z', url: source + '/commits' };
			const latest = { date: '2025-11-21T00:30:00Z', url: secondary + '/commits' };
			const rows = [
				{ id: 99200, name: 'Group Main', slug: 'group-main', group_id: 99, is_main: true, shared: true,
					repo_url: source, pinned_link: source, versions: [source, secondary].map(url => ({ url, note: '' })),
					code_update: pinnedUpdate, link_code_updates: { [source]: pinnedUpdate, [secondary]: latest } },
				{ id: 99201, name: 'Group Fork', slug: 'group-fork', group_id: 99, is_main: false,
					code_update: { date: '2025-11-22T00:30:00Z', url: source + '/fork/commits' } },
				{ id: 99202, name: 'Standalone', slug: 'standalone',
					code_update: { date: '2025-10-01T00:00:00Z', url: source + '/standalone/commits' } },
				{ id: 99203, name: 'Unknown', slug: 'unknown', code_update: { date: 'invalid', url: source + '/unknown/commits' } }
			].map(row => ({
				description: 'Update date example.', category: 'UI & Appearance', author: 'Example',
				created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...row
			}));
			await page.route('**/rest/v1/addons?*', route => route.fulfill({ json: rows }));
			await page.goto('/?sort=code');
			const list = page.getByRole('region', { name: 'Addon list' });
			const main = list.locator('[data-catalogue-id="99200"]');
			await expect(list.locator('[data-catalogue-id]').first()).toHaveAttribute('data-catalogue-id', '99200');
			await expect(main.locator('time')).toHaveText(groupDate);
			await expect(main.getByRole('link')).toHaveCount(1);
			await expect(list.locator('[data-catalogue-id="99201"] time')).toHaveCount(0);
			const unknown = list.locator('[data-catalogue-id="99203"]');
			await expect(unknown).toContainText('Last update unknown');
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
			const categories = list.getByText('UI & Appearance', { exact: true });
			for (const width of [640, 768, 1440]) {
				await page.setViewportSize({ width, height: 844 });
				const rightEdges = await categories.evaluateAll(labels => labels.map(label => label.getBoundingClientRect().right));
				expect(rightEdges).toHaveLength(rows.length);
				expect(new Set(rightEdges).size).toBe(1);
				const date = await main.locator('time').boundingBox();
				const dash = await unknown.getByText('—', { exact: true }).boundingBox();
				const oneRem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
				expect(date!.x - rightEdges[0]).toBeCloseTo(oneRem);
				expect(dash!.x - rightEdges[0]).toBeCloseTo(oneRem);
			}
			await page.setViewportSize({ width: 320, height: 844 });
			await main.getByRole('link').click();
			await expect(page.getByRole('heading', { level: 1, name: 'Group Main' })).toBeVisible();
			const update = page.locator('aside time');
			await expect(update).toHaveText(detailDate);
			await expect(update).toHaveAttribute('datetime', latest.date);
			await expect(page.getByRole('link', { name: detailDate, exact: true })).toHaveAttribute('href', latest.url);
			await expect(page.getByRole('link', { name: source, exact: true })).toBeVisible();
			await expect(page.getByRole('link', { name: secondary, exact: true })).toBeVisible();
		});
	});
}

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
