import {expect, test} from './test.ts';
import {loginAs} from './helpers.ts';

test('same-name imports inherit the existing category and keyboard approval needs no selection', async ({page}) => {
	await loginAs(page, 'admin');
	await page.route('**/rest/v1/addons?*', async route => {
		const response = await route.fetch(), rows = await response.json();
		await route.fulfill({response, json:rows.map(row => row.id === 1 ? {...row, name:'OpaqueWidget', category:'Professions'} : row)});
	});
	await page.route('**/rest/v1/import_queue?*', async route => {
		if (route.request().method() !== 'GET') return route.continue();
		const response = await route.fetch(), rows = await response.json();
		await route.fulfill({response, json:[{...rows[0], key:'github.com/a/opaquewidget', url:'https://github.com/a/OpaqueWidget', name:'OpaqueWidget', category:'', description:''}]});
	});
	await page.route('**/rest/v1/rpc/publish_import', route => route.fulfill({json:null}));
	await page.goto('/admin/import');
	const entry = page.locator('[data-entry]').first();
	await expect(entry.getByLabel('Category', {exact:true})).toHaveValue('Professions');
	await expect(entry.getByLabel('Category', {exact:true})).toBeDisabled();
	await expect(entry.getByText('Choose a category', {exact:true})).toHaveCount(0);
	await expect(entry.getByRole('button', {name:'Add link to OpaqueWidget', exact:true})).toBeEnabled();
	await entry.getByLabel('Name', {exact:true}).fill('OtherOpaqueWidget');
	await expect(entry.getByLabel('Category', {exact:true})).toBeEnabled();
	await expect(entry.getByLabel('Category', {exact:true})).toHaveValue('');
	await expect(entry.getByRole('button', {name:'Approve', exact:true})).toBeDisabled();
	await entry.getByLabel('Name', {exact:true}).fill('OpaqueWidget');
	await expect(entry.getByLabel('Category', {exact:true})).toHaveValue('Professions');
	const request = page.waitForRequest('**/rest/v1/rpc/publish_import');
	await page.getByRole('region', {name:'Import entries', exact:true}).focus();
	await page.keyboard.press('a');
	const payload = (await request).postDataJSON();
	expect(payload.destination).toBe(1);
	expect(payload.input.category).toBe('Professions');
});

test('repository evidence and old guesses do not preselect a category', async ({page}) => {
	await loginAs(page, 'admin');
	await page.route('**/rest/v1/import_queue?*', async route => {
		if (route.request().method() !== 'GET') return route.continue();
		const response = await route.fetch(), rows = await response.json();
		if (!Array.isArray(rows) || !rows.length) return route.fulfill({response});
		await route.fulfill({response, json:[{...rows[0], name:'MysteryThing', key:'github.com/a/chatthing', url:'https://github.com/a/ChatThing', category:'Chat & Social', description:'', category_context:{repository:'A damage meter for your party.'}}]});
	});
	await page.route('**/rest/v1/rpc/publish_import', route => route.fulfill({json:null}));
	await page.goto('/admin/import');
	const entry = page.locator('[data-entry]').first();
	await expect(entry.getByLabel('Category', {exact:true})).toHaveValue('');
	await expect(entry.locator('[data-act="approve"]')).toBeDisabled();
	const category = entry.getByLabel('Category', {exact:true});
	const description = entry.getByLabel('Description', {exact:true});
	await expect(category).toHaveClass(/border-accent\/60/);
	await expect(description).toHaveClass(/border-accent\/60/);
	await category.selectOption('Combat');
	await expect(category).not.toHaveClass(/border-accent\/60/);
	await expect(entry.locator('[data-act="approve"]')).toBeDisabled();
	await description.fill('   ');
	await description.press('Control+Enter');
	await expect(page.getByText('Add a description before approving this import.', {exact:true})).toBeVisible();
	await expect(entry.locator('[data-act="approve"]')).toBeDisabled();
	await description.fill('Shows combat information for your party.');
	await expect(description).not.toHaveClass(/border-accent\/60/);
	await expect(entry.locator('[data-act="approve"]')).toBeEnabled();
	const request = page.waitForRequest('**/rest/v1/rpc/publish_import');
	await entry.locator('[data-act="approve"]').click();
	expect((await request).postDataJSON().input.category).toBe('Combat');
});

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
	await expect(entry.getByLabel('Category', {exact:true})).toHaveValue('');
	await expect(entry.getByText(/Category suggestion:/)).toHaveCount(0);
	await expect(entry.getByText('Ready', {exact:true})).toHaveCount(0);
	await expect(entry.getByRole('note', {name:'Import status'})).toContainText('Choose a category');
	await page.getByRole('button', {name:/^Needs review/}).click();
	await expect(entry).toHaveCount(1);
	await entry.getByLabel('Category', {exact:true}).selectOption('Miscellaneous');
	await expect(entry.getByLabel('Category', {exact:true})).toHaveValue('Miscellaneous');
	await expect(entry.getByRole('button', {name:'Undo my changes'})).toBeVisible();
});

test('new imports have a blank category and cannot be approved until an admin chooses', async ({page}) => {
	await loginAs(page, 'admin');
	await page.route('**/rest/v1/import_queue?*', async route => {
		if (route.request().method() !== 'GET') return route.continue();
		const response = await route.fetch(), rows = await response.json();
		if (!Array.isArray(rows) || !rows.length) return route.fulfill({response});
		await route.fulfill({response, json:[{...rows[0], key:'github.com/a/unknownwidget', url:'https://github.com/a/UnknownWidget', name:'UnknownWidget', category:'Miscellaneous', description:'Includes a button.'}]});
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
