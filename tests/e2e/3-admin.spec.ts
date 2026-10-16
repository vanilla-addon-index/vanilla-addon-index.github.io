import type { Page } from '@playwright/test';
import { expect, test } from './test.ts';
import { confirm, loginAs, logLine, postAddon, unique, chooseImportCategory } from './helpers.ts';

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

test('the queue narrows to the entries that would be published with something missing', async ({ page }) => {
	await loginAs(page, 'admin');
	await page.goto('/admin/import');
	const entries = page.locator('[data-entry]');
	await expect(entries.first()).toBeVisible();
	const all = await entries.count();

	await page.getByRole('button', { name: /^Missing details/ }).click();
	// Each says what it lacks; the test queue has a few with no description.
	await expect(entries.first().getByRole('note', { name: 'Import status' })).toContainText(/Missing:\s*description/);
	const incomplete = await entries.count();
	expect(incomplete).toBeGreaterThan(0);
	expect(incomplete).toBeLessThan(all);
	await expect(entries.filter({ has: page.getByRole('note', { name: 'Import status' }).filter({ hasText: /Missing:\s*description/ }) })).toHaveCount(incomplete);
	await expect(entries.filter({ hasText: 'Ready' })).toHaveCount(0);
	const names = await entries.getByLabel('Name', { exact: true }).evaluateAll((inputs) =>
		inputs.map((input) => (input as HTMLInputElement).value)
	);

	const fine = page.getByRole('button', { name: /^Looks fine/ });
	const fineCount = Number((await fine.innerText()).match(/\d+/)![0]);
	await fine.click();
	await expect(entries).toHaveCount(fineCount);
	expect(fineCount).toBeGreaterThan(0);
	await expect(entries.filter({ has: page.getByRole('note', { name: 'Import status' }).filter({ hasText: /Missing:\s*description/ }) })).toHaveCount(0);
	for (const name of names) await expect(entry(page, name)).toHaveCount(0);
});

