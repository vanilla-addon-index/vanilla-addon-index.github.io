import { expect, test } from './test.ts';
import { loginAs, postAddon, unique } from './helpers.ts';

test('Hardcore is available for posting and filtering', async ({ page }) => {
	await loginAs(page, 'admin');
	const name = unique('HardcoreHelper');
	await postAddon(page, name, { category: 'Hardcore' });
	await expect(page.getByRole('link', { name: 'Hardcore', exact: true })).toBeVisible();
	await page.goto('/');
	await page.getByRole('button', { name: /^Hardcore/ }).click();
	await page.getByLabel('Search addons').fill(name);
	await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
	await expect(page).toHaveURL(/cat=Hardcore/);
});
