import { expect, test } from './test.ts';
import { loginAs } from './helpers.ts';

test('favorites persist on the account with visible code dates and can be removed on the addon', async ({ page }) => {
	await loginAs(page, 'member');
	await page.goto('/addon/raidhelper');
	const add = page.getByRole('button', {name:'Add to favorites', exact:true});
	await expect(add).toBeEnabled();
	await add.click();
	await expect(page.getByRole('button', {name:'Remove from favorites'})).toHaveAttribute('aria-pressed', 'true');
	await page.reload();
	await expect(page.getByRole('button', {name:'Remove from favorites'})).toBeEnabled();
	await page.goto('/account');
	const favorites = page.getByRole('region', {name:'Your favorites'});
	await expect(favorites.getByRole('link', {name:'RaidHelper', exact:true})).toBeVisible();
	await expect(favorites.getByText('Last update:')).toBeVisible();
	await expect(favorites.locator('time')).toHaveAttribute('datetime', '2024-06-14T14:00:48+00:00');
	await page.reload();
	await favorites.getByRole('link', {name:'RaidHelper', exact:true}).click();
	await page.getByRole('button', {name:'Remove from favorites'}).click();
	await expect(add).toHaveAttribute('aria-pressed', 'false');
	await page.goto('/account');
	await expect(favorites.getByText(/No favorites yet/)).toBeVisible();
	await page.goto('/');
	await expect(page.getByRole('button', {name:/favorites/i})).toHaveCount(0);
});

test('signed-out visitors are offered login on the addon page', async ({ page }) => {
	await page.goto('/addon/raidhelper');
	await expect(page.getByRole('link', {name:'Log in to favorite', exact:true})).toHaveAttribute('href', /next=%2Faddon%2Fraidhelper/);
});

test('an uncached favorite reserves space without painting an empty button', async ({ page }) => {
	await loginAs(page, 'member');
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	await page.route('**/rest/v1/addon_favorites?*', async route => {
		if (route.request().method() !== 'GET') return route.continue();
		await gate;
		await route.fulfill({ json: [{ addon_id: 1 }] });
	});
	await page.goto('/addon/raidhelper');
	const loading = page.locator('button[aria-label="Loading favorite…"]');
	await expect(loading).toBeHidden();
	await expect(loading).toBeDisabled();
	await expect(loading).toHaveCSS('opacity', '1');
	await expect(loading).toHaveCSS('visibility', 'hidden');
	const before = await loading.boundingBox();
	release();
	const saved = page.getByRole('button', { name: 'Remove from favorites', exact: true });
	await expect(saved).toBeEnabled();
	await expect(saved).toHaveCSS('opacity', '1');
	const after = await saved.boundingBox();
	expect(after).toEqual(before);
});

for (const savedState of [false, true]) {
	test(`cached ${savedState ? 'saved' : 'unsaved'} favorite stays visible during navigation and refresh`, async ({ page }) => {
		await loginAs(page, 'member');
		await page.goto('/addon/raidhelper');
		const button = page.locator('button[aria-busy][aria-pressed]');
		await expect(button).toBeEnabled();
		if (await button.getAttribute('aria-pressed') !== String(savedState)) {
			await button.click();
			await expect(button).toHaveAttribute('aria-pressed', String(savedState));
			await expect(button).toBeEnabled();
		}
		for (const navigation of ['refresh', 'navigate']) {
			if (navigation === 'navigate') await page.goto('/');
			let release!: () => void;
			const gate = new Promise<void>(resolve => { release = resolve; });
			await page.route('**/rest/v1/addon_favorites?*', async route => {
				await gate;
				await route.fulfill({ json: savedState ? [{ addon_id: 1 }] : [] });
			});
			if (navigation === 'refresh') await page.reload();
			else await page.getByRole('link', { name: 'RaidHelper', exact: true }).first().click();
			await expect(button).toBeVisible();
			await expect(button).toHaveAttribute('aria-busy', 'true');
			await expect(button).toHaveText(savedState ? '★ Favorited' : '☆ Add to favorites');
			await expect(button).toHaveCSS('opacity', '1');
			const before = await button.boundingBox();
			release();
			await expect(button).toBeEnabled();
			await expect(button).toHaveText(savedState ? '★ Favorited' : '☆ Add to favorites');
			expect(await button.boundingBox()).toEqual(before);
			await page.unrouteAll({ behavior: 'wait' });
		}
		if (savedState) {
			await button.click();
			await expect(button).toHaveAttribute('aria-pressed', 'false');
		}
	});
}
