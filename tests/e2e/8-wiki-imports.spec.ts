import {expect, test} from './test.ts';
import {loginAs} from './helpers.ts';

test('wiki pages have an exclusive waiting filter even when matching a published addon', async ({page}) => {
	await loginAs(page, 'admin');
	await page.route('https://turtle-wow.fandom.com/api.php?*', route => route.fulfill({ status: 403 }));
	await page.route('**/rest/v1/rpc/import_review_counts', route => route.fulfill({
		json: { waiting: 1, pending: 1, wiki: 1, fine: 0, duplicate: 0, incomplete: 0, dead: 0 }
	}));
	await page.route('**/rest/v1/decided_imports?*', route => route.fulfill({ json: [] }));
	await page.route('**/rest/v1/pending_imports?*', route => {
		if (route.request().method() !== 'GET') return route.continue();
		const bucket = new URL(route.request().url()).searchParams.get('review_bucket');
		const item = {
			id: 99001, name:'RaidHelper', url:'https://turtle-wow.fandom.com/wiki/Addon_BigWigs',
			key:'turtle-wow.fandom.com/wiki/addon_bigwigs', category:'Raid & Party',
			description:'A raid helper with an existing page match.', status: 'pending', images: [], alts: []
		};
		return route.fulfill({ json: bucket === 'eq.wiki' || bucket === null ? [item] : [] });
	});
	await page.goto('/admin/import');
	const entry = page.locator('[data-entry]');
	await expect(entry).toHaveCount(1);
	await expect(page.getByRole('button', {name:/^Wiki pages\s+1$/})).toBeVisible();
	for (const label of ['Looks fine', 'Possible versions', 'Needs review', 'Dead links']) {
		await page.getByRole('button', {name:new RegExp(`^${label}\\s+0$`)}).click();
		await expect(entry).toHaveCount(0);
	}
	await page.getByRole('button', {name:/^Wiki pages\s+1$/}).click();
	await expect(entry).toHaveCount(1);
	await expect(entry.getByRole('link', {name:'https://turtle-wow.fandom.com/wiki/Addon_BigWigs', exact:true})).toBeVisible();
	await page.getByRole('button', {name:/^All\s+1$/}).click();
	await expect(entry).toHaveCount(1);
});
