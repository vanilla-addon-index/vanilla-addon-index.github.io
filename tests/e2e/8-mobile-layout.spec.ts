import { expect, test } from './test.ts';
import { loginAs } from './helpers.ts';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('phone front-page search and letter navigation fit without horizontal page scrolling', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 844 });
	await page.goto('/');
	const letters = page.getByRole('navigation', { name: 'Jump to a letter' });
	await expect(letters).toBeVisible();
	await expect.poll(async () => (await letters.boundingBox())!.height).toBeLessThan(60);
	await expect.poll(async () => (await letters.getByRole('button', { name: 'R', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
	await letters.getByRole('button', { name: 'R', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'R', exact: true })).toBeInViewport();
	await page.getByRole('searchbox', { name: 'Search addons' }).fill('RaidHelper');
	await expect(page.getByRole('region', { name: 'Addon list' }).getByRole('link', { name: 'RaidHelper', exact: true })).toBeVisible();
	await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
});

test('phone navigation reaches About sections without horizontal page overflow', async ({ page }) => {
	await page.goto('/about');
	const details = page.getByRole('button', { name: 'About this site', exact: true });
	await expect(details).toHaveAttribute('aria-expanded', 'false');
	await details.click();
	await expect(page.getByRole('link', { name: 'Source on GitHub', exact: true })).toBeVisible();
	await details.click();
	const navigation = page.getByRole('navigation', { name: 'About sections' });
	await navigation.getByRole('link', { name: 'Contact', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Contact', exact: true })).toBeInViewport();
	await page.goto('/about#privacy');
	await expect(page.getByRole('heading', { name: 'Privacy', exact: true })).toBeInViewport();
	for (const width of [320, 390, 640]) {
		await page.setViewportSize({ width, height: 844 });
		await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
	}
});

test('phone admin entries come before expandable filters and navigation can be swiped', async ({ page }) => {
	await loginAs(page, 'admin');
	await page.goto('/admin/import');
	const filters = page.getByRole('button', { name: 'Import filters and counts', exact: true });
	await expect(filters).toHaveAttribute('aria-expanded', 'false');
	await expect(page.locator('[data-entry]').first()).toBeInViewport();
	await filters.click();
	await expect(page.getByRole('button', { name: /Looks fine/ })).toBeVisible();
	await filters.click();
	const navigation = page.getByRole('navigation', { name: 'Admin', exact: true });
	await expect.poll(async () => (await navigation.boundingBox())!.height).toBeLessThan(60);
	await navigation.getByRole('link', { name: 'Users', exact: true }).click();
	await expect(page.getByRole('searchbox', { name: 'Search accounts' })).toBeInViewport();
	await page.getByRole('searchbox', { name: 'Search accounts' }).fill('member2');
	await expect(page.getByRole('region', { name: 'Admin content' }).getByRole('link', { name: 'member2', exact: true })).toBeVisible();
	await page.setViewportSize({ width: 1440, height: 900 });
	await expect(page.getByRole('button', { name: 'Page details and filters', exact: true })).toBeHidden();
	await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();
});

test('phone account options and submit fields remain usable at the smallest width', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 844 });
	await loginAs(page, 'admin');
	await page.goto('/account');
	await expect(page.getByRole('searchbox', { name: 'Search your addons' })).toBeInViewport();
	await page.getByRole('button', { name: 'Account details and options', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Log out', exact: true })).toBeVisible();
	await page.goto('/submit');
	await expect(page.getByLabel('Name', { exact: true })).toBeInViewport();
	await page.getByRole('navigation', { name: 'Form sections' }).getByRole('button', { name: 'Preview', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Preview', exact: true })).toBeInViewport();
	await page.getByRole('navigation', { name: 'Form sections' }).getByRole('button', { name: 'Required details', exact: true }).click();
	await expect(page.getByLabel('Name', { exact: true })).toBeInViewport();
	await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
});
