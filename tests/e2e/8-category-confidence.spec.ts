import {expect, test} from './test.ts';
import {loginAs} from './helpers.ts';

test('import category confidence explains evidence without overriding admin choices', async ({page}) => {
	await loginAs(page, 'admin');
	await page.route('**/rest/v1/import_queue?*', async route => {
		if (route.request().method() !== 'GET') return route.continue();
		const response = await route.fetch(), rows = await response.json();
		if (!Array.isArray(rows) || !rows.length) return route.fulfill({response});
		await route.fulfill({response, json:[{...rows[0], name:'ChatMonitor', category:'Chat & Social', description:'Monitors the chat. Includes a minimap button.'}]});
	});
	await page.goto('/admin/import');
	const entry = page.locator('[data-entry]').first();
	const suggestion = entry.locator('details').filter({has:page.locator('summary', {hasText:'Category suggestion:'})});
	await expect(suggestion.locator('summary')).toHaveText('Category suggestion: Chat & Social · Strong match');
	await suggestion.locator('summary').click();
	await expect(suggestion.getByText(/Name: “Chat”/)).toBeVisible();
	await expect(suggestion.getByText(/Description: “Monitors the chat”/)).toBeVisible();
	await expect(suggestion.getByText('Action Bars:', {exact:true})).toBeVisible();
	await entry.getByLabel('Category', {exact:true}).selectOption('Miscellaneous');
	await expect(entry.getByLabel('Category', {exact:true})).toHaveValue('Miscellaneous');
	await expect(suggestion.locator('summary')).toContainText('Chat & Social');
	await expect(entry.getByRole('button', {name:'Undo my changes'})).toBeVisible();
});

test('uncertain imports have a blank category and cannot be approved until an admin chooses', async ({page}) => {
	await loginAs(page, 'admin');
	await page.route('**/rest/v1/import_queue?*', async route => {
		if (route.request().method() !== 'GET') return route.continue();
		const response = await route.fetch(), rows = await response.json();
		if (!Array.isArray(rows) || !rows.length) return route.fulfill({response});
		await route.fulfill({response, json:[{...rows[0], name:'UnknownWidget', category:'Miscellaneous', description:'Includes a button.'}]});
	});
	await page.goto('/admin/import');
	const entry = page.locator('[data-entry]').first();
	await expect(entry.getByLabel('Category', {exact:true})).toHaveValue('');
	await expect(entry.locator('summary').filter({hasText:'Category suggestion:'})).toContainText('Uncertain');
	const approve = entry.locator('[data-act="approve"]');
	await expect(approve).toBeDisabled();
	await entry.getByLabel('Description', {exact:true}).press('Control+Enter');
	await expect(page.getByText('Choose a category before approving this import.', {exact:true})).toBeVisible();
	await entry.getByLabel('Category', {exact:true}).selectOption('Chat & Social');
	await expect(approve).toBeEnabled();
	await entry.getByRole('button', {name:'Undo my changes'}).click();
	await expect(entry.getByLabel('Category', {exact:true})).toHaveValue('');
	await expect(approve).toBeDisabled();
});
