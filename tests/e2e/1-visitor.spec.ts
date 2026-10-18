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
	const list = page.getByRole('region', { name: 'Addon list', exact: true });
	await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
	expect(await page.evaluate(() => window.scrollY)).toBe(0);
	await expect(letters.getByRole('button', { name: 'R', exact: true })).toHaveAttribute('aria-current', 'true');

	await page.getByLabel('Search addons').fill('member bags');
	await expect(page.getByRole('link', { name: /^Member Bags/ })).toBeVisible();
	await expect.poll(() => list.evaluate(element => element.scrollTop)).toBe(0);
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
	await expect(sort.locator('option')).toHaveText(['Name', 'Last update']);
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

test('a large catalogue reuses rows when sorting and keeps groups searchable', async ({ page }) => {
	const addons = Array.from({ length: 900 }, (_, index) => ({
		id: 10000 + index,
		slug: `sample-${index}`,
		name: `${index < 300 ? 'A' : index < 600 ? 'M' : 'Z'}Sample${String(index).padStart(4, '0')}`,
		description: index === 800 ? 'Distinctive grouped fork' : 'A catalogue performance sample',
		category: 'Combat', author: '',
		repo_url: `https://github.com/example/Sample${index}`,
		versions: [{ url: `https://github.com/example/Sample${index}`, note: '' }],
		images: [], group_id: [400, 800].includes(index) ? 99 : null, is_main: index === 400,
		code_update: { date: new Date(Date.UTC(2023, 0, index + 1)).toISOString(), url: '' }
	}));
	await page.route('**/rest/v1/addons?*', route => route.fulfill({ json: addons }));
	await page.goto('/?sort=name');
	const list = page.getByRole('region', { name: 'Addon list', exact: true });
	const rows = list.locator('a[href^="/addon/"]');
	await expect(rows).toHaveCount(900);
	const first = list.locator('a[href="/addon/sample-0"]');
	const node = await first.elementHandle();
	const row = first.locator('..').locator('..');
	await expect(row).toHaveCSS('content-visibility', 'auto');
	const nameBox = await first.boundingBox();
	const categoryBox = await row.getByText('Combat', { exact: true }).boundingBox();
	expect(Math.abs(nameBox!.y - categoryBox!.y)).toBeLessThan(5);
	const sort = page.getByRole('combobox', { name: 'Sort by' });
	await sort.selectOption('code');
	await expect(rows.first()).toHaveText('ZSample0899');
	await sort.selectOption('name');
	await expect(rows.first()).toHaveText('ASample0000');
	expect(await node!.evaluate(element => element.isConnected)).toBe(true);
	await page.getByRole('navigation', { name: 'Jump to a letter' }).getByRole('button', { name: 'M', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'M', exact: true })).toBeInViewport();
	await page.getByLabel('Search addons').fill('Distinctive grouped fork');
	await expect(rows).toHaveText([/^MSample0400/, /^ZSample0800/]);
});

test('sort choice survives addon navigation, browser back and reload while explicit sort links win', async ({ page }) => {
	await page.goto('/');
	const sort = page.getByRole('combobox', { name: 'Sort by' });
	await sort.selectOption('code');
	await expect(page).toHaveURL(/sort=code/);
	await page.getByRole('link', { name: /^RaidHelper/ }).first().click();
	await expect(page.getByRole('heading', { level: 1, name: 'RaidHelper', exact: true })).toBeVisible();
	await page.getByRole('link', { name: '← All addons' }).click();
	await expect(sort).toHaveValue('code');
	await expect(page.locator('a[href^="/addon/"]').first()).toHaveText(/RaidHelper/);
	await page.getByRole('link', { name: /^RaidHelper/ }).first().click();
	await expect(page).toHaveURL('/addon/raidhelper');
	await expect(page.getByRole('heading', { level: 1, name: 'RaidHelper', exact: true })).toBeVisible();
	await page.goBack();
	await expect(page).toHaveURL('/?sort=code');
	await expect(sort).toHaveValue('code');
	await page.reload();
	await expect(sort).toHaveValue('code');
	await page.goto('/?sort=name');
	await expect(sort).toHaveValue('name');
	await page.goto('/');
	await expect(sort).toHaveValue('code');
	await sort.selectOption('name');
	await page.reload();
	await expect(sort).toHaveValue('name');
});

test('an addon page shows its shared links and no admin controls', async ({ page }) => {
	await page.goto('/addon/raidhelper');
	await expect(page.getByRole('heading', { level: 1, name: 'RaidHelper' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Links', exact: true })).toHaveCount(0);
	await expect(page.getByRole('link', { name: /github.com\/.*\/RaidTracker$/ })).toBeVisible();

	await expect(page.getByRole('link', { name: 'Log in to report this addon' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Edit' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Remove from group' })).toHaveCount(0);
	// Who posted an entry is for admins.
	await expect(page.getByText('Posted by')).toHaveCount(0);
	const facts = page.locator('dl').filter({ hasText: 'Author' });
	await expect(facts).toHaveCount(3);
	await expect(facts.getByText('Last update')).toHaveCount(3);
	await expect(facts.getByText('Unknown', { exact: true })).toHaveCount(2);
	for (const link of await page.locator('aside ol > li').all()) {
		await expect(link.getByText('Author', { exact: true })).toBeVisible();
	}
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
	await page.getByRole('navigation', { name: 'About sections' }).getByRole('link', { name: 'Privacy', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Privacy', exact: true })).toBeVisible();
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
