import { expect, test } from './test.ts';

// Someone who is not logged in: can read everything public, and nothing else.

test('the list loads, and search and categories narrow it', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('link', { name: /^Member Map/ })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Log in' })).toBeVisible();

	// Sorted by name, the list has a bar of letters, and each jumps to its heading.
	const letters = page.getByRole('navigation', { name: 'Jump to a letter' });
	await expect(letters.getByRole('button', { name: '#', exact: true })).toBeDisabled();
	await letters.getByRole('button', { name: 'R', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'R', exact: true })).toBeInViewport();

	await page.getByLabel('Search addons').fill('member bags');
	await expect(page.getByRole('link', { name: /^Member Bags/ })).toBeVisible();
	await expect(page.getByRole('link', { name: /^Member Map/ })).toHaveCount(0);
	// The search is in the address, so it can be shared.
	await expect(page).toHaveURL(/q=member\+bags/);

	await page.getByLabel('Search addons').fill('');
	await page.getByRole('button', { name: /^Tooltip/ }).click();
	await expect(page.getByRole('link', { name: /^Banned Tooltip/ })).toBeVisible();
	await expect(page).toHaveURL(/cat=Tooltip/);
});

test('date sorting follows last code update and accepts old sort links', async ({ page }) => {
	await page.goto('/');
	const sort = page.getByRole('combobox', { name: 'Sort by' });
	await expect(sort.locator('option')).toHaveText(['Name', 'Last code update']);
	await sort.selectOption('code');
	await expect(page).toHaveURL(/sort=code/);
	// RaidHelper has a known code date; recently added entries without one go below it.
	await expect(page.locator('a[href^="/addon/"]').first()).toHaveText(/RaidHelper/);
	for (const old of ['new', 'updated']) {
		await page.goto(`/?sort=${old}`);
		await expect(sort).toHaveValue('code');
		await expect(page.locator('a[href^="/addon/"]').first()).toHaveText(/RaidHelper/);
	}
});

test('an addon page shows the addon, its group and no admin controls', async ({ page }) => {
	await page.goto('/addon/raidhelper');
	await expect(page.getByRole('heading', { level: 1, name: 'RaidHelper' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Links', exact: true })).toBeVisible();
	await expect(page.getByRole('link', { name: /github.com\/.*\/RaidTracker$/ })).toBeVisible();

	await expect(page.getByRole('link', { name: 'Log in to report this addon' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Edit' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Remove from group' })).toHaveCount(0);
	// Who posted an entry is for admins.
	await expect(page.getByText('Posted by')).toHaveCount(0);
	const facts = page.locator('dl').filter({ hasText: 'Author' });
	await expect(facts.getByText('Last code update')).toBeVisible();
	await expect(facts.getByRole('link', { name: /2024/ })).toHaveAttribute('href', /\/commits\/HEAD$/);
	await expect(facts.locator('time')).toHaveAttribute('datetime', '2024-06-14T14:00:48+00:00');
	await expect(facts.getByText('Added', { exact: true })).toHaveCount(0);
	await expect(facts.getByText('Updated', { exact: true })).toHaveCount(0);
	await page.goto('/addon/member-map');
	await expect(page.locator('dl').getByText('Unknown', { exact: true })).toBeVisible();
});

test('the footer leads to what the site is and what it stores', async ({ page }) => {
	await page.goto('/');
	await page.getByRole('link', { name: 'About and privacy' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'About' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Privacy' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'open an issue on GitHub' }).first()).toHaveAttribute('href', /\/issues$/);
});

test('an address that does not exist says so', async ({ page }) => {
	await page.goto('/addon/no-such-addon');
	await expect(page.getByRole('heading', { name: 'Addon not found' })).toBeVisible();
});

test('posting needs a login, and the admin pages are closed', async ({ page }) => {
	await page.goto('/submit');
	await expect(page.getByText('You need to log in to post or edit addons.')).toBeVisible();

	for (const tab of ['import', 'reports', 'groups', 'log', 'trash', 'users']) {
		await page.goto(`/admin/${tab}`);
		await expect(page.getByText('This part of the site is for admins.')).toBeVisible();
	}
	await page.goto('/account');
	await expect(page.getByText('You are not logged in.')).toBeVisible();
});
