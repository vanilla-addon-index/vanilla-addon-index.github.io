import {expect, test} from './test.ts';
import {loginAs, unique} from './helpers.ts';

for (const who of ['member', 'admin'] as const) {
	test(`${who} can select a category by letter and tab away before submitting`, async ({page}) => {
		await loginAs(page, who);
		await page.goto('/submit');
		await page.getByLabel('Addon name', { exact: true }).fill(unique('Keyboard category'));
		await page.getByLabel('Link to the addon').fill('https://gitlab.com/keyboard/category');
		await page.getByLabel('Description', {exact:true}).fill('An addon submitted with a keyboard-selected category.');
		const category = page.getByLabel('Category', {exact:true});
		await category.click();
		await page.keyboard.press('Escape');
		await expect(category).toHaveValue('');
		await category.click();
		await page.keyboard.press('q');
		await expect(category).toHaveValue('Quests & Leveling');
		await page.keyboard.press('Tab');
		await expect(category).toHaveValue('Quests & Leveling');
		await page.route('**/rest/v1/rpc/submit_addon', route => route.fulfill({status:400, json:{message:'Test intercepted submission'}}));
		const request = page.waitForRequest('**/rest/v1/rpc/submit_addon');
		await page.getByRole('button', {name:'Post addon',exact:true}).click();
		expect((await request).postDataJSON().input.category).toBe('Quests & Leveling');
	});
}

test('import review keeps letter-key choices after closing and publishes that category', async ({page}) => {
	await loginAs(page, 'admin');
	await page.route('**/rest/v1/import_queue?*', async route => {
		if (route.request().method() !== 'GET') return route.continue();
		const response = await route.fetch(), rows = await response.json();
		await route.fulfill({response,json:[{...rows[0],name:'UnknownWidget',description:'Does useful things',category:''}]});
	});
	await page.route('**/rest/v1/rpc/publish_import', route => route.fulfill({json:null}));
	await page.goto('/admin/import');
	const entry = page.locator('[data-entry]').first();
	const category = entry.getByLabel('Category',{exact:true});
	await category.click();
	await page.keyboard.press('m');
	await expect(category).toHaveValue('Macros');
	await page.keyboard.press('m');
	await expect(category).toHaveValue('Map & Minimap');
	await page.keyboard.press('Escape');
	await expect(category).toHaveValue('Map & Minimap');
	await category.click();
	await page.keyboard.press('c');
	await page.keyboard.press('o');
	await expect(category).toHaveValue('Combat');
	await page.keyboard.press('ArrowDown');
	await expect(category).toHaveValue('Hardcore');
	await page.keyboard.press('ArrowUp');
	await expect(category).toHaveValue('Combat');
	await entry.getByLabel('Description',{exact:true}).click();
	await expect(category).toHaveValue('Combat');
	const request = page.waitForRequest('**/rest/v1/rpc/publish_import');
	await entry.locator('[data-act="approve"]').click();
	expect((await request).postDataJSON().input.category).toBe('Combat');
});
