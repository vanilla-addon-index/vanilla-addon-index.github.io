import {expect, test} from './test.ts';
import {loginAs} from './helpers.ts';

test('old archived imports stay quiet, omit the obsolete filter and preserve admin category choices', async ({page}) => {
	await loginAs(page, 'admin');
	await page.route('**/rest/v1/repo_stats_current?*', route => route.fulfill({json:[{
		key:'github.com/a/chatmonitor', pushed_at:'2010-01-01T00:00:00Z', stars:1,
		missing:false, archived:true, interface:11200, fork_of:null, canonical:null
	}]}));
	await page.route('**/rest/v1/import_queue?*', async route => {
		if (route.request().method() !== 'GET') return route.continue();
		const response = await route.fetch(), rows = await response.json();
		if (!Array.isArray(rows) || !rows.length) return route.fulfill({response});
		await route.fulfill({response, json:[{...rows[0], key:'github.com/a/chatmonitor', url:'https://github.com/a/ChatMonitor', obsolete:true, name:'ChatMonitor', category:'Chat & Social', description:'Monitors the chat. Includes a minimap button.'}]});
	});
	await page.goto('/admin/import');
	const entry = page.locator('[data-entry]').first();
	await expect(page.getByRole('button', {name:'Obsolete or dead', exact:false})).toHaveCount(0);
	await expect(entry.getByText('2010', {exact:true})).toBeVisible();
	await expect(entry.getByLabel('Category', {exact:true})).toHaveValue('Chat & Social');
	await expect(entry.getByText(/Category suggestion:/)).toHaveCount(0);
	await expect(entry.getByText('Ready', {exact:true})).toHaveCount(0);
	await expect(entry.getByRole('note', {name:'Import status'})).toHaveCount(0);
	await page.getByRole('button', {name:/^Looks fine/}).click();
	await expect(entry).toHaveCount(1);
	await entry.getByLabel('Category', {exact:true}).selectOption('Miscellaneous');
	await expect(entry.getByLabel('Category', {exact:true})).toHaveValue('Miscellaneous');
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
	await expect(entry.getByRole('note', {name:'Import status'})).toContainText('Choose a category');
	const approve = entry.locator('[data-act="approve"]');
	await expect(approve).toBeDisabled();
	await entry.getByLabel('Description', {exact:true}).press('Control+Enter');
	await expect(page.getByText('Choose a category before approving this import.', {exact:true})).toBeVisible();
	await entry.getByLabel('Category', {exact:true}).selectOption('Chat & Social');
	await expect(approve).toBeEnabled();
	await expect(entry.getByRole('note', {name:'Import status'}).getByText('Choose a category', {exact:true})).toHaveCount(0);
	await entry.getByRole('button', {name:'Undo my changes'}).click();
	await expect(entry.getByLabel('Category', {exact:true})).toHaveValue('');
	await expect(approve).toBeDisabled();
});
