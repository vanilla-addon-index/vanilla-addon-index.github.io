import {expect, test} from './test.ts';
import {loginAs} from './helpers.ts';

test('wiki pages have an exclusive waiting filter even when matching a published addon', async ({page}) => {
	await loginAs(page, 'admin');
	await page.route('**/rest/v1/import_queue?*', async route => {
		if (route.request().method() !== 'GET') return route.continue();
		const response = await route.fetch(), rows = await response.json();
		if (!Array.isArray(rows) || !rows.length) return route.fulfill({response});
		await route.fulfill({response, json:[{...rows[0], name:'RaidHelper', url:'https://turtle-wow.fandom.com/wiki/Addon_BigWigs', key:'turtle-wow.fandom.com/wiki/addon_bigwigs', category:'Raid & Party', description:'A raid helper with an existing page match.'}]});
	});
	await page.goto('/admin/import');
	const entry = page.locator('[data-entry]');
	await expect(entry).toHaveCount(1);
	await expect(page.getByRole('button', {name:/^Wiki pages\s+1$/})).toBeVisible();
	for (const label of ['Looks fine', 'Possible versions', 'Needs review']) {
		await page.getByRole('button', {name:new RegExp(`^${label}\\s+0$`)}).click();
		await expect(entry).toHaveCount(0);
	}
	await page.getByRole('button', {name:/^Wiki pages\s+1$/}).click();
	await expect(entry).toHaveCount(1);
	await expect(entry.getByRole('link', {name:'https://turtle-wow.fandom.com/wiki/Addon_BigWigs', exact:true})).toBeVisible();
	await page.getByRole('button', {name:/^All\s+1$/}).click();
	await expect(entry).toHaveCount(1);
});
