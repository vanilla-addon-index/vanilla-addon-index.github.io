import {expect, test} from './test.ts';
import {loginAs} from './helpers.ts';

test('confirmed dead links have an exclusive filter even with missing details and a name match', async ({page}) => {
	await loginAs(page, 'admin');
	await page.route('**/rest/v1/repo_stats_current?*', route => route.fulfill({json:[{
		key:'github.com/missing/raidhelper', missing:true, archived:false, stars:0, pushed_at:null, interface:null, fork_of:null, canonical:null
	}]}));
	await page.route('**/rest/v1/import_queue?*', async route => {
		if (route.request().method() !== 'GET') return route.continue();
		const response = await route.fetch(), rows = await response.json();
		if (!Array.isArray(rows) || !rows.length) return route.fulfill({response});
		await route.fulfill({response, json:[{...rows[0], name:'RaidHelper', url:'https://github.com/missing/RaidHelper', key:'github.com/missing/raidhelper', category:'', description:''}]});
	});
	await page.goto('/admin/import');
	const entry = page.locator('[data-entry]');
	await expect(page.getByRole('button', {name:/^Dead links\s+1$/})).toBeVisible();
	for (const label of ['Looks fine', 'Possible versions', 'Needs review', 'Wiki pages']) {
		await page.getByRole('button', {name:new RegExp(`^${label}\\s+0$`)}).click();
		await expect(entry).toHaveCount(0);
	}
	await page.getByRole('button', {name:/^Dead links\s+1$/}).click();
	await expect(entry).toHaveCount(1);
	await expect(entry).toContainText('Repository no longer available');
	await expect(entry.getByRole('button')).toHaveCount(0);
	await page.keyboard.press('a');
	await page.keyboard.press('r');
	await expect(entry).toHaveCount(1);
	await page.getByRole('button', {name:/^All\s+0$/}).click();
	await expect(entry).toHaveCount(0);
});

test('filed dead links appear under Decided without manual decisions', async ({page}) => {
	await loginAs(page, 'admin');
	await page.route('**/rest/v1/repo_stats_current?*', route => route.fulfill({json:[]}));
	await page.route('**/rest/v1/import_queue?*', async route => {
		const url = new URL(route.request().url());
		if (url.searchParams.get('status') !== 'eq.dead') return route.continue();
		return route.fulfill({json:[{id:999999,key:'github.com/missing/gone',url:'https://github.com/missing/Gone',name:'GoneAddon',description:'An unavailable repository.',category:'Miscellaneous',images:[],alts:[],status:'dead'}]});
	});
	await page.goto('/admin/import');
	await page.getByRole('button', {name:/^Dead links\s+1$/}).click();
	const entry = page.locator('[data-entry]');
	await expect(entry).toContainText('GoneAddon');
	await expect(entry.getByRole('button')).toHaveCount(0);
	await page.getByLabel('Search',{exact:true}).fill('unmatched');
	await expect(entry).toHaveCount(0);
});
