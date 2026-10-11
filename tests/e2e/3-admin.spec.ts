import { expect, test, type Page } from '@playwright/test';
import { confirm, loginAs, logLine, postAddon, unique } from './helpers.ts';

// An admin: reviews imports and reports, and can undo anything from the log.

const waiting = async (page: Page) =>
	Number(await page.locator('dl > div', { hasText: 'Waiting' }).locator('dd').innerText());
const entry = (page: Page, name: string) => page.locator('[data-entry]').filter({ has: page.locator(`input[aria-label="Name"][value="${name}"]`) });

test('the report a member sent shows up, with a count on the Admin button, and can be dismissed', async ({ page }) => {
	await loginAs(page, 'admin');
	const admin = page.getByRole('navigation').getByRole('link', { name: /^Admin/ });
	await expect(admin).toContainText('1');
	await admin.click();
	await expect(page).toHaveURL(/\/admin\/reports/);

	const report = page.locator('.panel > div').filter({ hasText: 'QuestHelper' });
	await expect(report.getByText('Harmful or malicious')).toBeVisible();
	await expect(report.getByText('Reported by a browser test.')).toBeVisible();
	await report.getByRole('button', { name: 'Dismiss' }).click();
	await expect(page.getByText('No reports are waiting.')).toBeVisible();
	await expect(admin).not.toContainText('1');
});

test('an import is approved as it is, another with changes, and one is rejected and put back', async ({ page }) => {
	await loginAs(page, 'admin');
	await page.goto('/admin/import');
	await expect(page.locator('[data-entry]').first()).toBeVisible();
	const before = await waiting(page);

	// As it is.
	const first = page.locator('[data-entry]').first();
	const firstName = await first.getByLabel('Name').inputValue();
	await first.getByRole('button', { name: 'Approve', exact: true }).click();
	await expect.poll(() => waiting(page)).toBe(before - 1);

	// With a new name and category, typed into the entry itself.
	const second = page.locator('[data-entry]').first();
	const renamed = unique('Renamed');
	await second.getByLabel('Name').fill(renamed);
	await second.getByLabel('Category').selectOption('PvP');
	await expect(second.getByRole('button', { name: 'Undo my changes' })).toBeVisible();
	await second.getByRole('button', { name: 'Approve', exact: true }).click();
	await expect.poll(() => waiting(page)).toBe(before - 2);

	// Rejected, then put back from the list of rejected entries.
	const third = page.locator('[data-entry]').first();
	const thirdName = await third.getByLabel('Name').inputValue();
	await third.getByRole('button', { name: 'Reject' }).click();
	await expect.poll(() => waiting(page)).toBe(before - 3);
	await page.getByRole('button', { name: /^Rejected/ }).click();
	await page.locator('.panel > div').filter({ hasText: thirdName }).getByRole('button', { name: 'Put back in the queue' }).click();
	await page.getByRole('button', { name: /^All/ }).click();
	await expect.poll(() => waiting(page)).toBe(before - 2);

	// Both approved ones are live, the second as it was changed.
	await page.goto('/');
	await page.getByLabel('Search addons').fill(renamed);
	await expect(page.getByRole('link', { name: new RegExp(`^${renamed}`) })).toBeVisible();
	await expect(page.getByText('PvP', { exact: true }).last()).toBeVisible();
	await page.getByLabel('Search addons').fill(firstName);
	await expect(page.getByRole('link', { name: new RegExp(`^${firstName}`) }).first()).toBeVisible();

	// The log calls both approvals, neither an edit, and offers the way back.
	await page.goto('/admin/log');
	await expect(logLine(page, new RegExp(`approved the import of\\s+${renamed}`))).toBeVisible();
	await expect(page.locator('.panel > div').filter({ hasText: new RegExp(`edited\\s+${renamed}`) })).toHaveCount(0);
	await logLine(page, new RegExp(`approved the import of\\s+${renamed}`)).getByRole('button', { name: 'Back to the queue' }).click();
	await confirm(page, 'Back to the queue');
	await expect(page.getByText(`"${renamed}" is back in the import queue.`)).toBeVisible();
	await page.goto('/admin/import');
	await expect.poll(() => waiting(page)).toBe(before - 1);
});

