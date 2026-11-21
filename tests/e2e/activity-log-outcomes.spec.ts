import { expect, test } from './test.ts';
import { loginAs, logLine, openLogLine, postAddon, unique } from './helpers.ts';

test('unpinning a download link is explicit in the log and leaves the link listed', async ({ page }) => {
	const name = unique('Pin Activity');
	await loginAs(page, 'owner');
	const addon = await postAddon(page, name);
	await page.locator('summary').filter({ hasText: 'Pin a main link or split off a version' }).click();
	await page.getByRole('button', { name: 'Pin', exact: true }).click();
	await page.getByRole('button', { name: 'Unpin', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Pin', exact: true })).toBeEnabled();

	await page.goto('/admin/log');
	const row = logLine(page, 'unpinned a download link for ' + name);
	await openLogLine(row);
	await expect(row.getByRole('region', { name: 'Pinned download link comparison' }).getByText('No link pinned.').first()).toBeVisible();
	await expect(row.getByRole('button', { name: 'Revert', exact: true })).toBeVisible();

	await row.getByText('Addon history', { exact: true }).click();
	await expect(row.getByRole('link', { name: /pinned a download link for/ })).toBeVisible();
	await row.getByRole('link', { name: 'View full history' }).click();
	await expect(logLine(page, 'unpinned a download link for ' + name)).toBeVisible();

	await page.goto(addon);
	const url = 'https://gitlab.com/e2e/' + name.replace(/\W+/g, '-');
	await expect(page.locator('main').getByRole('link', { name: url, exact: true })).toBeVisible();
});
