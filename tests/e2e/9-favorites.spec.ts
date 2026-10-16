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
	await expect(favorites.getByText('Last code update:')).toBeVisible();
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