test('a group change is undone from its line in the log', async ({ page }) => {
	await loginAs(page, 'admin');
	const one = unique('Grouped');
	const two = unique('Version');
	await postAddon(page, two);
	const address = await postAddon(page, one);

	await page.getByPlaceholder('Group with another addon…').fill(two);
	await page.getByRole('button', { name: new RegExp(`^${two}`) }).click();
	await expect(page.getByRole('heading', { name: 'Versions' })).toBeVisible();

	await page.goto('/admin/log');
	const line = logLine(page, new RegExp(`grouped versions under\\s+${one}`));
	await line.getByRole('button', { name: 'Undo' }).click();
	await confirm(page, 'Undo');
	await expect(page.getByText('The group change is undone.')).toBeVisible();
	// Undone once, it is not offered again on that line; the undo itself can be undone.
	await expect(line.getByRole('button', { name: 'Undo' })).toHaveCount(0);
	await expect(logLine(page, new RegExp(`undid a group change of\\s+${one}`)).getByRole('button', { name: 'Undo' })).toBeVisible();

	await page.goto(address);
	await expect(page.getByRole('heading', { level: 1, name: one })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Versions' })).toHaveCount(0);
});

test('an edit is reverted, and a deleted addon restored to the same address, from the log', async ({ page }) => {
	await loginAs(page, 'admin');
	const name = unique('Damaged');
	const address = await postAddon(page, name, { description: 'The description as it should be.' });

	await page.getByRole('link', { name: 'Edit' }).click();
	await page.getByLabel('Description', { exact: true }).fill('Vandalised by a browser test.');
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page.getByText('Vandalised by a browser test.')).toBeVisible();

	await page.goto('/admin/log');
	const edited = logLine(page, new RegExp(`edited\\s+${name}`));
	await edited.getByText('Show what changed').click();
	await expect(edited.getByText('The description as it should be.')).toBeVisible();
	await edited.getByRole('button', { name: 'Revert' }).click();
	await confirm(page, 'Revert');
	await expect(page.getByText(`"${name}" is back to how it was before that edit.`)).toBeVisible();
	await page.goto(address);
	await expect(page.getByText('The description as it should be.')).toBeVisible();

	await page.getByRole('button', { name: 'Delete' }).click();
	await confirm(page, 'Delete');
	await page.goto('/admin/log');
	await logLine(page, new RegExp(`deleted\\s+${name}`)).getByRole('button', { name: 'Restore' }).click();
	await confirm(page, 'Restore');
	await expect(page.getByText(`Restored "${name}".`)).toBeVisible();
	// Restored once, the line no longer offers it.
	await expect(logLine(page, new RegExp(`deleted\\s+${name}`)).getByRole('button', { name: 'Restore' })).toHaveCount(0);

	await page.goto(address);
	await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
	await expect(page.getByText('The description as it should be.')).toBeVisible();
});

test('the log is searched in the database: by name, by kind, by addon and by account', async ({ page }) => {
	await loginAs(page, 'admin');
	const name = unique('Storied');
	await postAddon(page, name);
	await page.getByRole('link', { name: 'Edit' }).click();
	await page.getByLabel('Addon author').fill('Somebody');
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page.getByText('Somebody')).toBeVisible();

	// From the addon's page: its history, and nothing else.
	await page.getByRole('link', { name: 'History' }).click();
	await expect(page).toHaveURL(/\/admin\/log\?addon=\d+/);
	await expect(page.getByText(`History of ${name}`)).toBeVisible();
	const lines = page.locator('.panel > div');
	await expect(lines).toHaveCount(2);
	await expect(lines.nth(0)).toContainText(`edited ${name}`);
	await expect(lines.nth(1)).toContainText(`posted ${name}`);

	// Narrowed further by kind, then back to the whole log.
	await page.getByLabel('Kind of action').selectOption('group');
	await expect(page.getByText('No line matches.')).toBeVisible();
	await page.getByLabel('Kind of action').selectOption('all');
	await page.getByRole('button', { name: 'Show the whole log' }).click();
	await expect(page.getByText(`History of ${name}`)).toHaveCount(0);

	// By part of a name, typed into the search box.
	await page.getByLabel('Search the log').fill(name.slice(0, -2));
	await expect(lines).toHaveCount(2);
	await expect(page).toHaveURL(/q=Storied/);
	await page.getByLabel('Search the log').fill('no such addon, (at all)');
	await expect(page.getByText('No line matches.')).toBeVisible();

	// By account, from that account's page.
	await page.goto('/admin/users/profile?name=member');
	await page.getByRole('link', { name: 'Everything they did, in the log' }).click();
	await expect(page.getByText('Everything done by member')).toBeVisible();
	await expect(lines.first()).toContainText('member');
	for (const line of await lines.all()) await expect(line.locator('.font-bold').first()).toHaveText('member');
});

test('a member is banned from the Users tab, with nothing trashed, and unbanned from the log', async ({ page }) => {
	await loginAs(page, 'admin');
	await page.goto('/admin/users/profile?name=member2');
	await expect(page.getByRole('heading', { level: 1, name: 'member2' })).toBeVisible();
	await expect(page.getByRole('button', { name: /trash/i })).toHaveCount(0);
	await page.getByRole('button', { name: 'Ban', exact: true }).click();
	await confirm(page, 'Ban');
	await expect(page.getByText('member2 is banned.')).toBeVisible();

	// What they posted is still up.
	await page.goto('/addon/second-member-chat');
	await expect(page.getByRole('heading', { level: 1, name: 'Second Member Chat' })).toBeVisible();

	await page.goto('/admin/log');
	await logLine(page, /banned\s+member2/).getByRole('button', { name: 'Lift the ban' }).click();
	await confirm(page, 'Lift the ban');
	await expect(page.getByText('member2 can post again.')).toBeVisible();
	await expect(logLine(page, /banned\s+member2/).getByRole('button', { name: 'Lift the ban' })).toHaveCount(0);
});

test('an admin cannot suspend another admin or empty the trash; the owner can', async ({ page }) => {
	await loginAs(page, 'admin');
	await page.goto('/admin/users/profile?name=admin2');
	await expect(page.getByRole('heading', { level: 1, name: 'admin2' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Suspend' })).toHaveCount(0);
	await page.goto('/admin/trash');
	await expect(page.getByRole('button', { name: 'Empty the trash' })).toHaveCount(0);
	await page.goto('/account');
	await page.getByRole('button', { name: 'Log out' }).click();
	await expect(page.getByRole('navigation').getByRole('link', { name: 'Log in' })).toBeVisible();

	await loginAs(page, 'owner');
	await page.goto('/admin/users/profile?name=admin2');
	await expect(page.getByRole('button', { name: 'Suspend' })).toBeVisible();
});