test('an import is approved as it is, another with changes, and one is rejected and put back', async ({ page }) => {
	await loginAs(page, 'admin');
	await page.goto('/admin/import');
	await expect(page.locator('[data-entry]').first()).toBeVisible();
	const before = await waiting(page);

	// As it is.
	const first = page.locator('[data-entry]').first();
	const firstName = await first.getByLabel('Name').inputValue();
	await chooseImportCategory(first);
	await first.getByRole('button', { name: /^(Approve$|Add link to )/ }).first().click();
	await expect.poll(() => waiting(page)).toBe(before - 1);

	// With a new name and category, typed into the entry itself.
	const second = page.locator('[data-entry]').first();
	const renamed = unique('Renamed').replace(/\s+/g, '');
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

test('admins can merge links, pin the leader and restore a merged page from trash', async ({ page }) => {
 await loginAs(page, 'admin');
 const one=unique('Shared'), two=unique('Fork');
 await postAddon(page,two); const address=await postAddon(page,one);
 const picker=page.getByPlaceholder('Merge another addon’s links here…');
 await picker.fill(two); await page.getByRole('option',{name:new RegExp('^'+two)}).click();
 const links=page.locator('aside ol li'); await expect(links).toHaveCount(2);
 await links.nth(1).getByRole('button',{name:'Pin',exact:true}).click();
 await expect(links.first()).toContainText('Pinned');
 await links.first().getByRole('button',{name:'Unpin',exact:true}).click();
 await expect(page.getByText('Pinned',{exact:true})).toHaveCount(0);
 await page.goto('/admin/trash');
 const trashed=page.locator('.panel > div').filter({hasText:two});
 await trashed.getByRole('button',{name:'Restore',exact:true}).click();
 await expect(page.getByText('Restored "'+two+'".')).toBeVisible();
 await page.goto(address); await expect(page.getByRole('heading',{level:1,name:one})).toBeVisible();
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

test('everything a member did is rolled back from their profile, after a look at what would change', async ({ page }) => {
	// The damage, as the member: a spam post and a defaced addon of their own.
	await loginAs(page, 'member');
	const spam = unique('Spam');
	const spamAddress = await postAddon(page, spam);
	await page.goto('/submit?edit=member-map');
	await page.getByLabel('Description', { exact: true }).fill('Defaced by a browser test, long enough to save.');
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page.getByText('Defaced by a browser test, long enough to save.')).toBeVisible();
	await page.goto('/account');
	await page.getByRole('button', { name: 'Log out' }).click();
	await expect(page.getByRole('navigation').getByRole('link', { name: 'Log in' })).toBeVisible();

	await loginAs(page, 'admin');
	await page.goto('/admin/users/profile?name=member');
	await page.getByLabel('Undo everything this account did in').selectOption('1');
	await page.getByRole('button', { name: 'Show what would change' }).click();
	const plan = page.locator('.panel', { hasText: 'Rolling back member, the last hour' });
	await expect(plan.getByText('Nothing has changed yet.')).toBeVisible();
	await expect(plan.getByText(`Move to the trash: ${spam}`)).toBeVisible();
	await expect(plan.getByText('Put back as it was: Member Map')).toBeVisible();

	// Looking changed nothing.
	await page.goto(spamAddress);
	await expect(page.getByRole('heading', { level: 1, name: spam })).toBeVisible();

	await page.goto('/admin/users/profile?name=member');
	await page.getByLabel('Undo everything this account did in').selectOption('1');
	await page.getByRole('button', { name: 'Show what would change' }).click();
	await page.getByRole('button', { name: /^Roll back \d+ changes?$/ }).click();
	await confirm(page, 'Roll back');
	await expect(page.getByText(/Rolled back \d+ changes? by member\./)).toBeVisible();

	await page.goto(spamAddress);
	await expect(page.getByRole('heading', { name: 'Addon not found' })).toBeVisible();
	await page.goto('/addon/member-map');
	await expect(page.getByText('Posted by the test member. Coordinates and notes on the world map.')).toBeVisible();
	await page.goto('/admin/log');
	await expect(logLine(page, /rolled back everything done by\s+member/)).toBeVisible();

	// An admin is not offered a rollback of another admin.
	await page.goto('/admin/users/profile?name=admin2');
	await expect(page.getByRole('heading', { level: 1, name: 'admin2' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Show what would change' })).toHaveCount(0);
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

test('the owner makes a member an admin and takes the role away again; an admin cannot', async ({ page }) => {
	await loginAs(page, 'admin');
	await page.goto('/admin/users/profile?name=member2');
	await expect(page.getByRole('heading', { level: 1, name: 'member2' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Make admin' })).toHaveCount(0);
	await page.goto('/account');
	await page.getByRole('button', { name: 'Log out' }).click();
	await expect(page.getByRole('navigation').getByRole('link', { name: 'Log in' })).toBeVisible();

	await loginAs(page, 'owner');
	await page.goto('/admin/users/profile?name=member2');
	await page.getByRole('button', { name: 'Make admin' }).click();
	await confirm(page, 'Make admin');
	await expect(page.getByText('member2 is an admin.')).toBeVisible();
	await expect(page.getByRole('complementary').getByText('Admin', { exact: true })).toBeVisible();
	await page.goto('/admin/log?kind=user');
	await expect(logLine(page, /owner made an admin of member2/)).toBeVisible();

	// From the list of accounts as well, where it is taken away again.
	await page.goto('/admin/users');
	const row = page.locator('div.border-b', { hasText: 'member2' });
	await row.getByRole('button', { name: 'Remove admin' }).click();
	await confirm(page, 'Remove admin');
	await expect(page.getByText('member2 is no longer an admin.')).toBeVisible();
	await expect(row.getByRole('button', { name: 'Make admin' })).toBeVisible();
});
